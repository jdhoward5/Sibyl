import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, Conversation, GenerationEvent, InstalledModel } from '@shared/types'

const fakes = vi.hoisted(() => {
  const settings = {
    gpu: 'cpu',
    load: { gpuLayers: -1, contextSize: 2048, systemPrompt: 'test' }
  }
  const installed = new Map<string, InstalledModel>()
  const sessions: Array<{
    prompt: ReturnType<typeof vi.fn>
    setChatHistory: ReturnType<typeof vi.fn>
  }> = []
  const llama = { loadModel: vi.fn(), getVramState: vi.fn(async () => ({ total: 1, used: 0 })), gpu: false }
  return { settings, installed, sessions, llama }
})

vi.mock('./store', () => ({
  getSettings: vi.fn(async () => fakes.settings as unknown as AppSettings),
  getInstalledModel: vi.fn(async (id: string) => fakes.installed.get(id) ?? null),
  upsertInstalledModel: vi.fn(async () => undefined)
}))

vi.mock('./llama', () => ({
  getLlamaInstance: vi.fn(async () => fakes.llama)
}))

vi.mock('node-llama-cpp', () => ({
  LlamaChatSession: class {
    prompt = vi.fn(async () => 'ok')
    setChatHistory = vi.fn()
    constructor() {
      fakes.sessions.push(this)
    }
  }
}))

import { InferenceEngine } from './engine'

function model(id: string): InstalledModel {
  return {
    id,
    repoId: 'test/repo',
    filename: `${id}.gguf`,
    path: `C:/models/${id}.gguf`,
    sizeBytes: 1,
    installedAt: '2026-01-01T00:00:00.000Z',
    availability: 'available'
  }
}

function nativeModel() {
  const sequence = { nextTokenIndex: 0, dispose: vi.fn() }
  const context = {
    getSequence: vi.fn(() => sequence),
    dispose: vi.fn(async () => undefined)
  }
  const value = {
    trainContextSize: 4096,
    createContext: vi.fn(async () => context),
    dispose: vi.fn(async () => undefined),
    tokenize: vi.fn(() => [1])
  }
  return { value, context, sequence }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const conversation: Conversation = {
  id: 'conv-1',
  title: 'Test',
  modelId: 'model-a',
  messages: [
    { id: 'user-1', role: 'user', content: 'hello', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'assistant-1', role: 'assistant', content: '', createdAt: '2026-01-01T00:00:01.000Z' }
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z'
}

describe('InferenceEngine lifecycle', () => {
  beforeEach(() => {
    fakes.installed.clear()
    fakes.installed.set('model-a', model('model-a'))
    fakes.installed.set('model-b', model('model-b'))
    fakes.sessions.length = 0
    fakes.llama.loadModel.mockReset()
    fakes.settings.load.contextSize = 2048
  })

  it('lets the newest concurrent load win and disposes the stale resources', async () => {
    const first = nativeModel()
    const second = nativeModel()
    const gate = deferred<typeof first.value>()
    const started = deferred<void>()
    fakes.llama.loadModel.mockImplementationOnce(async () => {
      started.resolve()
      return gate.promise
    })
    fakes.llama.loadModel.mockResolvedValueOnce(second.value)
    const engine = new InferenceEngine()

    const loadA = engine.load('model-a')
    await started.promise
    const loadB = engine.load('model-b')
    gate.resolve(first.value)

    await expect(loadA).rejects.toThrow('superseded')
    await expect(loadB).resolves.toMatchObject({ state: 'ready', modelId: 'model-b' })
    expect(first.value.dispose).toHaveBeenCalledOnce()
    expect((await engine.status()).operation).toBeUndefined()
  })

  it('serializes load/unload and prevents a stale load from publishing', async () => {
    const first = nativeModel()
    const gate = deferred<typeof first.value>()
    const started = deferred<void>()
    fakes.llama.loadModel.mockImplementationOnce(async () => {
      started.resolve()
      return gate.promise
    })
    const engine = new InferenceEngine()
    const loading = engine.load('model-a')
    await started.promise
    const unloading = engine.unload()
    gate.resolve(first.value)

    await expect(loading).rejects.toThrow('superseded')
    await unloading
    await expect(engine.status()).resolves.toMatchObject({ state: 'idle', modelId: null })
  })

  it('aborts and unwinds generation before a new load disposes resources', async () => {
    const first = nativeModel()
    const second = nativeModel()
    fakes.llama.loadModel.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value)
    const engine = new InferenceEngine()
    await engine.load('model-a')
    const session = fakes.sessions.at(-1)!
    session.prompt.mockImplementation(
      (_text: string, options: { signal: AbortSignal }) =>
        new Promise<string>((resolve) => {
          options.signal.addEventListener('abort', () => resolve('partial'), { once: true })
        })
    )
    const events: GenerationEvent[] = []
    engine.on('event', (event) => events.push(event as GenerationEvent))

    const generation = engine.generate(conversation, 'hello', 'assistant-1', undefined)
    await vi.waitFor(async () => {
      expect((await engine.status()).state).toBe('generating')
    })
    const loading = engine.load('model-b')
    await generation
    await loading

    expect(events.some((event) => event.type === 'aborted')).toBe(true)
    expect(first.value.dispose).toHaveBeenCalledOnce()
    await expect(engine.status()).resolves.toMatchObject({ state: 'ready', modelId: 'model-b' })
  })

  it('rejects load after shutdown', async () => {
    const engine = new InferenceEngine()
    await engine.shutdown()
    await expect(engine.load('model-a')).rejects.toThrow('shutting down')
  })

  it('only aborts the operation matching its conversation and message', async () => {
    const first = nativeModel()
    fakes.llama.loadModel.mockResolvedValueOnce(first.value)
    const engine = new InferenceEngine()
    await engine.load('model-a')
    const session = fakes.sessions.at(-1)!
    session.prompt.mockImplementation(
      (_text: string, options: { signal: AbortSignal }) =>
        new Promise<string>((resolve) => {
          options.signal.addEventListener('abort', () => resolve('partial'), { once: true })
        })
    )
    const generation = engine.generate(conversation, 'hello', 'assistant-1', undefined)
    await vi.waitFor(async () => {
      expect((await engine.status()).state).toBe('generating')
    })
    expect(
      engine.abortGeneration({ conversationId: 'other-conv', messageId: 'assistant-1' })
    ).toBe(false)
    expect((await engine.status()).state).toBe('generating')
    expect(
      engine.abortGeneration({ conversationId: 'conv-1', messageId: 'assistant-1' })
    ).toBe(true)
    await generation
    expect((await engine.status()).operation).toBeUndefined()
  })

  it('reloads the same model when its load configuration changes', async () => {
    const first = nativeModel()
    const second = nativeModel()
    fakes.llama.loadModel.mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value)
    const engine = new InferenceEngine()
    await engine.load('model-a')
    fakes.settings.load.contextSize = 4096
    await engine.load('model-a')
    expect(fakes.llama.loadModel).toHaveBeenCalledTimes(2)
    expect(first.value.dispose).toHaveBeenCalledOnce()
  })
})
