import { describe, expect, it } from 'vitest'
import {
  assertChatAdvanceState,
  assertChatSendState,
  IPC_LIMITS,
  parseCanonicalId,
  parseChatSendRequest,
  parseContextUsageProjection,
  parseConversation,
  parseRendererSettingsPatch,
  parseRepoFilename
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

  it('clamps finite native-facing numeric settings', () => {
    const patch = parseRendererSettingsPatch({
      load: { gpuLayers: 1e9, contextSize: 1, systemPrompt: '' },
      tts: { enabled: true, voiceId: null, rate: 99, volume: -2, autoSpeak: false }
    })
    expect(patch.load?.gpuLayers).toBe(10_000)
    expect(patch.load?.contextSize).toBe(512)
    expect(patch.tts?.rate).toBe(2)
    expect(patch.tts?.volume).toBe(0)
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
})
