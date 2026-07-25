import type { Conversation, Persona } from './types'
import type { TtsSettings } from './tts'
import { resolveConversationPersona } from './roleplay'

export interface ResolvedSpeechVoice {
  voiceId: string | null
  rate: number
  source: 'character' | 'scene' | 'global' | 'none'
  /** The highest-priority configured voice that was unavailable, if any. */
  missingPreferredVoiceId?: string
}

/**
 * Resolve speech deterministically without touching the filesystem:
 * character override → scene fallback → global fallback. Voice availability is
 * supplied by the renderer/main caller, so missing persona voices degrade
 * safely instead of making scene autoplay fail.
 */
export function resolveSpeechVoice(params: {
  conversation: Conversation
  speakerId?: string
  personas: Persona[] | undefined
  global: TtsSettings
  availableVoiceIds: ReadonlySet<string>
}): ResolvedSpeechVoice {
  const { conversation, personas, global, availableVoiceIds } = params
  const identityId = params.speakerId ?? conversation.personaId
  const character = resolveConversationPersona(conversation, identityId, personas)
  const candidates = [
    { source: 'character' as const, voiceId: character?.voice?.voiceId },
    { source: 'scene' as const, voiceId: conversation.sceneVoice?.voiceId },
    { source: 'global' as const, voiceId: global.voiceId ?? undefined }
  ].filter(
    (candidate): candidate is { source: 'character' | 'scene' | 'global'; voiceId: string } =>
      Boolean(candidate.voiceId)
  )
  const selected = candidates.find((candidate) => availableVoiceIds.has(candidate.voiceId))
  const missingPreferredVoiceId =
    candidates[0] && !availableVoiceIds.has(candidates[0].voiceId)
      ? candidates[0].voiceId
      : undefined
  return {
    voiceId: selected?.voiceId ?? null,
    rate: character?.voice?.rate ?? conversation.sceneVoice?.rate ?? global.rate,
    source: selected?.source ?? 'none',
    missingPreferredVoiceId
  }
}
