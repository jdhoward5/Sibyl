import { describe, expect, it } from 'vitest'
import type { Conversation, InstalledModel, Persona } from './types'
import {
  parsePortableBundlePayload,
  preparePortableImport,
  type PortableBundlePayload
} from './portable'

const persona: Persona = {
  schemaVersion: 2,
  version: 1,
  id: 'persona-1',
  name: 'Ada',
  role: 'Engineer',
  brief: 'Private character brief',
  avatar: { monogram: 'A', gradient: ['#111111', '#222222'] },
  voiceTags: [],
  relationships: [
    { personaId: 'persona-2', summary: 'Trusts them', visibility: 'private' }
  ]
}

const conversation: Conversation = {
  schemaVersion: 2,
  id: 'conversation-1',
  title: 'Private scene',
  modelId: 'source-model',
  messages: [
    {
      id: 'message-1',
      role: 'assistant',
      content: 'Private line',
      createdAt: '2026-01-01T00:00:00.000Z',
      speakerId: 'persona-1',
      speakerName: 'Ada',
      segments: [
        {
          id: 'segment-1',
          kind: 'thought',
          content: 'Secret thought',
          visibility: { kind: 'private', characterIds: ['persona-1'] }
        }
      ]
    }
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  cast: ['persona-1', 'persona-2'],
  castSnapshots: [
    {
      schemaVersion: 1,
      sourcePersonaId: 'persona-1',
      sourceVersion: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      persona
    },
    {
      schemaVersion: 1,
      sourcePersonaId: 'persona-2',
      sourceVersion: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      persona: { ...persona, id: 'persona-2', name: 'Bob' }
    }
  ]
}

const payload: PortableBundlePayload = {
  schemaVersion: 1,
  scope: 'conversation',
  exportedAt: '2026-01-01T00:00:00.000Z',
  conversations: [conversation],
  personas: [persona, { ...persona, id: 'persona-2', name: 'Bob' }],
  settings: { backupRetention: 5, telemetry: false },
  models: [
    {
      sourceId: 'source-model',
      repoId: 'example/model',
      filename: 'model.gguf',
      sizeBytes: 123
    }
  ]
}

describe('portable bundle payload', () => {
  it('strictly validates its versioned schema', () => {
    expect(parsePortableBundlePayload(payload).scope).toBe('conversation')
    expect(() =>
      parsePortableBundlePayload({ ...payload, hiddenMetadata: true })
    ).toThrow(/unexpected/)
    expect(() =>
      parsePortableBundlePayload({ ...payload, schemaVersion: 2 })
    ).toThrow(/not supported/)
    expect(() =>
      parsePortableBundlePayload({
        ...payload,
        personas: [],
        conversations: [{ ...conversation, castSnapshots: undefined }]
      })
    ).toThrow(/unresolved cast persona/)
  })

  it('remaps collisions through every character reference and resolves local models', () => {
    const installedModel: InstalledModel = {
      id: 'local-model',
      repoId: 'example/model',
      filename: 'model.gguf',
      path: 'C:/models/model.gguf',
      sizeBytes: 123,
      installedAt: '2026-01-01T00:00:00.000Z'
    }
    const ids = ['new-persona-1', 'new-conversation-1']
    const prepared = preparePortableImport({
      payload,
      existingPersonas: [{ ...persona }],
      existingConversations: [{ ...conversation, messages: [] }],
      installedModels: [installedModel],
      newId: () => ids.shift() ?? 'unused-id'
    })
    expect(prepared.collisionCount).toBe(2)
    expect(prepared.personas[0].id).toBe('new-persona-1')
    expect(prepared.conversations[0].id).toBe('new-conversation-1')
    expect(prepared.conversations[0].modelId).toBe('local-model')
    expect(prepared.conversations[0].cast?.[0]).toBe('new-persona-1')
    expect(prepared.conversations[0].messages[0].speakerId).toBe('new-persona-1')
    expect(
      prepared.conversations[0].messages[0].segments?.[0].visibility
    ).toEqual({ kind: 'private', characterIds: ['new-persona-1'] })
  })
})
