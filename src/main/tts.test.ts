import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InstalledVoice, TtsEvent, TtsVoice } from '@shared/tts'

const fakes = vi.hoisted(() => ({
  voice: null as InstalledVoice | null,
  catalog: null as TtsVoice | null,
  create: vi.fn(),
  run: vi.fn(),
  release: vi.fn(),
  phonemize: vi.fn(),
  removed: vi.fn()
}))

vi.mock('./store', () => ({
  getSettings: vi.fn(async () => ({ tts: { voiceId: 'test-voice', rate: 1 } })),
  getInstalledVoice: vi.fn(async () => fakes.voice),
  removeInstalledVoice: fakes.removed,
  getVoicesDir: vi.fn(),
  upsertInstalledVoice: vi.fn()
}))
vi.mock('@shared/tts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/tts')>()),
  findCatalogVoice: () => fakes.catalog
}))
vi.mock('onnxruntime-node', () => {
  const runtime = {
    env: {},
    InferenceSession: { create: fakes.create },
    Tensor: class {
      constructor(
        readonly type: string,
        readonly data: unknown,
        readonly dims: number[]
      ) {}
    }
  }
  return { ...runtime, default: runtime }
})
vi.mock('phonemizer', () => ({ phonemize: fakes.phonemize }))

import { TtsEngine } from './tts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const pcmResult = (): { output: { data: Float32Array } } => ({
  output: { data: Float32Array.from([0, 0.1, 0]) }
})
const session = { run: fakes.run, release: fakes.release, outputNames: ['output'] }
let engine: TtsEngine
let events: TtsEvent[]
let tempDir: string

beforeEach(async () => {
  vi.clearAllMocks()
  fakes.create.mockReset().mockResolvedValue(session)
  fakes.run.mockReset().mockImplementation(async () => pcmResult())
  fakes.release.mockReset().mockResolvedValue(undefined)
  fakes.phonemize.mockReset().mockResolvedValue(['a'])
  fakes.removed.mockReset().mockImplementation(async () => {
    const removed = fakes.voice
    fakes.voice = null
    return removed
  })
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sibyl-tts-test-'))
  const model = Buffer.from('synthetic voice fixture')
  const config = Buffer.from(JSON.stringify({
    audio: { sample_rate: 22050 },
    inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
    phoneme_id_map: { '^': [1], '_': [0], '$': [2], a: [3] },
    num_speakers: 1
  }))
  const modelPath = path.join(tempDir, 'voice.onnx')
  const configPath = path.join(tempDir, 'voice.onnx.json')
  await Promise.all([fs.writeFile(modelPath, model), fs.writeFile(configPath, config)])
  fakes.voice = {
    id: 'test-voice', name: 'Test', language: 'en_US', quality: 'medium',
    modelPath, configPath, sizeBytes: model.length, installedAt: '2026-01-01T00:00:00Z'
  }
  fakes.catalog = {
    ...fakes.voice,
    configSizeBytes: config.length,
    modelSha256: createHash('sha256').update(model).digest('hex'),
    configSha256: createHash('sha256').update(config).digest('hex')
  } as TtsVoice
  engine = new TtsEngine()
  events = []
  engine.on('event', (event: TtsEvent) => events.push(event))
})

afterEach(async () => {
  await engine.dispose()
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('speech cancellation and serialization', () => {
  it('cancels a request stopped before its queued task begins', async () => {
    const speech = engine.speak('queued', 'A synthetic sentence.')
    engine.stop()
    await speech

    expect(events).toEqual([])
    expect(fakes.create).not.toHaveBeenCalled()
    expect(fakes.phonemize).not.toHaveBeenCalled()
    expect(await engine.status()).toMatchObject({ speakingMessageId: null, synthesizing: false })
  })

  it('stops pending replacements while an active native call unwinds', async () => {
    const synthesis = deferred<ReturnType<typeof pcmResult>>()
    fakes.run.mockReturnValueOnce(synthesis.promise)
    const first = engine.speak('active', 'A synthetic sentence.')
    await vi.waitFor(() => expect(fakes.run).toHaveBeenCalledOnce())
    const second = engine.speak('queued-one', 'Another synthetic sentence.')
    const third = engine.speak('queued-two', 'A final synthetic sentence.')
    engine.stop()
    synthesis.resolve(pcmResult())
    await Promise.all([first, second, third])

    expect(events.filter((event) => event.type === 'start').map((event) => event.messageId))
      .toEqual(['active'])
    expect(events.some((event) => event.type === 'chunk')).toBe(false)
    expect(fakes.run).toHaveBeenCalledOnce()
    expect(fakes.phonemize).toHaveBeenCalledOnce()
    expect(await engine.status()).toMatchObject({ speakingMessageId: null, synthesizing: false })
  })

  it('runs only the latest replacement, after the previous native call finishes', async () => {
    const synthesis = deferred<ReturnType<typeof pcmResult>>()
    fakes.run.mockReturnValueOnce(synthesis.promise)
    const first = engine.speak('active', 'A synthetic sentence.')
    await vi.waitFor(() => expect(fakes.run).toHaveBeenCalledOnce())
    const obsolete = engine.speak('obsolete', 'Another synthetic sentence.')
    const latest = engine.speak('latest', 'The requested synthetic sentence.')
    try {
      await Promise.resolve()
      expect(fakes.run).toHaveBeenCalledOnce()
    } finally {
      synthesis.resolve(pcmResult())
    }
    await Promise.all([first, obsolete, latest])

    expect(events.filter((event) => event.type === 'start').map((event) => event.messageId))
      .toEqual(['active', 'latest'])
    expect(events.filter((event) => event.type === 'chunk').map((event) => event.messageId))
      .toEqual(['latest'])
    expect(fakes.run).toHaveBeenCalledTimes(2)
    expect(fakes.create).toHaveBeenCalledOnce()
  })

  it('does not start playback or phonemization after cancellation during voice loading', async () => {
    const loading = deferred<typeof session>()
    fakes.create.mockReturnValueOnce(loading.promise)
    const speech = engine.speak('loading', 'A synthetic sentence.')
    await vi.waitFor(() => expect(fakes.create).toHaveBeenCalledOnce())
    engine.stop()
    loading.resolve(session)
    await speech

    expect(events.map((event) => event.type)).toEqual(['done'])
    expect(fakes.phonemize).not.toHaveBeenCalled()
    expect(fakes.run).not.toHaveBeenCalled()
  })

  it('drains active work before disposal and ignores speech until release finishes', async () => {
    const synthesis = deferred<ReturnType<typeof pcmResult>>()
    const releasing = deferred<void>()
    fakes.run.mockReturnValueOnce(synthesis.promise)
    fakes.release.mockReturnValueOnce(releasing.promise)
    const speech = engine.speak('active', 'A synthetic sentence.')
    await vi.waitFor(() => expect(fakes.run).toHaveBeenCalledOnce())
    const queued = engine.speak('queued', 'Another synthetic sentence.')
    const disposal = engine.dispose()
    try {
      expect(fakes.release).not.toHaveBeenCalled()
      synthesis.resolve(pcmResult())
      await vi.waitFor(() => expect(fakes.release).toHaveBeenCalledOnce())
      await engine.speak('during-disposal', 'A synthetic sentence.')
      expect(fakes.create).toHaveBeenCalledOnce()
    } finally {
      synthesis.resolve(pcmResult())
      releasing.resolve()
    }
    await Promise.all([speech, queued, disposal])
    await engine.speak('after-disposal', 'A fresh synthetic sentence.')

    expect(events.filter((event) => event.type === 'start').map((event) => event.messageId))
      .toEqual(['active', 'after-disposal'])
    expect(fakes.create).toHaveBeenCalledTimes(2)
    expect(fakes.run).toHaveBeenCalledTimes(2)
  })

  it('serializes voice deletion with a speech request submitted during session release', async () => {
    await engine.speak('first', 'A synthetic sentence.')
    const releasing = deferred<void>()
    fakes.release.mockReturnValueOnce(releasing.promise)
    const deletion = engine.deleteVoice('test-voice')
    await vi.waitFor(() => expect(fakes.release).toHaveBeenCalledOnce())
    const speech = engine.speak('after-delete', 'Another synthetic sentence.')
    try {
      await Promise.resolve()
      expect(fakes.run).toHaveBeenCalledOnce()
    } finally {
      releasing.resolve()
    }
    await Promise.all([deletion, speech])

    expect(fakes.run).toHaveBeenCalledOnce()
    expect(fakes.removed).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ type: 'error', messageId: 'after-delete' })
  })
})
