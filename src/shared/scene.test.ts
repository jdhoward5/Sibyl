import { describe, it, expect } from 'vitest'
import {
  isScene,
  sceneCast,
  nextSpeakerId,
  buildBeatPrompt,
  stripSpeakerPrefix,
  userDisplayName
} from './scene'
import type { ChatMessage, Conversation, Persona } from './types'

const persona = (id: string, name: string, extra: Partial<Persona> = {}): Persona => ({
  id,
  name,
  role: extra.role ?? '',
  brief: extra.brief ?? `${name}'s brief.`,
  avatar: { monogram: name.slice(0, 2).toUpperCase(), gradient: ['#000', '#fff'] },
  voiceTags: [],
  ...extra
})

const A = persona('a', 'Ada', { role: 'engineer', brief: 'You are Ada.' })
const B = persona('b', 'Bo', { role: 'pilot', brief: 'You are Bo.' })
const C = persona('c', 'Cy')
const PERSONAS = [A, B, C]

const beat = (speaker: Persona, content: string): ChatMessage => ({
  id: `m-${Math.random()}`,
  role: 'assistant',
  content,
  createdAt: '',
  speakerId: speaker.id,
  speakerName: speaker.name
})
const userTurn = (content: string): ChatMessage => ({ id: `u-${Math.random()}`, role: 'user', content, createdAt: '' })
const director = (content: string): ChatMessage => ({
  id: `d-${Math.random()}`,
  role: 'user',
  content,
  createdAt: '',
  director: true
})

const conv = (cast: string[], messages: ChatMessage[] = []): Conversation => ({
  id: 'c',
  title: 't',
  modelId: null,
  messages,
  createdAt: '',
  updatedAt: '',
  cast
})

describe('isScene', () => {
  it('needs a cast of at least two', () => {
    expect(isScene(undefined)).toBe(false)
    expect(isScene({ cast: [] })).toBe(false)
    expect(isScene({ cast: ['a'] })).toBe(false)
    expect(isScene({ cast: ['a', 'b'] })).toBe(true)
  })
})

describe('sceneCast', () => {
  it('resolves ids in order and drops missing/duplicate personas', () => {
    expect(sceneCast(conv(['b', 'a', 'zzz', 'b']), PERSONAS).map((p) => p.id)).toEqual(['b', 'a'])
  })
})

describe('nextSpeakerId', () => {
  it('starts with the first cast member when no one has spoken', () => {
    expect(nextSpeakerId(conv(['a', 'b', 'c']), PERSONAS)).toBe('a')
  })
  it('round-robins after the last speaker', () => {
    expect(nextSpeakerId(conv(['a', 'b', 'c'], [beat(A, 'hi')]), PERSONAS)).toBe('b')
    expect(nextSpeakerId(conv(['a', 'b', 'c'], [beat(A, 'hi'), beat(B, 'yo')]), PERSONAS)).toBe('c')
  })
  it('wraps around to the start', () => {
    expect(nextSpeakerId(conv(['a', 'b'], [beat(A, 'x'), beat(B, 'y')]), PERSONAS)).toBe('a')
  })
  it('ignores user turns and falls back when the last speaker left the cast', () => {
    expect(nextSpeakerId(conv(['a', 'b'], [beat(C, 'gone'), userTurn('hey')]), PERSONAS)).toBe('a')
  })
  it('returns null when the cast cannot be resolved', () => {
    expect(nextSpeakerId(conv(['zzz', 'yyy']), PERSONAS)).toBeNull()
  })
})

describe('userDisplayName', () => {
  it('uses the character name or defaults to You', () => {
    expect(userDisplayName({ name: 'Rae', description: '' })).toBe('Rae')
    expect(userDisplayName(undefined)).toBe('You')
    expect(userDisplayName({ name: '  ', description: 'x' })).toBe('You')
  })
})

describe('buildBeatPrompt', () => {
  const cast = [A, B]

  it('opens the scene with a nudge when empty', () => {
    const r = buildBeatPrompt({ messages: [], speaker: A, cast })
    expect(r.history).toEqual([])
    expect(r.prompt).toBe('(You are Ada. Open the scene.)')
  })

  it('puts the speaker brief first and lists the roster', () => {
    const r = buildBeatPrompt({ messages: [], speaker: A, cast })
    expect(r.system.startsWith('You are Ada.')).toBe(true)
    expect(r.system).toContain('- Ada (you) — engineer')
    expect(r.system).toContain('- Bo — pilot')
  })

  it("maps the speaker's own beats to unprefixed model turns and others to prefixed user turns", () => {
    const messages = [beat(A, 'Ready.'), beat(B, 'Hold on.')]
    const r = buildBeatPrompt({ messages, speaker: A, cast })
    // From Ada's POV: her line is a model turn; Bo's line is the trailing prompt.
    // A leading user cue keeps the history user-first (see user-first test below).
    expect(r.history).toEqual([
      { role: 'user', text: '(The scene so far.)' },
      { role: 'model', text: 'Ready.' }
    ])
    expect(r.prompt).toBe('Bo: Hold on.')
  })

  it('coalesces consecutive other-speaker lines into one user turn', () => {
    const messages = [beat(A, 'One.'), beat(B, 'Two.'), beat(C, 'Three.')]
    const r = buildBeatPrompt({ messages, speaker: A, cast: [A, B, C] })
    expect(r.history).toEqual([
      { role: 'user', text: '(The scene so far.)' },
      { role: 'model', text: 'One.' }
    ])
    expect(r.prompt).toBe('Bo: Two.\nCy: Three.')
  })

  it('keeps the seeded history user-first (never leads with a model turn)', () => {
    // Ada speaks twice in a row -> her two lines would lead as model turns.
    const messages = [beat(A, 'First.'), beat(A, 'Second.')]
    const r = buildBeatPrompt({ messages, speaker: A, cast })
    expect(r.history[0]).toEqual({ role: 'user', text: '(The scene so far.)' })
    expect(r.history.every((t, i) => i === 0 || t.role === 'model')).toBe(true)
  })

  it('nudges to continue when the speaker spoke last', () => {
    const messages = [beat(B, 'Go.'), beat(A, 'Done.')]
    const r = buildBeatPrompt({ messages, speaker: A, cast })
    expect(r.history).toEqual([{ role: 'user', text: 'Bo: Go.' }, { role: 'model', text: 'Done.' }])
    expect(r.prompt).toBe('(Continue the scene as Ada.)')
  })

  it('formats the human turn with their character name and director notes inline', () => {
    const messages = [userTurn('What now?'), director('raise the stakes')]
    const r = buildBeatPrompt({
      messages,
      speaker: A,
      cast,
      userCharacter: { name: 'Rae', description: 'the captain' }
    })
    expect(r.prompt).toBe('Rae: What now?\n[Director: raise the stakes]')
    expect(r.system).toContain('- Rae (the human participant) — the captain')
  })

  it('skips empty (streaming placeholder) messages', () => {
    const messages = [beat(B, 'Hi.'), beat(A, '')]
    const r = buildBeatPrompt({ messages, speaker: A, cast })
    expect(r.prompt).toBe('Bo: Hi.')
    expect(r.history).toEqual([])
  })

  it('emits stop triggers for the other characters and the human', () => {
    const r = buildBeatPrompt({
      messages: [],
      speaker: A,
      cast,
      userCharacter: { name: 'Rae', description: '' }
    })
    expect(r.stopTriggers).toContain('\nBo:')
    expect(r.stopTriggers).toContain('\nRae:')
    expect(r.stopTriggers).not.toContain('\nAda:')
  })
})

describe('stripSpeakerPrefix', () => {
  it('removes a leading self-name prefix, case-insensitively', () => {
    expect(stripSpeakerPrefix('Ada: hello there', 'Ada')).toBe('hello there')
    expect(stripSpeakerPrefix('ada:  hi', 'Ada')).toBe('hi')
  })
  it('leaves other text untouched', () => {
    expect(stripSpeakerPrefix('hello there', 'Ada')).toBe('hello there')
    expect(stripSpeakerPrefix('Bo: hi', 'Ada')).toBe('Bo: hi')
  })
  it('handles names with regex metacharacters safely', () => {
    expect(stripSpeakerPrefix('Bo (pilot): ready', 'Bo (pilot)')).toBe('ready')
    expect(stripSpeakerPrefix('[Unit]: go', '[Unit]')).toBe('go')
  })
})
