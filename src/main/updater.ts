import { EventEmitter } from 'node:events'
import { app, autoUpdater } from 'electron'
import type { UpdateStatus } from '@shared/types'
import { teardownGpu } from './shutdown'

/**
 * Auto-update via Electron's native `autoUpdater` — which *is* Squirrel.Windows.
 * Squirrel installs each version side-by-side and applies on restart, so an
 * update NEVER overwrites the running binary (no locked-file "Sibyl cannot be
 * closed", no need to kill the GPU process). Replaces the old electron-updater +
 * NSIS flow.
 *
 * Feed: served straight from the public GitHub releases. Squirrel appends
 * `/RELEASES` and resolves the `.nupkg` relative to this base; GitHub's
 * `releases/latest/download/<asset>` always points at the newest release's asset,
 * so a fixed URL tracks "latest" with no server.
 *
 * Unlike electron-updater there is no separate download step or progress —
 * `checkForUpdates()` auto-downloads, then `update-downloaded` fires.
 */
const FEED_URL = 'https://github.com/jdhoward5/Sibyl/releases/latest/download'

class Updater extends EventEmitter {
  private status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() }
  private initialized = false

  /** Wire the native autoUpdater once. No-op (and reports) when not installed. */
  init(): void {
    if (this.initialized) return
    // The native updater only works inside a Squirrel-installed app (it shells out
    // to ..\Update.exe); it throws when unpackaged or run from a bare folder.
    if (!app.isPackaged) {
      this.set({ state: 'dev-disabled' })
      return
    }
    try {
      autoUpdater.setFeedURL({ url: FEED_URL })
    } catch (err) {
      this.set({ state: 'error', error: err instanceof Error ? err.message : String(err) })
      return
    }
    this.initialized = true

    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    // Squirrel begins downloading as soon as it finds a newer release; we won't
    // know the version until it's downloaded.
    autoUpdater.on('update-available', () => this.set({ state: 'downloading', version: undefined }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'not-available', version: undefined }))
    autoUpdater.on('update-downloaded', (_event, releaseNotes, releaseName, releaseDate) =>
      this.set({
        state: 'downloaded',
        version: typeof releaseName === 'string' ? releaseName : undefined,
        releaseNotes: typeof releaseNotes === 'string' ? releaseNotes : undefined,
        releaseDate: releaseDate instanceof Date ? releaseDate.toISOString() : undefined
      })
    )
    autoUpdater.on('error', (err) =>
      this.set({ state: 'error', error: err == null ? 'Unknown update error' : err.message || String(err) })
    )
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /** Check GitHub for a newer release; Squirrel auto-downloads if one exists. */
  async check(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      this.set({ state: 'dev-disabled' })
      return this.status
    }
    this.init()
    if (this.status.state === 'error') return this.status
    try {
      autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    return this.status
  }

  /**
   * Apply a downloaded update and relaunch. Squirrel swaps to the already-staged
   * side-by-side version on quit — no overwrite of the running app. We still
   * dispose the GPU first (bounded) for a clean exit; that's all that's needed now.
   */
  async install(): Promise<void> {
    if (!app.isPackaged) return
    try {
      await Promise.race([teardownGpu(), new Promise<void>((resolve) => setTimeout(resolve, 6000))])
    } catch {
      /* teardownGpu swallows its own errors; never block the install on it */
    }
    autoUpdater.quitAndInstall()
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }
}

export const updater = new Updater()

export const initUpdater = (): void => updater.init()
export const checkForUpdates = (): Promise<UpdateStatus> => updater.check()
