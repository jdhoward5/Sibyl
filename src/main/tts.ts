import { EventEmitter } from 'node:events'
import { createWriteStream, promises as fs } from 'node:fs'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { InstalledVoice, PiperVoiceConfig, TtsEvent, TtsStatus, TtsVoiceDownload } from '@shared/tts'
import {
  findCatalogVoice,
  phonemesToIds,
  plainTextForSpeech,
  splitPhonemes,
  voiceConfigUrl,
  voiceModelUrl
} from '@shared/tts'
import {
  getInstalledVoice,
  getSettings,
  getVoicesDir,
  removeInstalledVoice,
  upsertInstalledVoice
} from './store'

// onnxruntime-node ships native bindings and phonemizer carries a sizeable WASM
// payload; both are loaded lazily (and tolerantly) so the app still starts — with
// speech reported unavailable — on a build where the native module is missing.
type OrtModule = typeof import('onnxruntime-node')
type Phonemize = (text: string, language?: string) => Promise<string[]>

let ortPromise: Promise<OrtModule> | null = null
let phonemizePromise: Promise<Phonemize> | null = null

async function getOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-node').then((m) => {
      // onnxruntime-node is CommonJS; the interop default holds module.exports.
      const mod = ((m as unknown as { default?: OrtModule }).default ?? m) as OrtModule
      try {
        mod.env.logLevel = 'error'
      } catch {
        /* non-fatal */
      }
      return mod
    })
  }
  return ortPromise
}

async function getPhonemize(): Promise<Phonemize> {
  if (!phonemizePromise) {
    phonemizePromise = import('phonemizer').then(
      (m) => (m as unknown as { phonemize: Phonemize }).phonemize
    )
  }
  return phonemizePromise
}

/** A voice loaded into an ONNX session, with its parsed config. */
interface LoadedVoice {
  id: string
  session: import('onnxruntime-node').InferenceSession
  config: PiperVoiceConfig
  sampleRate: number
}

interface VoiceDownloadJob {
  controller: AbortController
  progress: TtsVoiceDownload
}

/**
 * On-device text-to-speech via Piper (VITS) ONNX voices. Owns one loaded voice
 * session at a time, synthesizes a response sentence-by-sentence, and streams the
 * resulting audio to the renderer as Float32 PCM chunks. Speech never leaves the
 * machine; like the LLM engine, nothing here is logged that could carry message
 * content (see CLAUDE.md → Privacy).
 */
class TtsEngine extends EventEmitter {
  private available: boolean | null = null
  private availabilityError: string | undefined
  private loaded: LoadedVoice | null = null

  private speakingMessageId: string | null = null
  private synthesizing = false

  // The active speak request. Serialized through `queue` so two requests never
  // run the model concurrently (which could dispose a session mid-inference).
  private current: { id: string; abort: AbortController } | null = null
  private queue: Promise<void> = Promise.resolve()

  private downloads = new Map<string, VoiceDownloadJob>()

  // -- availability / status -----------------------------------------------

  /** Probe (once) whether the native synth runtime can load. Memoized. */
  private async probeAvailability(): Promise<boolean> {
    if (this.available !== null) return this.available
    try {
      await getOrt()
      this.available = true
      this.availabilityError = undefined
    } catch (err) {
      this.available = false
      this.availabilityError =
        'On-device speech is unavailable in this build (the speech runtime failed to load).'
      void err
    }
    return this.available
  }

  async status(): Promise<TtsStatus> {
    const available = await this.probeAvailability()
    return {
      available,
      error: available ? undefined : this.availabilityError,
      speakingMessageId: this.speakingMessageId,
      synthesizing: this.synthesizing
    }
  }

  private async emitStatus(): Promise<void> {
    this.emit('status', await this.status())
  }

  private emitEvent(event: TtsEvent): void {
    this.emit('event', event)
  }

  private emitVoiceProgress(progress: TtsVoiceDownload): void {
    this.emit('voiceProgress', { ...progress })
  }

  // -- voice download / management -----------------------------------------

  /**
   * Download a catalog voice's model + config from Hugging Face into the voices
   * directory and register it. Idempotent per voice id while a download is live.
   */
  async downloadVoice(voiceId: string): Promise<void> {
    if (this.downloads.has(voiceId)) return
    const voice = findCatalogVoice(voiceId)
    if (!voice) throw new Error(`Unknown voice: ${voiceId}`)

    const controller = new AbortController()
    const job: VoiceDownloadJob = {
      controller,
      progress: { voiceId, status: 'downloading', receivedBytes: 0, totalBytes: voice.sizeBytes }
    }
    this.downloads.set(voiceId, job)
    this.emitVoiceProgress(job.progress)

    try {
      const dir = await getVoicesDir()
      const settings = await getSettings()
      const token = settings.hfToken
      const modelDest = path.join(dir, `${voice.id}.onnx`)
      const configDest = path.join(dir, `${voice.id}.onnx.json`)

      // The config is tiny; fetch it first so a bad voice fails fast and cheap.
      await fetchToFile(voiceConfigUrl(voice), configDest, token, controller.signal)
      const modelBytes = await fetchToFile(
        voiceModelUrl(voice),
        modelDest,
        token,
        controller.signal,
        (received, total) => {
          job.progress.receivedBytes = received
          if (total > 0) job.progress.totalBytes = total
          this.emitVoiceProgress(job.progress)
        }
      )

      await upsertInstalledVoice({
        id: voice.id,
        name: voice.name,
        language: voice.language,
        quality: voice.quality,
        modelPath: modelDest,
        configPath: configDest,
        sizeBytes: modelBytes || voice.sizeBytes,
        installedAt: new Date().toISOString()
      })

      job.progress.status = 'completed'
      job.progress.receivedBytes = modelBytes || job.progress.receivedBytes
      this.emitVoiceProgress(job.progress)
    } catch (err) {
      const aborted = controller.signal.aborted
      job.progress.status = aborted ? 'cancelled' : 'error'
      if (!aborted) job.progress.error = err instanceof Error ? err.message : String(err)
      this.emitVoiceProgress(job.progress)
      // Clean partial files so a retry starts fresh.
      await this.removeVoiceFiles(voiceId).catch(() => {})
    } finally {
      this.downloads.delete(voiceId)
    }
  }

  cancelVoiceDownload(voiceId: string): void {
    this.downloads.get(voiceId)?.controller.abort()
  }

  listVoiceDownloads(): TtsVoiceDownload[] {
    return [...this.downloads.values()].map((j) => ({ ...j.progress }))
  }

  /** Remove a downloaded voice's files and registry entry. */
  async deleteVoice(voiceId: string): Promise<void> {
    if (this.loaded?.id === voiceId) {
      await this.releaseSession()
    }
    // Delete the exact files the registry recorded (absolute paths we wrote from
    // a catalog id) rather than reconstructing a path from the caller-supplied id —
    // a no-match id removes nothing instead of risking a path outside the voices dir.
    const removed = await removeInstalledVoice(voiceId)
    if (removed) {
      await Promise.all(
        [removed.modelPath, removed.configPath].map((f) => fs.rm(f, { force: true }).catch(() => {}))
      )
    }
  }

  /** Remove a catalog voice's files from the voices dir (used to clean a failed download). */
  private async removeVoiceFiles(voiceId: string): Promise<void> {
    const dir = await getVoicesDir()
    await Promise.all(
      [`${voiceId}.onnx`, `${voiceId}.onnx.json`, `${voiceId}.onnx.part`, `${voiceId}.onnx.json.part`].map(
        (f) => fs.rm(path.join(dir, f), { force: true }).catch(() => {})
      )
    )
  }

  // -- synthesis ------------------------------------------------------------

  private async releaseSession(): Promise<void> {
    const loaded = this.loaded
    this.loaded = null
    if (loaded) {
      try {
        await loaded.session.release()
      } catch {
        /* ignore */
      }
    }
  }

  /** Load (or reuse) a voice's ONNX session + config. */
  private async loadVoice(voice: InstalledVoice): Promise<LoadedVoice> {
    if (this.loaded?.id === voice.id) return this.loaded
    await this.releaseSession()
    const ort = await getOrt()
    const configRaw = await fs.readFile(voice.configPath, 'utf8')
    const config = JSON.parse(configRaw) as PiperVoiceConfig
    const session = await ort.InferenceSession.create(voice.modelPath, {
      executionProviders: ['cpu']
    })
    this.loaded = {
      id: voice.id,
      session,
      config,
      sampleRate: config.audio?.sample_rate ?? 22050
    }
    return this.loaded
  }

  /** Synthesize one already-phonemized sentence into mono Float32 PCM. */
  private async synthesizePhonemes(lv: LoadedVoice, phonemeStr: string, rate: number): Promise<Float32Array> {
    const ids = phonemesToIds(splitPhonemes(phonemeStr), lv.config.phoneme_id_map)
    if (ids.length === 0) return new Float32Array(0)

    const ort = await getOrt()
    const inf = lv.config.inference ?? { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 }
    // rate > 1 ⇒ faster speech ⇒ smaller length_scale.
    const lengthScale = inf.length_scale / (rate > 0 ? rate : 1)

    const feeds: Record<string, import('onnxruntime-node').Tensor> = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor(
        'float32',
        Float32Array.from([inf.noise_scale, lengthScale, inf.noise_w]),
        [3]
      )
    }
    if ((lv.config.num_speakers ?? 1) > 1) {
      feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1])
    }

    const results = await lv.session.run(feeds)
    const outName = lv.session.outputNames[0]
    const out = results[outName]
    return out.data as Float32Array
  }

  /**
   * Speak a message's text with the configured (or given) voice. Returns once the
   * request is fully synthesized or stopped. Serialized: a new request aborts the
   * previous one and waits for it to unwind before running the model.
   */
  speak(messageId: string, text: string, opts?: { voiceId?: string; rate?: number }): Promise<void> {
    // Signal any in-flight request to stop, then chain behind it so the model is
    // never run by two requests at once.
    this.current?.abort.abort()
    const run = this.queue.then(() => this.runSpeak(messageId, text, opts))
    this.queue = run.catch(() => {})
    return run
  }

  private async runSpeak(
    messageId: string,
    text: string,
    opts?: { voiceId?: string; rate?: number }
  ): Promise<void> {
    const requestId = randomUUID()
    const abort = new AbortController()
    this.current = { id: requestId, abort }

    if (!(await this.probeAvailability())) {
      this.emitEvent({ type: 'error', requestId, messageId, error: this.availabilityError ?? 'Speech unavailable.' })
      if (this.current?.id === requestId) this.current = null
      return
    }

    const settings = await getSettings()
    const voiceId = opts?.voiceId ?? settings.tts.voiceId
    const rate = opts?.rate ?? settings.tts.rate ?? 1
    const voice = voiceId ? await getInstalledVoice(voiceId) : null
    if (!voice) {
      this.emitEvent({ type: 'error', requestId, messageId, error: 'No voice is installed. Add one in Settings.' })
      if (this.current?.id === requestId) this.current = null
      return
    }

    this.speakingMessageId = messageId
    this.synthesizing = true
    void this.emitStatus()

    try {
      const lv = await this.loadVoice(voice)
      this.emitEvent({ type: 'start', requestId, messageId, sampleRate: lv.sampleRate })

      const spoken = plainTextForSpeech(text)
      if (spoken.trim()) {
        const phonemize = await getPhonemize()
        const espeakVoice = lv.config.espeak?.voice ?? 'en-us'
        const sentences = await phonemize(spoken, espeakVoice)
        let seq = 0
        for (const sentence of sentences) {
          if (abort.signal.aborted) break
          const pcm = await this.synthesizePhonemes(lv, sentence, rate)
          if (abort.signal.aborted) break
          if (pcm.length > 0) {
            this.emitEvent({
              type: 'chunk',
              requestId,
              messageId,
              seq: seq++,
              sampleRate: lv.sampleRate,
              // Copy out of the ORT-owned buffer into a standalone ArrayBuffer for IPC.
              pcm: pcm.slice().buffer
            })
          }
        }
      }
      this.emitEvent({ type: 'done', requestId, messageId })
    } catch (err) {
      if (abort.signal.aborted) {
        this.emitEvent({ type: 'done', requestId, messageId })
      } else {
        this.emitEvent({
          type: 'error',
          requestId,
          messageId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    } finally {
      if (this.current?.id === requestId) {
        this.current = null
        this.speakingMessageId = null
        this.synthesizing = false
        void this.emitStatus()
      }
    }
  }

  /** Stop the current request (if any). The in-flight runSpeak unwinds gracefully. */
  stop(): void {
    this.current?.abort.abort()
  }

  /** Full teardown for app exit: stop speech, cancel downloads, release the session. */
  async dispose(): Promise<void> {
    this.stop()
    for (const job of this.downloads.values()) job.controller.abort()
    try {
      await this.queue
    } catch {
      /* ignore */
    }
    await this.releaseSession()
  }
}

/**
 * Stream an HTTP response to a file with progress, via a `.part` temp that is
 * renamed on success. Cleans up the temp on error/abort.
 */
async function fetchToFile(
  url: string,
  dest: string,
  token: string | null,
  signal: AbortSignal,
  onProgress?: (received: number, total: number) => void
): Promise<number> {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal
  })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`)
  const total = Number(res.headers.get('content-length')) || 0
  const tmp = `${dest}.part`
  const out = createWriteStream(tmp)
  let received = 0
  try {
    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    for await (const chunk of nodeStream) {
      const buf = chunk as Buffer
      received += buf.length
      if (!out.write(buf)) await once(out, 'drain')
      onProgress?.(received, total)
    }
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    )
    await fs.rename(tmp, dest)
    return received
  } catch (err) {
    out.destroy()
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export const tts = new TtsEngine()
