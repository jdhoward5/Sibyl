import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, Conversation, GenerationEvent, InstalledModel } from '@shared/types'

const fakes = vi.hoisted(() => {
  const settings = {
    gpu: 'cpu',
    load: { gpuLayers: -1, contextSize: 2048, systemPrompt: 'test' },
    generation: {
      temperature: 0.8,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      maxTokens: 256,
      repeatPenalty: 1.1
    },
    context: {
      autoCompact: true,
      compactThreshold: 0.85,
      warnThreshold: 0.7,
      keepRecentMessages: 12,
      keepRecentFraction: 0.35,
      summaryTokenFraction: 0.1
    },
    personas: [] as AppSettings['personas']
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

import { InferenceEngine, parseRoleplayMaintenance } from './engine'

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
    tokenize: vi.fn((text: string) =>
      Array.from({ length: Math.max(1, Math.ceil(text.length / 4)) }, (_, i) => i)
    )
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

describe('roleplay maintenance validation', () => {
  it('accepts only supported public facts with real provenance', () => {
    const result = parseRoleplayMaintenance(
      JSON.stringify({
        recap: 'Ada remains at the gate.',
        facts: [
          {
            category: 'location',
            text: 'Ada is at the gate.',
            sourceMessageIds: ['message-a']
          }
        ]
      }),
      new Set(['message-a']),
      '2026-01-01T00:00:00.000Z'
    )
    expect(result.recap).toBe('Ada remains at the gate.')
    expect(result.facts[0]).toMatchObject({
      category: 'location',
      visibility: { kind: 'public' },
      provenanceMessageIds: ['message-a'],
      pinned: false
    })
  })

  it('rejects invented provenance and unknown fields', () => {
    expect(() =>
      parseRoleplayMaintenance(
        JSON.stringify({
          recap: 'Bad.',
          facts: [
            {
              category: 'plot',
              text: 'Invented.',
              sourceMessageIds: ['missing'],
              secret: true
            }
          ]
        }),
        new Set(['message-a']),
        '2026-01-01T00:00:00.000Z'
      )
    ).toThrow(/invalid fact/)
  })
})

describe('InferenceEngine lifecycle', () => {
  it('runs a validated local director decision before releasing the engine', async () => {
    fakes.installed.set('model-a', model('model-a'))
    fakes.llama.loadModel.mockResolvedValueOnce(nativeModel().value)
    fakes.settings.personas = [
      {
        id: 'director-a',
        name: 'Ada',
        role: 'Scout',
        brief: 'Ada',
        avatar: { monogram: 'A', gradient: ['#000', '#111'] },
        voiceTags: []
      },
      {
        id: 'director-b',
        name: 'Bo',
        role: 'Guide',
        brief: 'Bo',
        avatar: { monogram: 'B', gradient: ['#222', '#333'] },
        voiceTags: []
      }
    ]
    const scene: Conversation = {
      ...conversation,
      id: 'director-scene',
      cast: ['director-a', 'director-b'],
      director: {
        enabled: true,
        useModel: true,
        pacing: 'balanced',
        initiative: 'balanced',
        interruption: 'natural-pauses',
        inspectIntent: false
      },
      messages: []
    }
    const engine = new InferenceEngine()
    await engine.load('model-a')
    const session = fakes.sessions.at(-1)!
    session.prompt.mockResolvedValueOnce(
      '{"action":"continue","speakerId":"director-b","intent":"Bo should answer."}'
    )

    await expect(engine.directScene(scene)).resolves.toMatchObject({
      action: 'continue',
      speakerId: 'director-b',
      usedModel: true
    })
    expect((await engine.status()).operation).toBeUndefined()
  })

  it('accounts for an attempted director pass when output is invalid', async () => {
    fakes.installed.set('model-a', model('model-a'))
    fakes.llama.loadModel.mockResolvedValueOnce(nativeModel().value)
    fakes.settings.personas = [
      {
        id: 'director-a',
        name: 'Ada',
        role: 'Scout',
        brief: 'Ada',
        avatar: { monogram: 'A', gradient: ['#000', '#111'] },
        voiceTags: []
      },
      {
        id: 'director-b',
        name: 'Bo',
        role: 'Guide',
        brief: 'Bo',
        avatar: { monogram: 'B', gradient: ['#222', '#333'] },
        voiceTags: []
      }
    ]
    const scene: Conversation = {
      ...conversation,
      id: 'director-scene',
      cast: ['director-a', 'director-b'],
      director: {
        enabled: true,
        useModel: true,
        pacing: 'balanced',
        initiative: 'balanced',
        interruption: 'natural-pauses',
        inspectIntent: false
      },
      messages: []
    }
    const engine = new InferenceEngine()
    await engine.load('model-a')
    fakes.sessions.at(-1)!.prompt.mockResolvedValueOnce('not json')

    await expect(engine.directScene(scene)).resolves.toMatchObject({
      action: 'continue',
      speakerId: 'director-a',
      usedModel: true,
      fallbackReason: 'invalid-output'
    })
  })

  it('aborts only the active director pass for the matching conversation', async () => {
    fakes.installed.set('model-a', model('model-a'))
    fakes.llama.loadModel.mockResolvedValueOnce(nativeModel().value)
    fakes.settings.personas = [
      {
        id: 'director-a',
        name: 'Ada',
        role: 'Scout',
        brief: 'Ada',
        avatar: { monogram: 'A', gradient: ['#000', '#111'] },
        voiceTags: []
      },
      {
        id: 'director-b',
        name: 'Bo',
        role: 'Guide',
        brief: 'Bo',
        avatar: { monogram: 'B', gradient: ['#222', '#333'] },
        voiceTags: []
      }
    ]
    const scene: Conversation = {
      ...conversation,
      id: 'director-scene',
      cast: ['director-a', 'director-b'],
      director: {
        enabled: true,
        useModel: true,
        pacing: 'balanced',
        initiative: 'balanced',
        interruption: 'natural-pauses',
        inspectIntent: false
      },
      messages: []
    }
    const engine = new InferenceEngine()
    await engine.load('model-a')
    fakes.sessions.at(-1)!.prompt.mockImplementationOnce(
      (_prompt: string, options?: { signal?: AbortSignal }) =>
        new Promise<string>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve(''), { once: true })
        })
    )

    const decision = engine.directScene(scene)
    await vi.waitFor(() => {
      expect(engine.abortSceneDirector('other-scene')).toBe(false)
      expect(engine.abortSceneDirector(scene.id)).toBe(true)
    })
    await expect(decision).resolves.toMatchObject({
      usedModel: true,
      fallbackReason: 'timeout'
    })
  })

  it('bounds the private director prompt before local inference', async () => {
    fakes.installed.set('model-a', model('model-a'))
    const native = nativeModel()
    fakes.llama.loadModel.mockResolvedValueOnce(native.value)
    fakes.settings.personas = [
      {
        id: 'director-a',
        name: 'Ada',
        role: 'Scout',
        brief: 'Ada',
        avatar: { monogram: 'A', gradient: ['#000', '#111'] },
        voiceTags: []
      },
      {
        id: 'director-b',
        name: 'Bo',
        role: 'Guide',
        brief: 'Bo',
        avatar: { monogram: 'B', gradient: ['#222', '#333'] },
        voiceTags: []
      }
    ]
    const scene: Conversation = {
      ...conversation,
      id: 'director-scene',
      cast: ['director-a', 'director-b'],
      director: {
        enabled: true,
        useModel: true,
        sceneGoal: 'Keep the test bounded.',
        pacing: 'balanced',
        initiative: 'balanced',
        interruption: 'natural-pauses',
        inspectIntent: false
      },
      messages: [{
        id: 'large-message',
        role: 'assistant',
        speakerId: 'director-a',
        speakerName: 'Ada',
        content: `old-${'x'.repeat(20_000)}-newest`,
        createdAt: ''
      }]
    }
    const engine = new InferenceEngine()
    await engine.load('model-a')
    fakes.sessions.at(-1)!.prompt.mockResolvedValueOnce(
      '{"action":"continue","speakerId":"director-b","intent":"Continue."}'
    )

    const result = await engine.directScene(scene)
    expect(result.promptTokens).toBeLessThanOrEqual(896)
    expect(fakes.sessions.at(-1)!.prompt.mock.calls[0][0]).toContain('newest')
  })

  beforeEach(() => {
    fakes.installed.clear()
    fakes.installed.set('model-a', model('model-a'))
    fakes.installed.set('model-b', model('model-b'))
    fakes.sessions.length = 0
    fakes.llama.loadModel.mockReset()
    fakes.settings.load.contextSize = 2048
    fakes.settings.load.systemPrompt = 'test'
    fakes.settings.generation.maxTokens = 256
    fakes.settings.context.keepRecentMessages = 12
    fakes.settings.context.keepRecentFraction = 0.35
    fakes.settings.personas = []
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

  it('rebuilds a warm session when effective prompt inputs change', async () => {
    const first = nativeModel()
    fakes.llama.loadModel.mockResolvedValueOnce(first.value)
    const engine = new InferenceEngine()
    await engine.load('model-a')
    const session = fakes.sessions.at(-1)!

    await engine.generate(conversation, 'hello', 'assistant-1', undefined)
    expect(session.setChatHistory).toHaveBeenCalledTimes(1)

    const next: Conversation = {
      ...conversation,
      messages: [
        ...conversation.messages.slice(0, -1),
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'first answer',
          createdAt: '2026-01-01T00:00:01.000Z'
        },
        {
          id: 'user-2',
          role: 'user',
          content: 'again',
          createdAt: '2026-01-01T00:00:02.000Z'
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: '',
          createdAt: '2026-01-01T00:00:03.000Z'
        }
      ]
    }
    fakes.settings.load.systemPrompt = 'edited prompt'
    await engine.generate(next, 'again', 'assistant-2', undefined)
    expect(session.setChatHistory).toHaveBeenCalledTimes(2)

    const third: Conversation = {
      ...next,
      messages: [
        ...next.messages.slice(0, -1),
        {
          id: 'assistant-2',
          role: 'assistant',
          content: 'second answer',
          createdAt: '2026-01-01T00:00:03.000Z'
        },
        {
          id: 'user-3',
          role: 'user',
          content: 'once more',
          createdAt: '2026-01-01T00:00:04.000Z'
        },
        {
          id: 'assistant-3',
          role: 'assistant',
          content: '',
          createdAt: '2026-01-01T00:00:05.000Z'
        }
      ]
    }
    await engine.generate(third, 'once more', 'assistant-3', undefined)
    expect(session.setChatHistory).toHaveBeenCalledTimes(2)
  })

  it('includes prospective user input in context accounting', async () => {
    const first = nativeModel()
    fakes.llama.loadModel.mockResolvedValueOnce(first.value)
    const engine = new InferenceEngine()
    await engine.load('model-a')

    const current = await engine.computeUsage(conversation)
    const projected = await engine.computeProjectedUsage(conversation, {
      conversationId: conversation.id,
      prospectiveInput: { content: 'x'.repeat(1_200) }
    })

    expect(projected.conversationId).toBe(conversation.id)
    expect(projected.usedTokens).toBeGreaterThan(current.usedTokens + 250)
    expect(projected.responseReserveTokens).toBe(256)
    expect(projected.exact).toBe(false)
  })

  it('uses the selected scene speaker reserve and otherwise reserves the largest cast reply', async () => {
    const first = nativeModel()
    fakes.llama.loadModel.mockResolvedValueOnce(first.value)
    fakes.settings.personas = [
      {
        id: 'persona-1',
        name: 'One',
        role: 'Scout',
        brief: 'Be concise.',
        avatar: { monogram: 'O', gradient: ['#000000', '#111111'] },
        voiceTags: [],
        generation: { ...fakes.settings.generation, maxTokens: 128 }
      },
      {
        id: 'persona-2',
        name: 'Two',
        role: 'Scholar',
        brief: 'Be expansive.',
        avatar: { monogram: 'T', gradient: ['#222222', '#333333'] },
        voiceTags: [],
        generation: { ...fakes.settings.generation, maxTokens: 768 }
      }
    ]
    const scene: Conversation = {
      ...conversation,
      id: 'scene-1',
      cast: ['persona-1', 'persona-2'],
      messages: []
    }
    const engine = new InferenceEngine()
    await engine.load('model-a')

    const selected = await engine.computeProjectedUsage(scene, {
      conversationId: scene.id,
      nextSpeakerId: 'persona-1'
    })
    const conservative = await engine.computeUsage(scene)

    expect(selected.responseReserveTokens).toBe(128)
    expect(conservative.responseReserveTokens).toBe(768)
    await expect(
      engine.computeProjectedUsage(scene, {
        conversationId: scene.id,
        nextSpeakerId: 'not-in-cast'
      })
    ).rejects.toThrow(/not in this scene/)
  })

  it('applies scene-wide instruction and generation overrides to the next beat', async () => {
    const first = nativeModel()
    fakes.llama.loadModel.mockResolvedValueOnce(first.value)
    fakes.settings.personas = [
      {
        id: 'persona-1',
        name: 'One',
        role: 'Scout',
        brief: 'Watch the road.',
        avatar: { monogram: 'O', gradient: ['#000000', '#111111'] },
        voiceTags: []
      },
      {
        id: 'persona-2',
        name: 'Two',
        role: 'Scholar',
        brief: 'Study every clue.',
        avatar: { monogram: 'T', gradient: ['#222222', '#333333'] },
        voiceTags: []
      }
    ]
    const scene: Conversation = {
      ...conversation,
      id: 'scene-instruction',
      cast: ['persona-1', 'persona-2'],
      messages: [],
      overrides: {
        systemPrompt: 'Keep the entire scene tense.',
        generation: {
          ...fakes.settings.generation,
          temperature: 0.17,
          maxTokens: 77
        }
      }
    }
    const engine = new InferenceEngine()
    await engine.load('model-a')
    const session = fakes.sessions.at(-1)!

    await engine.generateBeat(scene, 'persona-1', 'beat-1', undefined)

    const history = session.setChatHistory.mock.calls.at(-1)?.[0] as Array<{
      type: string
      text?: string
    }>
    expect(history[0].text).toContain('Keep the entire scene tense.')
    expect(session.prompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ temperature: 0.17, maxTokens: 77 })
    )
  })

  it('keeps private thoughts and director guidance out of the public scene recap', async () => {
    const first = nativeModel()
    fakes.llama.loadModel.mockResolvedValueOnce(first.value)
    fakes.settings.context.keepRecentMessages = 1
    const scene: Conversation = {
      ...conversation,
      id: 'scene-private-compaction',
      cast: ['persona-1', 'persona-2'],
      messages: [
        {
          id: 'director-note',
          role: 'user',
          content: 'Secretly make Ada betray Bo.',
          createdAt: '',
          director: true
        },
        {
          id: 'private-thought',
          role: 'assistant',
          content: 'Ada hides the map.',
          createdAt: '',
          speakerId: 'persona-1',
          speakerName: 'Ada',
          segments: [
            {
              id: 'thought-segment',
              kind: 'thought',
              content: 'Ada hides the map.',
              visibility: { kind: 'private', characterIds: ['persona-1'] }
            }
          ]
        },
        {
          id: 'public-beat',
          role: 'assistant',
          content: 'The bridge alarm sounds.',
          createdAt: '',
          speakerId: 'persona-2',
          speakerName: 'Bo'
        },
        {
          id: 'recent-beat',
          role: 'assistant',
          content: 'Ada reaches the console.',
          createdAt: '',
          speakerId: 'persona-1',
          speakerName: 'Ada'
        }
      ]
    }
    const engine = new InferenceEngine()
    await engine.load('model-a')
    const session = fakes.sessions.at(-1)!
    session.prompt.mockResolvedValueOnce(
      JSON.stringify({
        recap: 'The bridge alarm sounds.',
        facts: [
          {
            category: 'condition',
            text: 'The bridge alarm is sounding.',
            sourceMessageIds: ['public-beat']
          }
        ]
      })
    )

    await engine.compact(scene)

    const instruction = session.prompt.mock.calls.at(-1)?.[0] as string
    expect(instruction).toContain('The bridge alarm sounds.')
    expect(instruction).not.toContain('Secretly make Ada betray Bo.')
    expect(instruction).not.toContain('Ada hides the map.')
  })
})
