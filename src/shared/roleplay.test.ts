import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  Conversation,
  Persona,
  RoleplayFact,
  SceneDirection
} from './types'
import {
  activeDirectionsForSpeaker,
  consumeOneShotDirections,
  detachPersonaIdentity,
  messageContentForSpeaker,
  migrateConversationIdentity,
  resolveConversationPersona,
  roleplayStatePrompt,
  snapshotPersona,
  upsertRoleplayFact,
  visibilityAllows
} from './roleplay'
import { buildBeatPrompt, sceneCast } from './scene'

const A: Persona = {
  id: 'a',
  name: 'Ada',
  role: 'Scout',
  brief: 'Play Ada.',
  avatar: { monogram: 'A', gradient: ['#000', '#111'] },
  voiceTags: [],
  version: 3,
  publicDescription: 'A rain-soaked scout.',
  privateMotivations: ['Protect the map.'],
  secrets: ['The map is false.'],
  relationships: [{ personaId: 'b', summary: 'Distrusts Bo.', visibility: 'private' }]
}
const B: Persona = {
  id: 'b',
  name: 'Bo',
  role: 'Guide',
  brief: 'Play Bo.',
  avatar: { monogram: 'B', gradient: ['#222', '#333'] },
  voiceTags: [],
  version: 2,
  publicDescription: 'A patient guide.',
  secrets: ['Bo stole the compass.']
}

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv',
    title: 'Scene',
    modelId: null,
    messages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch
  }
}

describe('persona snapshot migration', () => {
  it.each([
    ['blank legacy thread', conversation()],
    ['single-persona legacy thread', conversation({ personaId: 'a' })],
    ['legacy scene', conversation({ cast: ['a', 'b'] })]
  ])('migrates the supported %s shape forward', (_label, legacy) => {
    const migrated = migrateConversationIdentity(legacy, [A, B])
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.knowledgeMode).toBe('scoped')
    expect(migrated.roleplayState).toEqual({
      schemaVersion: 1,
      facts: [],
      beatsSinceMaintenance: 0
    })
    expect(migrated.directions).toEqual([])
    if (legacy.personaId) expect(migrated.personaSnapshot?.sourceVersion).toBe(3)
    if (legacy.cast) expect(migrated.castSnapshots?.map((item) => item.sourcePersonaId)).toEqual(['a', 'b'])
  })

  it('keeps a scene resolvable after every library persona is deleted', () => {
    const migrated = migrateConversationIdentity(conversation({ cast: ['a', 'b'] }), [A, B])
    expect(sceneCast(migrated, []).map((persona) => persona.name)).toEqual(['Ada', 'Bo'])
    expect(resolveConversationPersona(migrated, 'a', [])?.brief).toBe('Play Ada.')
  })

  it('does not mutate a frozen identity when the library revision changes', () => {
    const migrated = migrateConversationIdentity(conversation({ personaId: 'a' }), [A])
    const edited = { ...A, version: 4, brief: 'A changed brief.' }
    expect(resolveConversationPersona(migrated, 'a', [edited])?.brief).toBe('Play Ada.')
  })

  it('captures prompt and voice identity without sharing references', () => {
    const source = { ...A, voice: { voiceId: 'voice-a', rate: 1.1 } }
    const snapshot = snapshotPersona(source, '2026-01-01T00:00:00.000Z')
    source.voice!.rate = 1.5
    expect(snapshot.persona.voice).toEqual({ voiceId: 'voice-a', rate: 1.1 })
  })

  it('detaches every semantic reference from the deleted library id', () => {
    const migrated = migrateConversationIdentity(
      conversation({
        cast: ['a', 'b'],
        messages: [
          {
            id: 'beat',
            role: 'assistant',
            speakerId: 'a',
            speakerName: 'Ada',
            content: 'A thought.',
            createdAt: '',
            segments: [
              {
                id: 'thought',
                kind: 'thought',
                content: 'A thought.',
                visibility: { kind: 'private', characterIds: ['a'] }
              }
            ]
          }
        ]
      }),
      [A, B]
    )
    const detached = detachPersonaIdentity(migrated, 'a', 'detached-a')
    expect(detached.cast).toEqual(['detached-a', 'b'])
    expect(detached.castSnapshots?.[0].sourcePersonaId).toBe('detached-a')
    expect(detached.castSnapshots?.[0].persona.id).toBe('detached-a')
    expect(detached.messages[0].speakerId).toBe('detached-a')
    expect(detached.messages[0].segments?.[0].visibility).toEqual({
      kind: 'private',
      characterIds: ['detached-a']
    })
  })
})

describe('deterministic knowledge projection', () => {
  const message: ChatMessage = {
    id: 'm',
    role: 'assistant',
    speakerId: 'a',
    content: 'visible aggregate',
    createdAt: '',
    segments: [
      {
        id: 'public',
        kind: 'dialogue',
        content: '"We should leave."',
        visibility: { kind: 'public' }
      },
      {
        id: 'ada-only',
        kind: 'thought',
        content: 'Ada knows the bridge is trapped.',
        visibility: { kind: 'private', characterIds: ['a'] }
      },
      {
        id: 'bo-only',
        kind: 'thought',
        content: 'Bo recognizes the sigil.',
        visibility: { kind: 'private', characterIds: ['b'] }
      }
    ]
  }

  it('projects public history plus only the active character knowledge', () => {
    expect(messageContentForSpeaker(message, 'a')).toContain('bridge is trapped')
    expect(messageContentForSpeaker(message, 'a')).not.toContain('recognizes the sigil')
    expect(messageContentForSpeaker(message, 'b')).toContain('recognizes the sigil')
    expect(messageContentForSpeaker(message, 'b')).not.toContain('bridge is trapped')
  })

  it('supports public-only compatibility mode', () => {
    expect(messageContentForSpeaker(message, 'c', 'public-only')).toContain('bridge is trapped')
    expect(messageContentForSpeaker(message, 'c', 'public-only')).toContain('recognizes the sigil')
  })

  it('filters the actual beat prompt, not merely the UI', () => {
    const ada = buildBeatPrompt({ messages: [message], speaker: A, cast: [A, B] })
    const bo = buildBeatPrompt({ messages: [message], speaker: B, cast: [A, B] })
    expect(`${ada.history.map((turn) => turn.text).join('\n')}\n${ada.prompt}`).not.toContain(
      'recognizes the sigil'
    )
    expect(`${bo.history.map((turn) => turn.text).join('\n')}\n${bo.prompt}`).not.toContain(
      'bridge is trapped'
    )
  })

  it('shows other characters public identity without leaking their private persona fields', () => {
    const prompt = buildBeatPrompt({ messages: [], speaker: A, cast: [A, B] })
    expect(prompt.system).toContain('A patient guide.')
    expect(prompt.system).toContain('The map is false.')
    expect(prompt.system).not.toContain('Bo stole the compass.')
  })

  it('fails closed for private visibility with no matching speaker', () => {
    expect(visibilityAllows({ kind: 'private', characterIds: ['a'] }, 'unknown')).toBe(false)
  })
})

describe('directions and structured memory', () => {
  const directions: SceneDirection[] = [
    {
      id: 'next-a',
      content: 'Ada notices the bell.',
      target: { kind: 'speaker', speakerId: 'a' },
      scope: 'next-beat',
      enabled: true,
      createdAt: ''
    },
    {
      id: 'persistent',
      content: 'Keep the pace tense.',
      target: { kind: 'cast' },
      scope: 'persistent',
      enabled: true,
      createdAt: ''
    },
    {
      id: 'disabled',
      content: 'Do not include this.',
      target: { kind: 'cast' },
      scope: 'persistent',
      enabled: false,
      createdAt: ''
    }
  ]

  it('targets only the intended prompt and consumes one-shots after a saved beat', () => {
    expect(activeDirectionsForSpeaker(directions, 'a').map((item) => item.id)).toEqual([
      'next-a',
      'persistent'
    ])
    expect(activeDirectionsForSpeaker(directions, 'b').map((item) => item.id)).toEqual([
      'persistent'
    ])
    const consumed = consumeOneShotDirections(directions, 'a', 'beat-a', 'now')!
    expect(consumed.find((item) => item.id === 'next-a')).toMatchObject({
      consumedAt: 'now',
      consumedByMessageId: 'beat-a'
    })
    expect(consumed.find((item) => item.id === 'persistent')?.consumedAt).toBeUndefined()
  })

  it('does not replay consumed structured director notes through transcript history', () => {
    const consumed = consumeOneShotDirections(directions, 'a', 'beat-a', 'now')!
    const prompt = buildBeatPrompt({
      messages: [
        {
          id: 'note',
          role: 'user',
          content: 'Ada notices the bell.',
          createdAt: '',
          director: true,
          directionId: 'next-a'
        }
      ],
      speaker: A,
      cast: [A, B],
      directions: consumed
    })
    expect(prompt.system).not.toContain('Ada notices the bell.')
    expect(prompt.prompt).not.toContain('Ada notices the bell.')
  })

  it('never replaces a pinned user correction with extracted state', () => {
    const pinned: RoleplayFact = {
      id: 'location',
      category: 'location',
      text: 'The party is under the east tower.',
      visibility: { kind: 'public' },
      provenanceMessageIds: [],
      userAuthored: true,
      pinned: true,
      updatedAt: '1'
    }
    const extracted = { ...pinned, text: 'The party is in the west field.', userAuthored: false }
    expect(upsertRoleplayFact([pinned], extracted)).toEqual([pinned])
  })

  it('preserves pinned facts across repeated prose-recap maintenance passes', () => {
    const pinned: RoleplayFact = {
      id: 'promise',
      category: 'obligation',
      text: 'Ada promised not to open the gate.',
      visibility: { kind: 'private', characterIds: ['a'] },
      provenanceMessageIds: ['m1'],
      userAuthored: true,
      pinned: true,
      updatedAt: '1'
    }
    const state = { schemaVersion: 1 as const, facts: [pinned], beatsSinceMaintenance: 0 }
    const passOne = { ...state, recap: 'First recap.', maintainedAt: '2' }
    const passTwo = { ...passOne, recap: 'Second recap.', maintainedAt: '3' }
    expect(roleplayStatePrompt({ roleplayState: passTwo, knowledgeMode: 'scoped' }, 'a')).toContain(
      'promised not to open'
    )
    expect(roleplayStatePrompt({ roleplayState: passTwo, knowledgeMode: 'scoped' }, 'b')).not.toContain(
      'promised not to open'
    )
  })
})
