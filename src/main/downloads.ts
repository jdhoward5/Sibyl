import { EventEmitter } from 'node:events'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { DownloadProgress, InstalledModel } from '@shared/types'
import { formatBytes, modelIdFor, parseParamLabel, parseQuant } from '@shared/format'
import { canonicalGgufFilename, ggufShardFilenames } from '@shared/modelFiles'
import { SerialQueue } from '@shared/serial'
import { getRepoGgufFiles, type RepoFileInfo } from './hf'
import { nlc } from './llama'
import {
  getInstalledModel,
  getModelsDir,
  getSettings,
  listInstalledModels,
  removeInstalledModel,
  upsertInstalledModel
} from './store'

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function modelGroupPath(file: string): string {
  const resolved = canonicalGgufFilename(path.resolve(file))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Resolve one GGUF path to its exact multipart shard group, if applicable. */
export async function resolveModelShardFiles(finalPath: string): Promise<string[]> {
  const base = path.basename(finalPath)
  const dir = path.dirname(finalPath)
  const match = base.match(/^(.*)-\d{5}-of-(\d{5})\.gguf$/i)
  if (!match) return [finalPath]
  const re = new RegExp(`^${escapeRegExp(match[1])}-\\d{5}-of-${match[2]}\\.gguf$`, 'i')
  try {
    const shards = (await fs.readdir(dir))
      .filter((file) => re.test(file))
      .map((file) => path.join(dir, file))
    return shards.length ? shards : [finalPath]
  } catch {
    return [finalPath]
  }
}

/**
 * Stream a file through SHA-256, returning the lowercase hex digest and byte
 * count. Reports bytes hashed for progress and aborts promptly via `signal`.
 */
function sha256File(
  filePath: string,
  signal: AbortSignal,
  onProgress: (bytesHashed: number) => void
): Promise<{ hex: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Verification aborted.'))
      return
    }
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    let bytes = 0
    const onAbort = (): void => {
      stream.destroy()
      reject(new Error('Verification aborted.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => {
      hash.update(chunk)
      bytes += chunk.length
      onProgress(bytes)
    })
    stream.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    stream.on('end', () => {
      signal.removeEventListener('abort', onAbort)
      resolve({ hex: hash.digest('hex'), bytes })
    })
  })
}

interface ActiveDownload {
  progress: DownloadProgress
  controller: AbortController
  /** Whether to SHA-256 the result against HF's checksum (size check always runs). */
  verifyChecksum: boolean
  // smoothing state
  lastBytes: number
  lastTime: number
  smoothedSpeed: number
}

/**
 * Manages resumable GGUF downloads from Hugging Face using node-llama-cpp's
 * downloader (which handles multi-part GGUFs and resume), while exposing
 * smoothed progress + cancellation and registering finished models.
 */
export class DownloadManager extends EventEmitter {
  private active = new Map<string, ActiveDownload>()

  list(): DownloadProgress[] {
    return [...this.active.values()].map((d) => d.progress)
  }

  private emitProgress(d: ActiveDownload): void {
    this.emit('progress', { ...d.progress })
  }

  async start(repoId: string, filename: string): Promise<{ id: string }> {
    filename = canonicalGgufFilename(filename)
    const id = modelIdFor(repoId, filename)
    if (this.active.has(id)) return { id }

    const controller = new AbortController()

    const entry: ActiveDownload = {
      progress: {
        id,
        repoId,
        filename,
        status: 'queued',
        receivedBytes: 0,
        totalBytes: 0,
        speed: 0,
        etaSeconds: null
      },
      controller,
      verifyChecksum: true,
      lastBytes: 0,
      lastTime: Date.now(),
      smoothedSpeed: 0
    }
    this.active.set(id, entry)
    this.emitProgress(entry)

    // Kick off asynchronously; callers get the id immediately.
    void this.run(entry, repoId, filename).catch((err) => {
      // `run` is defensive and normally consumes failures. This terminal catch
      // guarantees a future refactor cannot create an unhandled rejection.
      entry.progress.status = 'error'
      entry.progress.error = err instanceof Error ? err.message : String(err)
      this.emitProgress(entry)
      this.active.delete(id)
    })
    return { id }
  }

  private async run(
    entry: ActiveDownload,
    repoId: string,
    filename: string
  ): Promise<void> {
    try {
      // Keep every asynchronous setup step inside this handler so native import,
      // settings, metadata, and directory failures all reach a terminal state.
      const [{ createModelDownloader }, modelsDir, settings, fileInfo] = await Promise.all([
        nlc(),
        getModelsDir(),
        getSettings(),
        getRepoGgufFiles(repoId)
      ])
      entry.controller.signal.throwIfAborted()
      entry.verifyChecksum = settings.verifyDownloads
      // Pre-flight: refuse before writing anything if the volume lacks room, so the
      // user gets a clear message instead of an ENOSPC failure partway through.
      await this.ensureDiskSpace(modelsDir, fileInfo, filename)
      entry.controller.signal.throwIfAborted()

      entry.progress.status = 'downloading'
      this.emitProgress(entry)

      const downloader = await createModelDownloader({
        modelUri: `hf:${repoId}/${filename}`,
        dirPath: modelsDir,
        headers: settings.hfToken ? { Authorization: `Bearer ${settings.hfToken}` } : undefined,
        showCliProgress: false,
        deleteTempFileOnCancel: false, // keep partial data so resume works
        onProgress: ({ totalSize, downloadedSize }) => {
          this.updateProgress(entry, downloadedSize, totalSize)
        }
      })

      const modelPath = await downloader.download({ signal: entry.controller.signal })
      entry.controller.signal.throwIfAborted()

      entry.progress.status = 'verifying'
      this.emitProgress(entry)

      const finalPath = modelPath ?? path.join(modelsDir, filename)
      // Confirm the bytes that landed on disk match what we expected to fetch,
      // then (if enabled) that their SHA-256 matches HF's published checksum.
      // A failed check rejects the download. Cleanup removes only unregistered
      // files: skipExisting may have reused a model already in the library.
      // The downloader prefixes local names with the HF repository identity.
      // Match the remote and local shard lists by position, never by basename.
      const remoteFiles = ggufShardFilenames(filename)
      const localFiles = ggufShardFilenames(finalPath)
      if (remoteFiles.length !== localFiles.length) {
        const cleanup = await this.cleanupRejectedDownload(finalPath)
        throw new Error(`The downloaded GGUF shard group does not match the requested model. ${cleanup}`)
      }
      const expectedFiles = remoteFiles.map((remote, index) => ({
        path: localFiles[index],
        info: fileInfo.get(remote)
      }))
      const { verified, verifiedBy, actualBytes } = await this.verifyIntegrity(
        entry,
        finalPath,
        this.expectedBytesFor(fileInfo, filename) || entry.progress.totalBytes,
        expectedFiles
      )
      entry.controller.signal.throwIfAborted()
      try {
        await this.register(repoId, filename, finalPath, actualBytes, verified, verifiedBy)
      } catch (err) {
        // Remove a new unregistered download, but retain files reused by an
        // existing library entry (including legacy shard aliases/local imports).
        await this.cleanupRejectedDownload(finalPath)
        throw err
      }

      entry.progress.status = 'completed'
      entry.progress.receivedBytes = entry.progress.totalBytes || entry.progress.receivedBytes
      this.emitProgress(entry)
    } catch (err) {
      if (entry.controller.signal.aborted) {
        entry.progress.status = 'cancelled'
      } else {
        entry.progress.status = 'error'
        entry.progress.error = err instanceof Error ? err.message : String(err)
      }
      this.emitProgress(entry)
    } finally {
      // Keep terminal state briefly visible, then drop from the active map.
      const id = entry.progress.id
      setTimeout(() => this.active.delete(id), 1500)
    }
  }

  private updateProgress(entry: ActiveDownload, downloaded: number, total: number): void {
    const now = Date.now()
    const dt = (now - entry.lastTime) / 1000
    if (dt >= 0.25) {
      const instSpeed = (downloaded - entry.lastBytes) / dt
      // Exponential moving average for a stable readout.
      entry.smoothedSpeed = entry.smoothedSpeed === 0 ? instSpeed : entry.smoothedSpeed * 0.7 + instSpeed * 0.3
      entry.lastBytes = downloaded
      entry.lastTime = now
    }
    entry.progress.receivedBytes = downloaded
    entry.progress.totalBytes = total
    entry.progress.speed = Math.max(0, entry.smoothedSpeed)
    const remaining = total - downloaded
    entry.progress.etaSeconds =
      entry.smoothedSpeed > 0 && remaining > 0 ? remaining / entry.smoothedSpeed : null
    this.emitProgress(entry)
  }

  private async register(
    repoId: string,
    filename: string,
    filePath: string,
    sizeBytes: number,
    verified: boolean,
    verifiedBy?: 'size' | 'sha256'
  ): Promise<void> {
    const model: InstalledModel = {
      id: modelIdFor(repoId, filename),
      repoId,
      filename,
      path: filePath,
      sizeBytes,
      quant: parseQuant(filename),
      paramLabel: parseParamLabel(filename) ?? parseParamLabel(repoId),
      verified,
      verifiedBy,
      installedAt: new Date().toISOString()
    }
    await upsertInstalledModel(model)
  }

  /**
   * Verify a finished download: first that on-disk bytes match the expected total
   * (the size the downloader reported), then — when enabled and HF published
   * checksums for every file — that each file's SHA-256 matches. Returns the
   * measured byte total and how it was verified. Rejects missing/empty files,
   * size mismatches, and checksum mismatches; preserves existing library files.
   */
  private async verifyIntegrity(
    entry: ActiveDownload,
    finalPath: string,
    expectedBytes: number,
    expectedFiles: { path: string; info: RepoFileInfo | undefined }[]
  ): Promise<{ verified: boolean; verifiedBy?: 'size' | 'sha256'; actualBytes: number }> {
    let actualBytes = 0
    for (const file of expectedFiles) {
      const size = await fs.stat(file.path).then((stat) => stat.size).catch(() => 0)
      if (!size || (file.info?.size && size !== file.info.size)) {
        const cleanup = await this.cleanupRejectedDownload(finalPath)
        throw new Error(`Downloaded GGUF file is missing, empty, or has the wrong size. ${cleanup}`)
      }
      actualBytes += size
    }
    if (expectedBytes > 0 && actualBytes !== expectedBytes) {
      const cleanup = await this.cleanupRejectedDownload(finalPath)
      throw new Error(
        `Download verification failed: expected ${expectedBytes.toLocaleString()} bytes ` +
          `but found ${actualBytes.toLocaleString()}. ${cleanup}`
      )
    }

    // Stronger check: SHA-256 every file against HF's published checksum, but
    // only when we have a checksum for *every* file (else fall back to size).
    if (entry.verifyChecksum) {
      const checksums = new Map<string, string>()
      for (const file of expectedFiles) {
        if (file.info?.sha256) checksums.set(file.path, file.info.sha256)
      }
      if (checksums.size === expectedFiles.length) {
        await this.verifyChecksums(entry, finalPath, [...checksums.keys()], actualBytes, checksums)
        return { verified: true, verifiedBy: 'sha256', actualBytes }
      }
    }

    // Size matched (or no expected size to compare against — then unverified).
    return { verified: expectedBytes > 0, verifiedBy: expectedBytes > 0 ? 'size' : undefined, actualBytes }
  }

  /**
   * Hash each file against its expected SHA-256, streaming progress into
   * `verifyFraction`. Rejects the first mismatch and cleans up unregistered files.
   */
  private async verifyChecksums(
    entry: ActiveDownload,
    finalPath: string,
    files: string[],
    totalBytes: number,
    expected: Map<string, string>
  ): Promise<void> {
    let hashedBefore = 0
    let lastEmit = 0
    entry.progress.verifyFraction = 0
    this.emitProgress(entry)

    for (const file of files) {
      const want = expected.get(file)
      const { hex, bytes } = await sha256File(file, entry.controller.signal, (fileHashed) => {
        const frac = totalBytes > 0 ? (hashedBefore + fileHashed) / totalBytes : 0
        entry.progress.verifyFraction = Math.min(1, frac)
        const now = Date.now()
        if (now - lastEmit >= 200) {
          lastEmit = now
          this.emitProgress(entry)
        }
      })
      hashedBefore += bytes
      if (want && hex !== want) {
        const cleanup = await this.cleanupRejectedDownload(finalPath)
        throw new Error(
          `Checksum verification failed for ${path.basename(file)}: the file does not match ` +
            `Hugging Face's published checksum. ${cleanup}`
        )
      }
    }

    entry.progress.verifyFraction = 1
    this.emitProgress(entry)
  }

  /**
   * Throw (before any bytes are written) when the models volume clearly can't
   * hold the download. No-op when the expected size or free space is unknown, so
   * a flaky metadata fetch or an unsupported filesystem never blocks a download.
   */
  private async ensureDiskSpace(
    modelsDir: string,
    fileInfo: Map<string, RepoFileInfo>,
    filename: string
  ): Promise<void> {
    const expected = this.expectedBytesFor(fileInfo, filename)
    if (expected <= 0) return

    let free: number
    try {
      const s = await fs.statfs(modelsDir)
      free = s.bavail * s.bsize
    } catch {
      return // can't determine free space — don't block
    }

    const HEADROOM = 100 * 1024 * 1024 // leave room for fs overhead + temp files
    if (free < expected + HEADROOM) {
      throw new Error(
        `Not enough disk space to download ${filename}: needs about ${formatBytes(expected)} ` +
          `but only ${formatBytes(free)} is free in the models folder.`
      )
    }
  }

  /** Expected total download size: the file, or the sum of all shards if multi-part. */
  private expectedBytesFor(fileInfo: Map<string, RepoFileInfo>, filename: string): number {
    const sizes = ggufShardFilenames(filename).map((name) => fileInfo.get(name)?.size ?? 0)
    return sizes.every((size) => size > 0) ? sizes.reduce((sum, size) => sum + size, 0) : 0
  }

  /**
   * The set of files that make up a model on disk: the file itself, or — for a
   * multi-part GGUF — every shard sharing its `-NNNNN-of-MMMMM` group.
   */
  private async shardFilesFor(finalPath: string): Promise<string[]> {
    return resolveModelShardFiles(finalPath)
  }

  /** A failed download may have reused registered files via skipExisting. */
  private async cleanupRejectedDownload(finalPath: string): Promise<string> {
    const models = await listInstalledModels().catch(() => null)
    if (!models) return 'Existing files were preserved because the library could not be checked.'
    if (models.some((model) => modelGroupPath(model.path) === modelGroupPath(finalPath))) {
      return 'Existing library files were preserved; this download was not registered.'
    }
    const files = await this.shardFilesFor(finalPath)
    const removed = await Promise.allSettled(files.map((file) => fs.rm(file, { force: true })))
    return removed.every((result) => result.status === 'fulfilled')
      ? 'The unregistered download was removed; please retry the download.'
      : 'Some downloaded files could not be removed; check the models folder before retrying.'
  }

  cancel(id: string): boolean {
    const entry = this.active.get(canonicalGgufFilename(id))
    if (!entry) return false
    entry.controller.abort()
    return true
  }
}

export const downloadManager = new DownloadManager()
const modelDeletionQueue = new SerialQueue()

/**
 * Remove a library entry and, only for Sibyl-owned downloads, every file in its
 * exact shard group. Partial filesystem failures are reported and the registry
 * entry is retained so the user can retry.
 */
export async function deleteInstalledModel(id: string): Promise<void> {
  return modelDeletionQueue.run(() => deleteModelEntry(id))
}

async function deleteModelEntry(id: string): Promise<void> {
  const model = await getInstalledModel(id)
  if (!model) return
  if (model.local) {
    await removeInstalledModel(id)
    return
  }

  // Older versions could register each shard under a distinct id even though
  // every entry loads the same group. Preserve files still referenced by any
  // other entry (including a local import); no migration rewrites saved ids.
  const sharedPath = modelGroupPath(model.path)
  if ((await listInstalledModels()).some((other) => other.id !== id && modelGroupPath(other.path) === sharedPath)) {
    await removeInstalledModel(id)
    return
  }

  const modelsDir = path.resolve(await getModelsDir())
  const failures: string[] = []
  for (const file of await resolveModelShardFiles(model.path)) {
    const relative = path.relative(modelsDir, path.resolve(file))
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      failures.push(`${path.basename(file)}: path is outside Sibyl's models directory`)
      continue
    }
    try {
      await fs.rm(file, { force: true })
    } catch (err) {
      failures.push(`${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (failures.length) {
    throw new Error(`Could not delete every model shard. ${failures.join('; ')}`)
  }
  await removeInstalledModel(id)
}

/** Re-scan the models directory for GGUF files not yet in the registry. */
export async function importExistingModels(): Promise<void> {
  const modelsDir = await getModelsDir()
  if (!existsSync(modelsDir)) return
  // Implementation intentionally minimal: node-llama-cpp stores models in a
  // predictable layout; deep import is handled lazily by the registry which
  // already prunes dead entries. A full re-scan can be added if needed.
}
