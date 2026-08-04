import { describe, expect, it } from 'vitest'
import {
  assertChatAdvanceState,
  assertChatSendState,
  IPC_LIMITS,
  parseCanonicalId,
  parseChatSendRequest,
  parseContextUsageProjection,
  parseConversation,
  parseRecoveryPassphrase,
  parseRendererSettingsPatch,
  parseRepoFilename,
  parseVaultBackupId,
  parseVaultSetupRequest
} from './validation'

const now = '2026-07-24T12:00:00.000Z'

function conversation(): Record<string, unknown> {
  return {
    id: 'conv-1',
    title: 'Test',
    modelId: null,
    messages: [
      { id: 'msg-1', role: 'user', content: 'hello', createdAt: now },
      { id: 'msg-2', role: 'assistant', content: '', createdAt: now }
    ],
    createdAt: now,
    updatedAt: now
  }
}

describe('IPC runtime validation', () => {
  it('rejects nulls, wrong types, non-finite numbers, and unknown fields', () => {
    expect(() => parseConversation(null)).toThrow(/expected an object/)
    expect(() => parseConversation({ ...conversation(), messages: 'nope' })).toThrow(/expected an array/)
    expect(() =>
      parseRendererSettingsPatch({
        generation: {
          temperature: Number.NaN,
          topP: 1,
          topK: 40,
          minP: 0,
          maxTokens: 100,
          repeatPenalty: 1
        }
      })
    ).toThrow(/finite number/)
    expect(() => parseRendererSettingsPatch({ hfToken: 'must-not-cross' })).toThrow(/unknown field/)
    expect(() => parseRendererSettingsPatch({ modelsDir: 'C:\\unexpected' })).toThrow(/unknown field/)
  })

  it('rejects invalid ids and path traversal instead of sanitizing them', () => {
    expect(() => parseCanonicalId('../same')).toThrow(/canonical identifier/)
    expect(() => parseRepoFilename('../model.gguf')).toThrow(/canonical GGUF/)
    expect(() => parseRepoFilename('folder\\model.gguf')).toThrow(/repository-relative/)
  })

  it('limits unbounded content and arrays', () => {
    const tooLong = 'x'.repeat(IPC_LIMITS.message + 1)
    expect(() =>
      parseChatSendRequest({
        conversationId: 'conv-1',
        message: tooLong,
        assistantMessageId: 'msg-2'
      })
    ).toThrow(/at most/)
    expect(() =>
      parseContextUsageProjection({
        conversationId: 'conv-1',
        prospectiveInput: { content: tooLong }
      })
    ).toThrow(/at most/)
    expect(() =>
      parseRendererSettingsPatch({
        generation: {
          temperature: 1,
          topP: 1,
          topK: 40,
          minP: 0,
          maxTokens: 100,
          repeatPenalty: 1,
          stopSequences: Array.from({ length: IPC_LIMITS.stopSequences + 1 }, () => 'stop')
        }
      })
    ).toThrow(/at most/)
    expect(() =>
      parseRendererSettingsPatch({
        personas: Array.from({ length: 51 }, (_, index) => ({
          id: `persona-${index}`,
          name: `Persona ${index}`,
          role: '',
          brief: 'x'.repeat(IPC_LIMITS.message),
          avatar: { monogram: 'P', gradient: ['#000', '#111'] },
          voiceTags: []
        }))
      })
    ).toThrow(/combined settings text/)
  })

  it('validates prospective context input and the selected scene speaker', () => {
    expect(
      parseContextUsageProjection({
        conversationId: 'conv-1',
        prospectiveInput: { content: 'A new direction', director: true },
        nextSpeakerId: 'persona-2'
      })
    ).toEqual({
      conversationId: 'conv-1',
      prospectiveInput: { content: 'A new direction', director: true },
      nextSpeakerId: 'persona-2'
    })
    expect(() =>
      parseContextUsageProjection({
        conversationId: 'conv-1',
        prospectiveInput: { content: 'hello', unexpected: true }
      })
    ).toThrow(/unknown field/)
  })

  it('validates versioned snapshots, scoped knowledge, memory provenance, and directions', () => {
    const persona = {
      schemaVersion: 2,
      version: 4,
      id: 'persona-a',
      name: 'Ada',
      role: 'Scout',
      brief: 'Play Ada.',
      avatar: { monogram: 'A', gradient: ['#000', '#111'] },
      voiceTags: [],
      privateMotivations: ['Protect the map.'],
      relationships: [
        { personaId: 'persona-b', summary: 'Distrusts Bo.', visibility: 'private' }
      ]
    }
    const value = {
      ...conversation(),
      schemaVersion: 2,
      cast: ['persona-a', 'persona-b'],
      castSnapshots: [
        {
          schemaVersion: 1,
          sourcePersonaId: 'persona-a',
          sourceVersion: 4,
          capturedAt: now,
          persona
        }
      ],
      knowledgeMode: 'scoped',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          speakerId: 'persona-a',
          content: 'A line.',
          createdAt: now,
          segments: [
            {
              id: 'seg-1',
              kind: 'thought',
              content: 'A secret.',
              visibility: { kind: 'private', characterIds: ['persona-a'] }
            }
          ]
        }
      ],
      roleplayState: {
        schemaVersion: 1,
        facts: [
          {
            id: 'fact-1',
            category: 'location',
            text: 'At the gate.',
            visibility: { kind: 'public' },
            provenanceMessageIds: ['msg-1'],
            userAuthored: false,
            pinned: false,
            updatedAt: now
          }
        ],
        beatsSinceMaintenance: 1
      },
      directions: [
        {
          id: 'dir-1',
          content: 'Ada notices the bell.',
          target: { kind: 'speaker', speakerId: 'persona-a' },
          scope: 'next-beat',
          enabled: true,
          createdAt: now
        }
      ],
      sceneVoice: { voiceId: 'voice-scene', rate: 1.15 }
    }
    const parsed = parseConversation(value)
    expect(parsed.roleplayState?.facts[0].provenanceMessageIds).toEqual(['msg-1'])
    expect(parsed.sceneVoice).toEqual({ voiceId: 'voice-scene', rate: 1.15 })
    expect(() =>
      parseConversation({
        ...value,
        roleplayState: {
          ...value.roleplayState,
          facts: [{ ...value.roleplayState.facts[0], provenanceMessageIds: ['missing'] }]
        }
      })
    ).toThrow(/provenance/)
    expect(() =>
      parseConversation({
        ...value,
        directions: [
          { ...value.directions[0], target: { kind: 'speaker', speakerId: 'not-cast' } }
        ]
      })
    ).toThrow(/target speaker/)
  })

  it('clamps finite native-facing numeric settings', () => {
    const patch = parseRendererSettingsPatch({
      load: { gpuLayers: 1e9, contextSize: 1, systemPrompt: '' },
      tts: { enabled: true, voiceId: null, rate: 99, volume: -2, autoSpeak: false },
      accessibility: { reducedMotion: true, highContrast: true, textScale: 1.125 }
    })
    expect(patch.load?.gpuLayers).toBe(10_000)
    expect(patch.load?.contextSize).toBe(512)
    expect(patch.tts?.rate).toBe(2)
    expect(patch.tts?.volume).toBe(0)
    expect(patch.accessibility?.textScale).toBe(1.125)
    const legacyContext = parseRendererSettingsPatch({
      context: {
        autoCompact: true,
        compactThreshold: 0.85,
        warnThreshold: 0.7,
        keepRecentMessages: 6,
        keepRecentFraction: 0.35,
        summaryTokenFraction: 0.06
      }
    })
    expect(legacyContext.context?.compactTargetFraction).toBe(0.5)
    expect(legacyContext.context?.compactRunwayTurns).toBe(3)
    expect(() =>
      parseRendererSettingsPatch({
        accessibility: { reducedMotion: true, highContrast: true, textScale: 1.2 }
      })
    ).toThrow(/unsupported text scale/)
  })

  it('rejects chat requests that do not match persisted placeholders', () => {
    const conv = parseConversation(conversation())
    const send = parseChatSendRequest({
      conversationId: 'conv-1',
      message: 'different',
      assistantMessageId: 'msg-2'
    })
    expect(() => assertChatSendState(conv, send)).toThrow(/does not match/)
    expect(() =>
      assertChatAdvanceState(
        { ...conv, cast: ['persona-1'] },
        {
          conversationId: conv.id,
          speakerId: 'persona-1',
          assistantMessageId: 'msg-2'
        }
      )
    ).toThrow(/does not match/)
  })

  it('strictly validates vault passphrases and setup requests', () => {
    expect(() => parseRecoveryPassphrase('too short')).toThrow(/at least 12/)
    expect(() => parseRecoveryPassphrase('🔐'.repeat(300))).toThrow(/UTF-8 bytes/)
    expect(
      parseVaultSetupRequest({
        recoveryPassphrase: 'correct horse battery staple',
        seamlessOnThisDevice: true
      })
    ).toEqual({
      recoveryPassphrase: 'correct horse battery staple',
      seamlessOnThisDevice: true
    })
    expect(() =>
      parseVaultSetupRequest({
        recoveryPassphrase: 'correct horse battery staple',
        seamlessOnThisDevice: true,
        hint: 'must not be persisted'
      })
    ).toThrow(/unknown field/)
  })

  it('accepts only opaque local backup identifiers', () => {
    expect(parseVaultBackupId('AbCdEfGhIjKlMnOpQrStUv.svb')).toBe(
      'AbCdEfGhIjKlMnOpQrStUv.svb'
    )
    expect(() => parseVaultBackupId('../settings.json')).toThrow(/opaque/)
    expect(() => parseVaultBackupId('conversation-name.svb')).toThrow(/opaque/)
  })
})
