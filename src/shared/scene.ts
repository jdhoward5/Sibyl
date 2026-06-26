// Self-roleplay "scene" helpers. A scene is a conversation with a cast of two or
// more personas who converse with each other; the human can watch, join in as
// their own character, or drop out-of-character "director" notes to steer it.
//
// Pure data + string assembly only — NO node/electron imports, so the renderer
// can use it and it stays unit-testable (`scene.test.ts`). The engine maps the
// neutral `SceneTurn`s here onto node-llama-cpp's chat-history items.

import type { ChatMessage, Conversation, Persona, UserCharacter } from './types'
import { findPersona } from './personas'

/** A scene needs at least this many AI characters to be a conversation-with-itself. */
export const MIN_SCENE_CAST = 2

/** True when a conversation is a self-roleplay scene (cast of ≥2 personas). */
export function isScene(conv: Pick<Conversation, 'cast'> | null | undefined): boolean {
  return (conv?.cast?.length ?? 0) >= MIN_SCENE_CAST
}

/** Resolve a conversation's cast ids to personas (in cast order, dropping any that no longer exist). */
export function sceneCast(
  conv: Pick<Conversation, 'cast'> | null | undefined,
  personas: Persona[] | undefined
): Persona[] {
  if (!conv?.cast?.length) return []
  const out: Persona[] = []
  for (const id of conv.cast) {
    const p = findPersona(personas, id)
    if (p && !out.some((q) => q.id === p.id)) out.push(p)
  }
  return out
}

/**
 * Whose turn is next, by round-robin over the (resolvable) cast: the character
 * after whoever spoke the most recent AI beat. Returns null if the cast is empty.
 */
export function nextSpeakerId(
  conv: Pick<Conversation, 'cast' | 'messages'>,
  personas: Persona[] | undefined
): string | null {
  const cast = sceneCast(conv, personas)
  if (!cast.length) return null
  let lastSpeakerId: string | undefined
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]
    if (m.role === 'assistant' && m.speakerId) {
      lastSpeakerId = m.speakerId
      break
    }
  }
  const idx = lastSpeakerId ? cast.findIndex((c) => c.id === lastSpeakerId) : -1
  if (idx < 0) return cast[0].id
  return cast[(idx + 1) % cast.length].id
}

/** The human participant's display name in a scene (their character, or "You"). */
export function userDisplayName(userCharacter: UserCharacter | undefined): string {
  return userCharacter?.name?.trim() || 'You'
}

/** One neutral history turn the engine maps onto a chat-history item. */
export interface SceneTurn {
  role: 'user' | 'model'
  text: string
}

/** Everything the engine needs to generate one beat for a given speaker. */
export interface BeatPrompt {
  /** System turn (the speaker's brief + scene roster + rules). */
  system: string
  /** Prior history to seed the session with (alternating user/model turns). */
  history: SceneTurn[]
  /** The final user turn to prompt with (the lines the speaker is responding to). */
  prompt: string
  /** Stop triggers that catch the model trying to write other characters. */
  stopTriggers: string[]
}

/** How a non-active message is rendered into the transcript fed to the speaker. */
function otherLine(
  m: ChatMessage,
  cast: Persona[],
  userName: string
): string {
  const content = m.content.trim()
  if (m.director) return `[Director: ${content}]`
  if (m.role === 'user') return `${userName}: ${content}`
  const name =
    m.speakerName?.trim() || cast.find((c) => c.id === m.speakerId)?.name || 'Someone'
  return `${name}: ${content}`
}

/** Compose the system prompt: the speaker's brief, then scene rules + roster. */
function buildSystem(
  speaker: Persona,
  cast: Persona[],
  userCharacter: UserCharacter | undefined,
  scenePremise: string | undefined
): string {
  const lines: string[] = []
  const brief = speaker.brief?.trim()
  if (brief) lines.push(brief, '')

  const who = speaker.role?.trim() ? `${speaker.name}, ${speaker.role.trim()}` : speaker.name
  lines.push(
    `You are playing ${who}, one character in a shared, ongoing scene. Write only ` +
      `${speaker.name}'s next beat — their dialogue, actions and inner thoughts — then stop. ` +
      `Never speak, act, or narrate for the other characters or for the human. Do not prefix ` +
      `your reply with your name. Stay fully in character and never mention being an AI.`
  )

  lines.push('', 'Characters in the scene:')
  for (const c of cast) {
    const tag = c.id === speaker.id ? ' (you)' : ''
    const role = c.role?.trim() ? ` — ${c.role.trim()}` : ''
    lines.push(`- ${c.name}${tag}${role}`)
  }
  const ucName = userCharacter?.name?.trim()
  const ucDesc = userCharacter?.description?.trim()
  if (ucName || ucDesc) {
    lines.push(`- ${ucName || 'You'} (the human participant)${ucDesc ? ` — ${ucDesc}` : ''}`)
  }

  const premise = scenePremise?.trim()
  if (premise) lines.push('', `Setting: ${premise}`)

  return lines.join('\n')
}

/**
 * Build everything needed to generate the next beat for `speaker`.
 *
 * The transcript is mapped from the active speaker's point of view: their own
 * prior beats become unprefixed `model` turns; every other character's line, the
 * human's lines, and director notes become name-prefixed `user` turns. Runs of
 * consecutive "other" lines are coalesced into a single user turn so the chat
 * template never sees two user turns in a row. The trailing run (what's happened
 * since the speaker last spoke) becomes the `prompt`.
 */
export function buildBeatPrompt(params: {
  messages: ChatMessage[]
  speaker: Persona
  cast: Persona[]
  userCharacter?: UserCharacter
  scenePremise?: string
}): BeatPrompt {
  const { messages, speaker, cast, userCharacter, scenePremise } = params
  const userName = userDisplayName(userCharacter)

  // Coalesce into a flat list of user/model turns. "Other" lines accumulate into
  // a buffer that is flushed (as one user turn) whenever the speaker speaks.
  const items: SceneTurn[] = []
  let buffer: string[] = []
  const flush = (): void => {
    if (buffer.length) {
      items.push({ role: 'user', text: buffer.join('\n') })
      buffer = []
    }
  }
  for (const m of messages) {
    if (m.role === 'system' || !m.content.trim()) continue
    if (m.role === 'assistant' && m.speakerId === speaker.id) {
      flush()
      items.push({ role: 'model', text: m.content.trim() })
    } else {
      buffer.push(otherLine(m, cast, userName))
    }
  }
  flush()

  // Peel the prompt off the end: the trailing user turn is what the speaker
  // responds to. If the speaker spoke last (or the scene is empty), nudge them.
  let prompt: string
  let history: SceneTurn[]
  const last = items[items.length - 1]
  if (last && last.role === 'user') {
    prompt = last.text
    history = items.slice(0, -1)
  } else {
    prompt = items.length ? `(Continue the scene as ${speaker.name}.)` : `(You are ${speaker.name}. Open the scene.)`
    history = items
  }

  // Keep the seeded history user-first. On a speaker's 2nd+ beat their own prior
  // line leads as a `model` turn; some chat templates (e.g. Gemma, which folds the
  // system prompt into the first user turn) assume the first turn after system is
  // a user turn. A tiny cue turn keeps the structure valid without distorting content.
  if (history.length && history[0].role === 'model') {
    history = [{ role: 'user', text: '(The scene so far.)' }, ...history]
  }

  // Catch the model running on into another character's turn.
  const names = new Set<string>()
  for (const c of cast) if (c.id !== speaker.id) names.add(c.name)
  names.add(userName)
  const stopTriggers: string[] = []
  for (const n of names) {
    const t = n.trim()
    if (t) stopTriggers.push(`\n${t}:`)
  }

  return {
    system: buildSystem(speaker, cast, userCharacter, scenePremise),
    history,
    prompt,
    stopTriggers
  }
}

/**
 * Strip a leading "Name:" the model sometimes prepends to its own beat despite
 * the instruction not to. Applied when a beat finishes (the name is shown by the
 * UI from attribution, so a duplicated prefix is noise).
 */
export function stripSpeakerPrefix(text: string, speakerName: string | undefined): string {
  const name = speakerName?.trim()
  if (!name) return text
  // Escape regex metacharacters so names like "Bo (pilot)" don't break the match.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`^\\s*${escaped}\\s*:\\s*`, 'i'), '')
}
