import type {
  Conversation,
  Persona,
  SceneDirectorDecision,
  SceneDirectorSettings
} from './types'
import { activeDirectionsForSpeaker } from './roleplay'

export const DEFAULT_SCENE_DIRECTOR: SceneDirectorSettings = {
  enabled: false,
  useModel: true,
  pacing: 'balanced',
  initiative: 'balanced',
  interruption: 'natural-pauses',
  inspectIntent: false
}

export const DIRECTOR_MAX_PROMPT_TOKENS = 896
export const DIRECTOR_MAX_COMPLETION_TOKENS = 128

export function parseDirectorOutput(output: string, castIds: Set<string>): {
  action: 'continue' | 'pause' | 'end'
  speakerId?: string
  intent: string
} {
  const clean = output
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  let value: unknown
  try {
    value = JSON.parse(clean)
  } catch {
    throw new Error('Director returned invalid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Director returned an invalid object.')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some(
      (key) => key !== 'action' && key !== 'speakerId' && key !== 'intent'
    ) ||
    !['continue', 'pause', 'end'].includes(record.action as string) ||
    typeof record.intent !== 'string' ||
    !record.intent.trim() ||
    record.intent.length > 500
  ) {
    throw new Error('Director returned invalid fields.')
  }
  if (record.action === 'continue') {
    if (typeof record.speakerId !== 'string' || !castIds.has(record.speakerId)) {
      throw new Error('Director selected a character outside the cast.')
    }
  } else if (record.speakerId !== undefined) {
    throw new Error('Director supplied a speaker for a terminal action.')
  }
  return {
    action: record.action as 'continue' | 'pause' | 'end',
    speakerId: record.speakerId as string | undefined,
    intent: record.intent.trim()
  }
}

export function deterministicDirectorDecision(params: {
  conversation: Conversation
  cast: Persona[]
  fallbackSpeakerId: string | null
}): SceneDirectorDecision | null {
  const { conversation, cast, fallbackSpeakerId } = params
  if (cast.length < 2 || !fallbackSpeakerId) {
    return {
      action: 'pause',
      intent: 'The cast is not currently valid.',
      usedModel: false,
      fallbackReason: 'invalid-cast',
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0
    }
  }
  const last = [...conversation.messages].reverse().find((message) => message.content.trim())
  const lastContent = last?.content.trim().toLocaleLowerCase()
  if (lastContent?.endsWith('[end scene]')) {
    return {
      action: 'end',
      intent: 'The transcript contains an explicit scene-ending marker.',
      usedModel: false,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0
    }
  }
  if (lastContent?.endsWith('[wait for human]')) {
    return {
      action: 'pause',
      intent: 'The transcript explicitly requests human participation.',
      usedModel: false,
      fallbackReason: 'pending-human',
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0
    }
  }
  for (const persona of cast) {
    if (
      activeDirectionsForSpeaker(conversation.directions, persona.id).some(
        (direction) =>
          direction.target.kind === 'speaker' && direction.target.speakerId === persona.id
      )
    ) {
      return {
        action: 'continue',
        speakerId: persona.id,
        intent: 'Honor the active targeted direction before free selection.',
        usedModel: false,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0
      }
    }
  }
  return null
}
