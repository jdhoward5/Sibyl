import type { TtsEvent } from '@shared/tts'

// Web Audio playback for streamed Piper speech. The main process synthesizes a
// response sentence-by-sentence and streams Float32 PCM chunks over IPC; this
// player decodes each chunk into an AudioBuffer and schedules them back-to-back
// for gapless playback. It is the source of truth for which message is *audibly*
// speaking (synthesis in main finishes before playback does), so it drives the
// UI's speaking indicator via the onSpeakingChange callback.
//
// Renderer privacy invariant: no console.* anywhere in this file.

interface PlayerCallbacks {
  /** Called with the message id when audible speech starts, and null when it ends. */
  onSpeakingChange: (messageId: string | null) => void
}

class TtsPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private volume = 1

  private callbacks: PlayerCallbacks | null = null

  // The request whose audio we are currently scheduling. Chunks from any other
  // (superseded) request are ignored.
  private requestId: string | null = null
  private messageId: string | null = null
  private nextStartTime = 0
  private pending = 0
  private doneReceived = false
  private sources = new Set<AudioBufferSourceNode>()

  init(callbacks: PlayerCallbacks): void {
    this.callbacks = callbacks
  }

  /**
   * Create/resume the AudioContext. Must be called from within a user gesture
   * (a click, or the keypress that sends a message) so the browser's autoplay
   * policy lets audio start. Safe to call repeatedly.
   */
  ensureContext(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctor()
      this.gain = this.ctx.createGain()
      this.gain.gain.value = this.volume
      this.gain.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.gain) this.gain.gain.value = this.volume
  }

  /** Whether the given message (or any message, if omitted) is currently speaking. */
  isSpeaking(messageId?: string): boolean {
    if (!this.messageId) return false
    return messageId ? this.messageId === messageId : true
  }

  /** Handle a streaming synthesis event from the main process. */
  handleEvent(e: TtsEvent): void {
    switch (e.type) {
      case 'start':
        this.beginRequest(e.requestId, e.messageId)
        break
      case 'chunk':
        if (e.requestId !== this.requestId) return
        this.schedule(e.pcm, e.sampleRate)
        break
      case 'done':
        if (e.requestId !== this.requestId) return
        this.doneReceived = true
        this.maybeFinish()
        break
      case 'error':
        if (e.requestId !== this.requestId) return
        this.stop()
        break
    }
  }

  private beginRequest(requestId: string, messageId: string): void {
    // Tear down any prior request's audio before starting the new one.
    this.clearSources()
    this.ensureContext()
    this.requestId = requestId
    this.messageId = messageId
    this.doneReceived = false
    this.pending = 0
    this.nextStartTime = (this.ctx?.currentTime ?? 0) + 0.05
    this.callbacks?.onSpeakingChange(messageId)
  }

  private schedule(pcm: ArrayBuffer, sampleRate: number): void {
    if (!this.ctx || !this.gain) return
    const samples = new Float32Array(pcm)
    if (samples.length === 0) return
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate)
    buffer.copyToChannel(samples, 0)

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)

    const startAt = Math.max(this.nextStartTime, this.ctx.currentTime)
    source.start(startAt)
    this.nextStartTime = startAt + buffer.duration

    this.pending += 1
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      this.pending -= 1
      this.maybeFinish()
    }
  }

  /** When synthesis is done and all scheduled audio has finished, clear the indicator. */
  private maybeFinish(): void {
    if (this.doneReceived && this.pending <= 0) {
      this.requestId = null
      this.messageId = null
      this.callbacks?.onSpeakingChange(null)
    }
  }

  /** Stop playback immediately and clear the speaking indicator. */
  stop(): void {
    this.clearSources()
    this.requestId = null
    if (this.messageId !== null) {
      this.messageId = null
      this.callbacks?.onSpeakingChange(null)
    }
  }

  private clearSources(): void {
    for (const source of this.sources) {
      try {
        source.onended = null
        source.stop()
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear()
    this.pending = 0
    this.doneReceived = false
  }
}

export const ttsPlayer = new TtsPlayer()
