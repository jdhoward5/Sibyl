import { EventEmitter } from 'node:events'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { InstalledVoice, PiperVoiceConfig, TtsEvent, TtsStatus, TtsVoiceDownload } from '@shared/tts'
import {
  findCatalogVoice,
  phonemesToIds,
  plainTextForSpeech,
  splitPhonemes,
  voiceAssetIntegrityError,
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

const MAX_TTS_MODEL_BYTES = 200 * 1024 * 1024
const MAX_TTS_CONFIG_BYTES = 1024 * 1024

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
      const stageDir = path.join(dir, '.staging', `${voice.id}-${randomUUID()}`)
      const stagedModel = path.join(stageDir, `${voice.id}.onnx`)
      const stagedConfig = path.join(stageDir, `${voice.id}.onnx.json`)
      await fs.mkdir(stageDir, { recursive: true })

      // Download and verify both immutable assets in an isolated staging
      // directory. Existing working files are untouched until both pass.
      await fetchToFile(
        voiceConfigUrl(voice),
        stagedConfig,
        token,
        controller.signal,
        {
          expectedBytes: voice.configSizeBytes,
          expectedSha256: voice.configSha256,
          maxBytes: MAX_TTS_CONFIG_BYTES
        }
      )
      const modelBytes = await fetchToFile(
        voiceModelUrl(voice),
        stagedModel,
        token,
        controller.signal,
        {
          expectedBytes: voice.sizeBytes,
          expectedSha256: voice.modelSha256,
          maxBytes: MAX_TTS_MODEL_BYTES
        },
        (received, total) => {
          job.progress.receivedBytes = received
          if (total > 0) job.progress.totalBytes = total
          this.emitVoiceProgress(job.progress)
        }
      )

      // Reject malformed JSON before it can replace a working config or reach
      // the ONNX loader.
      controller.signal.throwIfAborted()
      JSON.parse(await fs.readFile(stagedConfig, 'utf8'))
      await commitVoiceFiles(
        [
          { staged: stagedModel, destination: modelDest },
          { staged: stagedConfig, destination: configDest }
        ],
        stageDir
      )

      controller.signal.throwIfAborted()
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
    } finally {
      this.downloads.delete(voiceId)
      const dir = await getVoicesDir().catch(() => null)
      if (dir) {
        const stagingRoot = path.join(dir, '.staging')
        const entries = await fs.readdir(stagingRoot).catch(() => [])
        await Promise.all(
          entries
            .filter((name) => name.startsWith(`${voiceId}-`))
            .map((name) => fs.rm(path.join(stagingRoot, name), { recursive: true, force: true }).catch(() => {}))
        )
      }
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
    const catalogVoice = findCatalogVoice(voice.id)
    if (!catalogVoice) throw new Error('This installed voice is not in the reviewed catalog.')
    await Promise.all([
      verifyLocalVoiceAsset(
        voice.modelPath,
        catalogVoice.sizeBytes,
        catalogVoice.modelSha256,
        MAX_TTS_MODEL_BYTES
      ),
      verifyLocalVoiceAsset(
        voice.configPath,
        catalogVoice.configSizeBytes,
        catalogVoice.configSha256,
        MAX_TTS_CONFIG_BYTES
      )
    ])
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

interface DownloadIntegrity {
  expectedBytes: number
  expectedSha256: string
  maxBytes: number
}

/** Verify an installed asset before handing it to JSON/ONNX parsers. */
async function verifyLocalVoiceAsset(
  filePath: string,
  expectedBytes: number,
  expectedSha256: string,
  maxBytes: number
): Promise<void> {
  const hash = createHash('sha256')
  let actualBytes = 0
  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer
    actualBytes += buffer.length
    if (actualBytes > expectedBytes || actualBytes > maxBytes) {
      throw new Error('Installed voice asset exceeded its reviewed size.')
    }
    hash.update(buffer)
  }
  const error = voiceAssetIntegrityError(
    expectedBytes,
    expectedSha256,
    maxBytes,
    actualBytes,
    hash.digest('hex')
  )
  if (error) throw new Error(`Installed ${error.toLowerCase()}`)
}

/**
 * Replace a voice's model/config as one recoverable transaction. Existing
 * assets are moved to same-volume backups and restored if either rename fails.
 */
async function commitVoiceFiles(
  files: { staged: string; destination: string }[],
  stageDir: string
): Promise<void> {
  const backups: { destination: string; backup: string }[] = []
  const installed: string[] = []
  try {
    for (const { destination } of files) {
      try {
        await fs.access(destination)
      } catch {
        continue
      }
      const backup = path.join(stageDir, `${path.basename(destination)}.backup`)
      await fs.rename(destination, backup)
      backups.push({ destination, backup })
    }
    for (const { staged, destination } of files) {
      await fs.rename(staged, destination)
      installed.push(destination)
    }
    await Promise.all(backups.map(({ backup }) => fs.rm(backup, { force: true })))
  } catch (err) {
    await Promise.all(installed.map((destination) => fs.rm(destination, { force: true }).catch(() => {})))
    for (const { destination, backup } of backups.reverse()) {
      await fs.rename(backup, destination).catch(() => {})
    }
    throw err
  }
}

/**
 * Stream an immutable asset to a staging file with strict byte ceilings, exact
 * size verification, and SHA-256 verification before rename.
 */
async function fetchToFile(
  url: string,
  dest: string,
  token: string | null,
  signal: AbortSignal,
  integrity: DownloadIntegrity,
  onProgress?: (received: number, total: number) => void
): Promise<number> {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal
  })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`)
  const total = Number(res.headers.get('content-length')) || 0
  if (integrity.expectedBytes > integrity.maxBytes) {
    throw new Error('Voice asset exceeds the configured safety ceiling.')
  }
  if (total > integrity.maxBytes || (total > 0 && total !== integrity.expectedBytes)) {
    throw new Error('Voice asset response size did not match the reviewed catalog.')
  }
  const tmp = `${dest}.part`
  const out = createWriteStream(tmp)
  const hash = createHash('sha256')
  let received = 0
  try {
    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    for await (const chunk of nodeStream) {
      const buf = chunk as Buffer
      received += buf.length
      if (received > integrity.expectedBytes || received > integrity.maxBytes) {
        throw new Error('Voice asset exceeded its reviewed size.')
      }
      hash.update(buf)
      if (!out.write(buf)) await once(out, 'drain')
      onProgress?.(received, total)
    }
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    )
    const digest = hash.digest('hex')
    const integrityError = voiceAssetIntegrityError(
      integrity.expectedBytes,
      integrity.expectedSha256,
      integrity.maxBytes,
      received,
      digest
    )
    if (integrityError) throw new Error(integrityError)
    await fs.rename(tmp, dest)
    return received
  } catch (err) {
    out.destroy()
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

export const tts = new TtsEngine()
