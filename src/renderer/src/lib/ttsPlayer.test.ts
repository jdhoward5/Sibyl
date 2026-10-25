import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TtsPlayer } from './ttsPlayer'

type FakeSource = {
  buffer: unknown
  connect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  onended: (() => void) | null
}

let player: TtsPlayer
let sources: FakeSource[]
let speaking: ReturnType<typeof vi.fn<(messageId: string | null) => void>>

beforeEach(() => {
  sources = []
  speaking = vi.fn<(messageId: string | null) => void>()
  vi.stubGlobal('window', {
    AudioContext: class {
      state = 'running'
      currentTime = 0
      destination = {}
      createGain(): { gain: { value: number }; connect: () => void } {
        return { gain: { value: 1 }, connect: vi.fn() }
      }
      createBuffer(_channels: number, length: number, sampleRate: number): unknown {
        return { duration: length / sampleRate, copyToChannel: vi.fn() }
      }
      createBufferSource(): FakeSource {
        const source: FakeSource = {
          buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null
        }
        sources.push(source)
        return source
      }
    }
  })
  player = new TtsPlayer()
  player.init({ onSpeakingChange: speaking })
})

afterEach(() => {
  player.stop()
  vi.unstubAllGlobals()
})

function start(messageId: string, requestId = messageId): void {
  player.handleEvent({ type: 'start', messageId, requestId, sampleRate: 22050 })
}

function chunk(messageId: string, requestId = messageId): void {
  player.handleEvent({
    type: 'chunk', messageId, requestId, seq: 0, sampleRate: 22050,
    pcm: new Float32Array([0, 0.1, 0]).buffer
  })
}

describe('speech playback request cancellation', () => {
  it('ignores a delayed start after Stop, even if a later gesture prewarms audio', () => {
    player.prepareForSpeech('stopped')
    player.stop()
    player.ensureContext()
    start('stopped')
    chunk('stopped')

    expect(player.isSpeaking()).toBe(false)
    expect(sources).toHaveLength(0)
    expect(speaking).not.toHaveBeenCalled()
  })

  it('replaces current audio and ignores starts and chunks belonging to the old message', () => {
    player.prepareForSpeech('old')
    start('old')
    chunk('old')
    player.prepareForSpeech('new')
    start('old', 'late-old-request')
    start('new')
    chunk('old')
    chunk('new')

    expect(sources).toHaveLength(2)
    expect(sources[0].stop).toHaveBeenCalledOnce()
    expect(player.isSpeaking('new')).toBe(true)
    expect(speaking.mock.calls.map(([messageId]) => messageId)).toEqual(['old', 'new'])
  })

  it('keeps playback active until queued audio ends, then requires a new local request', () => {
    player.prepareForSpeech('message')
    start('message')
    chunk('message')
    player.handleEvent({ type: 'done', messageId: 'message', requestId: 'message' })
    expect(player.isSpeaking('message')).toBe(true)
    sources[0].onended?.()
    expect(player.isSpeaking()).toBe(false)

    start('message', 'late-request')
    chunk('message', 'late-request')
    expect(sources).toHaveLength(1)
    expect(speaking.mock.calls.map(([messageId]) => messageId)).toEqual(['message', null])
  })

  it('allows an explicit retry of the same message after stop', () => {
    player.prepareForSpeech('message')
    start('message', 'first-request')
    chunk('message', 'first-request')
    player.stop()
    player.prepareForSpeech('message')
    start('message', 'retry-request')
    chunk('message', 'retry-request')
    player.handleEvent({ type: 'done', messageId: 'message', requestId: 'first-request' })

    expect(player.isSpeaking('message')).toBe(true)
    expect(sources).toHaveLength(2)
    expect(sources[0].stop).toHaveBeenCalledOnce()
    expect(sources[1].start).toHaveBeenCalledOnce()
  })

  it.each(['old', 'new'])('accepts a prepared replacement (%s) after old audio finishes', (replacement) => {
    player.prepareForSpeech('old')
    start('old')
    chunk('old')
    player.handleEvent({ type: 'done', messageId: 'old', requestId: 'old' })
    player.prepareForSpeech(replacement)
    sources[0].onended?.()
    start(replacement, 'replacement-request')
    chunk(replacement, 'replacement-request')

    expect(player.isSpeaking(replacement)).toBe(true)
    expect(sources).toHaveLength(2)
  })

  it('accepts a same-message replacement when old synthesis finishes after preparation', () => {
    player.prepareForSpeech('message')
    start('message', 'old-request')
    chunk('message', 'old-request')
    sources[0].onended?.()

    player.prepareForSpeech('message')
    player.handleEvent({ type: 'done', messageId: 'message', requestId: 'old-request' })
    start('message', 'replacement-request')
    chunk('message', 'replacement-request')

    expect(player.isSpeaking('message')).toBe(true)
    expect(sources).toHaveLength(2)
    expect(sources[1].start).toHaveBeenCalledOnce()
  })
})
