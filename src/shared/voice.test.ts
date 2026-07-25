import { describe, expect, it } from 'vitest'
import type { Conversation, Persona } from './types'
import { DEFAULT_TTS_SETTINGS } from './tts'
import { resolveSpeechVoice } from './voice'

const persona = (id: string, voiceId?: string, rate?: number): Persona => ({
  id,
  name: id,
  role: '',
  brief: '',
  avatar: { monogram: id, gradient: ['#000', '#111'] },
  voiceTags: [],
  voice: voiceId || rate ? { voiceId, rate } : undefined
})

const conversation = (patch: Partial<Conversation> = {}): Conversation => ({
  id: 'scene',
  title: 'Scene',
  modelId: null,
  messages: [],
  cast: ['a', 'b'],
  createdAt: '',
  updatedAt: '',
  ...patch
})

describe('speech voice resolution', () => {
  it('uses character, then scene, then global voice while preserving rate precedence', () => {
    const global = { ...DEFAULT_TTS_SETTINGS, voiceId: 'global', rate: 0.9 }
    const scene = conversation({ sceneVoice: { voiceId: 'scene', rate: 1.1 } })
    expect(
      resolveSpeechVoice({
        conversation: scene,
        speakerId: 'a',
        personas: [persona('a', 'character', 1.25), persona('b')],
        global,
        availableVoiceIds: new Set(['character', 'scene', 'global'])
      })
    ).toMatchObject({ voiceId: 'character', rate: 1.25, source: 'character' })
    expect(
      resolveSpeechVoice({
        conversation: scene,
        speakerId: 'b',
        personas: [persona('a'), persona('b')],
        global,
        availableVoiceIds: new Set(['scene', 'global'])
      })
    ).toMatchObject({ voiceId: 'scene', rate: 1.1, source: 'scene' })
  })

  it('visibly reports a missing preferred voice and falls back safely', () => {
    const result = resolveSpeechVoice({
      conversation: conversation({ sceneVoice: { voiceId: 'scene', rate: 1.1 } }),
      speakerId: 'a',
      personas: [persona('a', 'deleted', 1.3), persona('b')],
      global: { ...DEFAULT_TTS_SETTINGS, voiceId: 'global', rate: 0.9 },
      availableVoiceIds: new Set(['scene', 'global'])
    })
    expect(result).toEqual({
      voiceId: 'scene',
      rate: 1.3,
      source: 'scene',
      missingPreferredVoiceId: 'deleted'
    })
  })
})
