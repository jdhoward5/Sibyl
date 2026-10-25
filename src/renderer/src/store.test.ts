import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ACCESSIBILITY_SETTINGS,
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_GENERATION_OPTIONS,
  type Conversation,
  type HFModelDetail,
  type HFModelSummary,
  type Persona,
  type RendererSettings,
  type RendererSettingsPatch,
  type Result
} from '@shared/types'
import { DEFAULT_TTS_SETTINGS, type InstalledVoice } from '@shared/tts'
import { activeDirectionsForSpeaker, snapshotPersona } from '@shared/roleplay'
import { buildBeatPrompt } from '@shared/scene'
import { createSceneRun, setSceneNarration } from '@shared/sceneRun'
import { parseConversation } from '@shared/validation'

vi.mock('./lib/ttsPlayer', () => ({
  ttsPlayer: {
    ensureContext: vi.fn(),
    prepareForSpeech: vi.fn(),
    setVolume: vi.fn()
  }
}))

const stamp = '2026-10-24T12:00:00.000Z'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function persona(id = 'character-a'): Persona {
  return {
    id,
    name: id,
    role: 'Guide',
    brief: 'A synthetic character used by this test.',
    avatar: { monogram: 'A', gradient: ['#ffffff', '#000000'] },
    voiceTags: [],
    version: 1
  }
}

function settings(): RendererSettings {
  return {
    modelsDir: '/unused-test-models',
    hfTokenConfigured: false,
    generation: { ...DEFAULT_GENERATION_OPTIONS },
    load: { gpuLayers: -1, contextSize: 4096, systemPrompt: '' },
    context: { ...DEFAULT_CONTEXT_SETTINGS },
    theme: 'dark',
    accent: 'rose',
    gpu: 'auto',
    verifyDownloads: true,
    personas: [persona()],
    promptPresets: [],
    generationProfiles: [],
    tts: { ...DEFAULT_TTS_SETTINGS },
    accessibility: { ...DEFAULT_ACCESSIBILITY_SETTINGS },
    backupRetention: 3,
    telemetry: false
  }
}

function conversation(): Conversation {
  return {
    id: 'conversation-a',
    title: 'Synthetic conversation',
    modelId: null,
    messages: [],
    personaId: 'character-a',
    personaSnapshot: snapshotPersona(persona(), stamp),
    createdAt: stamp,
    updatedAt: stamp
  }
}

function model(id: string): HFModelSummary {
  return { id, author: 'synthetic', likes: 0, downloads: 0, tags: [], lastModified: stamp, gated: false }
}

function detail(id: string): HFModelDetail {
  return { ...model(id), ggufFiles: [] }
}

function voice(id: string): InstalledVoice {
  return {
    id, name: id, language: 'en', quality: 'medium',
    modelPath: '/unused-test-voice', configPath: '/unused-test-config',
    sizeBytes: 1, installedAt: stamp
  }
}

let actions: typeof import('./store')['actions']
let getState: typeof import('./store')['getState']

const bridge = {
  settings: { set: vi.fn<(patch: RendererSettingsPatch) => Promise<Result<RendererSettings>>>() },
  conversations: { save: vi.fn<(value: Conversation) => Promise<Result<void>>>() },
  chat: { invalidateSession: vi.fn() },
  hf: { search: vi.fn(), modelDetail: vi.fn() },
  tts: { speak: vi.fn() }
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal('window', { sibyl: bridge })
  ;({ actions, getState } = await import('./store'))
  Object.assign(getState(), {
    settings: settings(),
    conversations: [conversation()],
    activeConversationId: 'conversation-a'
  })
  bridge.settings.set.mockImplementation(async (patch) => ({
    ok: true,
    data: { ...getState().settings!, ...patch }
  }))
  bridge.conversations.save.mockImplementation(async (value) => {
    parseConversation(value)
    return { ok: true }
  })
  bridge.chat.invalidateSession.mockResolvedValue({ ok: true })
  bridge.tts.speak.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('character save and apply', () => {
  it('waits for the library save before snapshotting the edited character', async () => {
    const pending = deferred<Result<RendererSettings>>()
    bridge.settings.set.mockReturnValueOnce(pending.promise)
    const saving = actions.savePersona({ ...persona(), name: 'Edited character' }, 'conversation-a')
    await Promise.resolve()
    expect(bridge.conversations.save).not.toHaveBeenCalled()
    const patch = bridge.settings.set.mock.calls[0][0]
    pending.resolve({ ok: true, data: { ...settings(), ...patch } })
    expect(await saving).toBe(true)
    expect(getState().conversations[0].personaSnapshot?.persona).toMatchObject({
      name: 'Edited character', version: 2
    })
    expect(bridge.conversations.save).toHaveBeenCalledOnce()
  })

  it('applies newly created characters instead of clearing the conversation identity', async () => {
    expect(await actions.savePersona(persona('new-character'), 'conversation-a')).toBe(true)
    expect(getState().conversations[0]).toMatchObject({
      personaId: 'new-character',
      personaSnapshot: { sourcePersonaId: 'new-character', persona: { id: 'new-character' } }
    })
  })

  it('Save only updates the library without changing the frozen conversation identity', async () => {
    expect(await actions.savePersona({ ...persona(), name: 'Library edit' })).toBe(true)
    expect(getState().settings?.personas[0].name).toBe('Library edit')
    expect(getState().conversations[0].personaSnapshot?.persona.name).toBe('character-a')
    expect(bridge.conversations.save).not.toHaveBeenCalled()
  })

  it.each(['result', 'rejection'] as const)('does not apply or report success after a settings %s failure', async (kind) => {
    if (kind === 'result') bridge.settings.set.mockResolvedValueOnce({ ok: false, error: 'Disk unavailable' })
    else bridge.settings.set.mockRejectedValueOnce(new Error('Bridge unavailable'))
    const before = getState().conversations[0]
    expect(await actions.savePersona(persona('new-character'), 'conversation-a')).toBe(false)
    expect(getState().conversations[0]).toBe(before)
    expect(bridge.conversations.save).not.toHaveBeenCalled()
    expect(bridge.chat.invalidateSession).not.toHaveBeenCalled()
    expect(getState().toast?.kind).toBe('error')
  })

  it('reports conversation save failure so the editor can retain its draft', async () => {
    bridge.conversations.save.mockResolvedValueOnce({ ok: false, error: 'Disk unavailable' })
    expect(await actions.savePersona(persona('new-character'), 'conversation-a')).toBe(false)
    expect(getState().unsavedConversationIds).toContain('conversation-a')
    expect(bridge.chat.invalidateSession).not.toHaveBeenCalled()
  })
})

function sceneWithDirections(): Conversation {
  const cast = ['character-a', 'character-b', 'character-c']
  const directions = ['active', 'consumed', 'resolved'].map((id) => ({
    id,
    content: `Synthetic ${id} speaker-only guidance`,
    target: { kind: 'speaker' as const, speakerId: 'character-c' },
    scope: 'persistent' as const,
    enabled: true,
    createdAt: stamp,
    ...(id === 'consumed' ? { consumedAt: stamp, consumedByMessageId: 'beat-1' } : {}),
    ...(id === 'resolved' ? { resolvedAt: stamp } : {})
  }))
  return {
    ...conversation(),
    cast,
    castSnapshots: cast.map((id) => snapshotPersona(persona(id), stamp)),
    messages: [
      ...directions.map((direction) => ({
        id: `note-${direction.id}`,
        role: 'user' as const,
        content: direction.content,
        director: true,
        directionId: direction.id,
        createdAt: stamp
      })),
      { id: 'beat-1', role: 'assistant', speakerId: 'character-c', content: 'Synthetic reply.', createdAt: stamp }
    ],
    directions
  }
}

describe('scene cast removal', () => {
  it('retires active and historical scoped directions without losing their targets or notes', async () => {
    const before = sceneWithDirections()
    parseConversation(before)
    getState().conversations = [before]
    await actions.removeCastMember('character-c')
    const after = getState().conversations[0]
    expect(() => parseConversation(after)).not.toThrow()
    expect(after.cast).toEqual(['character-a', 'character-b'])
    expect(after.messages).toEqual(before.messages)
    for (const direction of after.directions!) {
      expect(direction).toMatchObject({ enabled: false, target: { kind: 'speaker', speakerId: 'character-c' } })
      expect(direction.resolvedAt).toBeTruthy()
    }
    expect(after.directions![1].consumedByMessageId).toBe('beat-1')
    expect(after.directions![2].resolvedAt).toBe(stamp)
    expect(bridge.chat.invalidateSession).toHaveBeenCalledWith(before.id)
    expect(getState().unsavedConversationIds).toEqual([])

    for (const speakerId of ['character-a', 'character-b', 'character-c']) {
      expect(activeDirectionsForSpeaker(after.directions, speakerId)).toEqual([])
      const prompt = buildBeatPrompt({
        messages: after.messages,
        speaker: persona(speakerId),
        cast: after.cast!.map((id) => persona(id)),
        directions: after.directions
      })
      expect(JSON.stringify(prompt)).not.toContain('speaker-only guidance')
    }
  })

  it('keeps the original cast and directions when persistence fails', async () => {
    const before = sceneWithDirections()
    getState().conversations = [before]
    bridge.conversations.save.mockResolvedValueOnce({ ok: false, error: 'Disk unavailable' })
    await actions.removeCastMember('character-c')
    expect(getState().conversations[0]).toBe(before)
    expect(getState().unsavedConversationIds).toEqual([])
    expect(bridge.chat.invalidateSession).not.toHaveBeenCalled()
  })

  it('does not allow unretired out-of-cast guidance through validation', () => {
    const scene = sceneWithDirections()
    scene.cast = ['character-a', 'character-b']
    scene.castSnapshots = scene.castSnapshots!.slice(0, 2)
    for (const partial of [
      { enabled: true, resolvedAt: stamp },
      { enabled: false, resolvedAt: undefined },
      { enabled: true, resolvedAt: undefined }
    ]) {
      scene.directions = [{ ...sceneWithDirections().directions![0], ...partial }]
      scene.messages = []
      expect(() => parseConversation(scene)).toThrow(/target speaker must be in the cast/)
    }
  })
})

describe('narration retry', () => {
  function seedNarrationFailure() {
    const character = { ...persona(), voice: { voiceId: 'character-voice', rate: 1.2 } }
    const scene = {
      ...conversation(),
      personaSnapshot: snapshotPersona(character, stamp),
      messages: [{ id: 'beat-1', role: 'assistant' as const, speakerId: character.id, content: 'Synthetic reply.', createdAt: stamp }]
    }
    const current = getState()
    current.settings!.tts = { ...DEFAULT_TTS_SETTINGS, enabled: true, autoSpeak: true, voiceId: null }
    current.tts = { available: true, speakingMessageId: null, synthesizing: false }
    current.installedVoices = [voice('character-voice')]
    current.conversations = [scene]
    current.turnOperation = { kind: 'scene', operationId: 'turn-1', conversationId: scene.id, messageId: 'beat-1', phase: 'failed' }
    current.scenePlay = setSceneNarration({
      ...createSceneRun({ convId: scene.id, now: Date.now(), maxTokensPerBeat: 100 }),
      activeOperationId: 'turn-1'
    }, 'error', 'beat-1', 'Synthetic failure')
  }

  it('uses the character voice and rate even without a global voice', async () => {
    seedNarrationFailure()
    actions.retrySceneNarration()
    expect(bridge.tts.speak).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'beat-1', voiceId: 'character-voice', rate: 1.2
    }))
    const { ttsPlayer } = await import('./lib/ttsPlayer')
    expect(ttsPlayer.prepareForSpeech).toHaveBeenCalledWith('beat-1')
    expect(getState().scenePlay?.narration).toBe('pending')
  })

  it('uses the same scene fallback as normal narration when the character voice is missing', () => {
    seedNarrationFailure()
    getState().installedVoices = [voice('scene-voice')]
    getState().conversations[0].sceneVoice = { voiceId: 'scene-voice', rate: 0.9 }
    actions.retrySceneNarration()
    expect(bridge.tts.speak).toHaveBeenCalledWith(expect.objectContaining({ voiceId: 'scene-voice', rate: 1.2 }))
  })

  it('restores retry controls if speech kickoff fails', async () => {
    seedNarrationFailure()
    bridge.tts.speak.mockResolvedValueOnce({ ok: false, error: 'Synthetic kickoff failure' })
    actions.retrySceneNarration()
    await Promise.resolve()
    await Promise.resolve()
    expect(getState().scenePlay?.status).toBe('narration-error')
    expect(getState().turnOperation.phase).toBe('failed')
  })
})

describe('model discovery request ordering', () => {
  it('ignores an older search completing while the current search is pending', async () => {
    const older = deferred<Result<HFModelSummary[]>>()
    const latest = deferred<Result<HFModelSummary[]>>()
    bridge.hf.search.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)
    actions.setDiscoverQuery('first')
    const first = actions.search()
    actions.setDiscoverQuery('second')
    const second = actions.search()
    older.resolve({ ok: false, error: 'Old failure' })
    await first
    expect(getState().discover).toMatchObject({ loading: true, error: null, results: [] })
    latest.resolve({ ok: true, data: [model('second')] })
    await second
    expect(getState().discover).toMatchObject({ loading: false, results: [model('second')] })
  })

  it('does not replace current results with an older response that arrives last', async () => {
    const older = deferred<Result<HFModelSummary[]>>()
    bridge.hf.search.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ ok: true, data: [model('latest')] })
    const first = actions.search()
    await actions.search()
    older.resolve({ ok: true, data: [model('older')] })
    await first
    expect(getState().discover.results).toEqual([model('latest')])
  })

  it('dismisses pending details immediately and ignores their eventual response', async () => {
    const pending = deferred<Result<HFModelDetail>>()
    bridge.hf.modelDetail.mockReturnValueOnce(pending.promise)
    const opening = actions.openModelDetail('model-a')
    actions.closeModelDetail()
    expect(getState().discover).toMatchObject({ detailLoading: false, selected: null })
    pending.resolve({ ok: true, data: detail('model-a') })
    await opening
    expect(getState().discover).toMatchObject({ detailLoading: false, selected: null })
  })

  it('keeps the latest detail selection when earlier requests complete late', async () => {
    const older = deferred<Result<HFModelDetail>>()
    bridge.hf.modelDetail.mockReturnValueOnce(older.promise).mockResolvedValueOnce({ ok: true, data: detail('latest') })
    const first = actions.openModelDetail('older')
    await actions.openModelDetail('latest')
    older.resolve({ ok: true, data: detail('older') })
    await first
    expect(getState().discover.selected?.id).toBe('latest')
  })

  it('clears loading and reports IPC failures instead of leaving a stuck drawer or search', async () => {
    bridge.hf.search.mockRejectedValueOnce(new Error('Synthetic IPC failure'))
    await actions.search()
    expect(getState().discover).toMatchObject({ loading: false, error: 'Model search became unavailable.' })
    bridge.hf.modelDetail.mockRejectedValueOnce(new Error('Synthetic IPC failure'))
    await actions.openModelDetail('model-a')
    expect(getState().discover).toMatchObject({ detailLoading: false, selected: null, error: 'Model details became unavailable.' })
  })
})
