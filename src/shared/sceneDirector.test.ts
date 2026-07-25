import { describe, expect, it } from 'vitest'
import type { Conversation, Persona } from './types'
import { deterministicDirectorDecision, parseDirectorOutput } from './sceneDirector'

const persona = (id: string): Persona => ({
  id,
  name: id.toUpperCase(),
  role: '',
  brief: '',
  avatar: { monogram: id, gradient: ['#000', '#111'] },
  voiceTags: []
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

describe('strict scene director output', () => {
  it('accepts a valid cast speaker and terminal actions', () => {
    expect(
      parseDirectorOutput(
        '{"action":"continue","speakerId":"b","intent":"Bo has the strongest response."}',
        new Set(['a', 'b'])
      )
    ).toMatchObject({ action: 'continue', speakerId: 'b' })
    expect(
      parseDirectorOutput('{"action":"end","intent":"The goal is resolved."}', new Set(['a', 'b']))
    ).toMatchObject({ action: 'end', speakerId: undefined })
  })

  it.each([
    '{"action":"continue","speakerId":"outsider","intent":"bad"}',
    '{"action":"pause","speakerId":"a","intent":"bad"}',
    '{"action":"continue","speakerId":"a","intent":"ok","extra":true}',
    '{"action":"continue","speakerId":"a","intent":""}',
    'Here is the decision: {"action":"continue","speakerId":"a","intent":"ok"}',
    'not json'
  ])('rejects adversarial output: %s', (output) => {
    expect(() => parseDirectorOutput(output, new Set(['a', 'b']))).toThrow()
  })
})

describe('deterministic director policy', () => {
  it('ends on an explicit terminal marker without model inference', () => {
    const decision = deterministicDirectorDecision({
      conversation: conversation({
        messages: [{ id: 'm', role: 'assistant', content: 'Curtain. [END SCENE]', createdAt: '' }]
      }),
      cast: [persona('a'), persona('b')],
      fallbackSpeakerId: 'a'
    })
    expect(decision).toMatchObject({ action: 'end', usedModel: false })
  })

  it('pauses when the transcript explicitly hands control to the human', () => {
    const decision = deterministicDirectorDecision({
      conversation: conversation({
        messages: [{
          id: 'm',
          role: 'assistant',
          content: 'Your move. [WAIT FOR HUMAN]',
          createdAt: ''
        }]
      }),
      cast: [persona('a'), persona('b')],
      fallbackSpeakerId: 'a'
    })
    expect(decision).toMatchObject({
      action: 'pause',
      fallbackReason: 'pending-human',
      usedModel: false
    })
  })

  it('prioritizes an unresolved targeted direction', () => {
    const decision = deterministicDirectorDecision({
      conversation: conversation({
        directions: [{
          id: 'd',
          content: 'Bo answers.',
          target: { kind: 'speaker', speakerId: 'b' },
          scope: 'next-beat',
          enabled: true,
          createdAt: ''
        }]
      }),
      cast: [persona('a'), persona('b')],
      fallbackSpeakerId: 'a'
    })
    expect(decision).toMatchObject({ action: 'continue', speakerId: 'b', usedModel: false })
  })

  it('returns null when the optional model may decide', () => {
    expect(
      deterministicDirectorDecision({
        conversation: conversation(),
        cast: [persona('a'), persona('b')],
        fallbackSpeakerId: 'a'
      })
    ).toBeNull()
  })
})
