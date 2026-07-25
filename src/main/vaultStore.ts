import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { SerialQueue } from '@shared/serial'
import type {
  PrivateVaultBackup,
  PrivateVaultState,
  PrivateVaultStatus
} from '@shared/types'
import {
  VaultError,
  VaultKey,
  addDeviceKeySlot,
  addPasskeyKeySlot,
  createVault,
  parseVaultHeader,
  parseVaultRecord,
  replaceRecoveryPassphraseSlot,
  serializeVaultHeader,
  serializeVaultRecord,
  unlockVaultWithDevice,
  unlockVaultWithPasskey,
  unlockVaultWithPassphrase,
  type VaultHeader
} from './vault'
import type { PasskeyProvider } from './passkey'

const INDEX_FILE = 'index.svr'
const HEADER_FILE = 'header.json'
const RECORDS_DIR = 'records'
const INDEX_KIND = 'index'
const INDEX_LOGICAL_ID = 'main'
const INDEX_FORMAT_VERSION = 1
const MAX_INDEX_ENTRIES = 10_000
const MAX_HEADER_BYTES = 128 * 1024
const MAX_ENVELOPE_BYTES = 96 * 1024 * 1024
const MAX_BACKUPS = 10
const BACKUP_DIR_PATTERN = /^[A-Za-z0-9_-]{22}\.svb$/

export interface DeviceKeyProtector {
  available(): Promise<boolean>
  protect(masterKey: Buffer): Promise<Buffer>
  unprotect(wrappedKey: Buffer): Promise<{ key: Buffer; shouldReprotect: boolean }>
}

export interface InitialPrivateRecord {
  kind: string
  logicalId: string
  value: unknown
}

interface PrivateIndexEntry {
  kind: string
  logicalId: string
  file: string
  digest: string
  revision: number
}

interface PrivateIndex {
  formatVersion: typeof INDEX_FORMAT_VERSION
  records: PrivateIndexEntry[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new VaultError('INVALID_FORMAT', `${label} contains unexpected or missing fields.`)
  }
}

function privateIndex(value: unknown): PrivateIndex {
  if (!isObject(value)) throw new VaultError('INVALID_FORMAT', 'The encrypted index is invalid.')
  exactKeys(value, ['formatVersion', 'records'], 'encrypted index')
  if (value.formatVersion !== INDEX_FORMAT_VERSION || !Array.isArray(value.records)) {
    throw new VaultError('UNSUPPORTED_VERSION', 'The encrypted index version is not supported.')
  }
  if (value.records.length > MAX_INDEX_ENTRIES) {
    throw new VaultError('INVALID_FORMAT', 'The encrypted index has too many records.')
  }
  const seen = new Set<string>()
  const files = new Set<string>()
  const records = value.records.map((entry): PrivateIndexEntry => {
    if (!isObject(entry)) throw new VaultError('INVALID_FORMAT', 'An encrypted index entry is invalid.')
    exactKeys(entry, ['kind', 'logicalId', 'file', 'digest', 'revision'], 'encrypted index entry')
    if (
      typeof entry.kind !== 'string' ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(entry.kind) ||
      typeof entry.logicalId !== 'string' ||
      entry.logicalId.length === 0 ||
      Buffer.byteLength(entry.logicalId, 'utf8') > 1024 ||
      typeof entry.file !== 'string' ||
      !/^[A-Za-z0-9_-]{22}\.svr$/.test(entry.file) ||
      typeof entry.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.digest) ||
      !Number.isSafeInteger(entry.revision) ||
      (entry.revision as number) < 1
    ) {
      throw new VaultError('INVALID_FORMAT', 'An encrypted index entry has invalid values.')
    }
    const identity = `${entry.kind}\0${entry.logicalId}`
    if (seen.has(identity) || files.has(entry.file)) {
      throw new VaultError('INVALID_FORMAT', 'The encrypted index contains duplicate records.')
    }
    seen.add(identity)
    files.add(entry.file)
    return {
      kind: entry.kind,
      logicalId: entry.logicalId,
      file: entry.file,
      digest: entry.digest,
      revision: entry.revision as number
    }
  })
  return { formatVersion: INDEX_FORMAT_VERSION, records }
}

function emptyIndex(): PrivateIndex {
  return { formatVersion: INDEX_FORMAT_VERSION, records: [] }
}

function recordIdentity(kind: string, logicalId: string): string {
  return `${kind}\0${logicalId}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function randomRecordFile(): string {
  return `${randomBytes(16).toString('base64url')}.svr`
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function copyCiphertext(source: string, destination: string): Promise<void> {
  // COPYFILE_FICLONE uses copy-on-write where the filesystem supports it and
  // transparently falls back to a normal independent copy elsewhere.
  await fs.copyFile(source, destination, fsConstants.COPYFILE_FICLONE)
}

let writeSequence = 0

/**
 * Write ciphertext with a same-directory temp file, flush it, rename it, and
 * best-effort flush the containing directory. Callers never pass plaintext.
 */
async function atomicCiphertextWrite(filePath: string, ciphertext: string): Promise<void> {
  await ensureDir(path.dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.${writeSequence++}.tmp`
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(tempPath, 'wx', 0o600)
    await handle.writeFile(ciphertext, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(tempPath, filePath)
    let directory: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      directory = await fs.open(path.dirname(filePath), 'r')
      await directory.sync()
    } catch {
      // Windows may not allow opening directories for fsync. The file itself was
      // flushed before rename, so this is the strongest portable best effort.
    } finally {
      await directory?.close().catch(() => {})
    }
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

async function readUtf8(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8')
}

async function readUtf8Limited(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new VaultError('INVALID_FORMAT', 'An encrypted vault file exceeds its size limit.')
  }
  return readUtf8(filePath)
}

export class PrivateVaultStore {
  private header: VaultHeader | null = null
  private key: VaultKey | null = null
  private index: PrivateIndex | null = null
  private state: PrivateVaultState = 'uninitialized'
  private lastError: string | undefined
  private deviceAvailable = false
  private passkeyAvailable = false
  private unlockFailures = 0
  private nextUnlockAt = 0
  private backupRetention: 1 | 3 | 5 | 10 = 3
  private readonly writes = new SerialQueue()

  constructor(
    private readonly root: string,
    private readonly deviceProtector?: DeviceKeyProtector,
    private readonly passkeyProvider?: PasskeyProvider
  ) {}

  setBackupRetention(retention: 1 | 3 | 5 | 10): void {
    this.backupRetention = retention
  }

  status(): PrivateVaultStatus {
    return {
      state: this.state,
      hasDeviceSlot: Boolean(this.header?.keySlots.some((slot) => slot.type === 'device')),
      hasPasskeySlot: Boolean(
        this.header?.keySlots.some((slot) => slot.type === 'passkey')
      ),
      recoveryAvailable: Boolean(
        this.header?.keySlots.some((slot) => slot.type === 'recovery-passphrase')
      ),
      deviceStorageAvailable: this.deviceAvailable,
      passkeyAvailable: this.passkeyAvailable,
      migrationRequired: false,
      ...(this.lastError ? { error: this.lastError } : {})
    }
  }

  private headerPath(root = this.root): string {
    return path.join(root, HEADER_FILE)
  }

  private indexPath(root = this.root): string {
    return path.join(root, INDEX_FILE)
  }

  private recordsPath(root = this.root): string {
    return path.join(root, RECORDS_DIR)
  }

  private backupsPath(): string {
    return path.join(path.dirname(this.root), 'vault-backups')
  }

  /**
   * Keep retained recovery generations on the live vault's current unlock
   * policy. Records use the same master key across credential rotation, so an
   * authenticated current header can safely replace an older header without
   * rewriting snapshot ciphertext. Running this after every successful unlock
   * also repairs a rotation interrupted after the live header was committed.
   */
  private async refreshBackupHeaders(header: VaultHeader, key: VaultKey): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(this.backupsPath())
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') return
      throw error
    }
    const serialized = serializeVaultHeader(header)
    for (const name of names.filter((candidate) => BACKUP_DIR_PATTERN.test(candidate))) {
      const backupRoot = path.join(this.backupsPath(), name)
      const stat = await fs.stat(backupRoot)
      if (!stat.isDirectory()) continue
      let backupHeader: VaultHeader
      try {
        backupHeader = parseVaultHeader(
          JSON.parse(await readUtf8Limited(this.headerPath(backupRoot), MAX_HEADER_BYTES)) as unknown
        )
        if (
          backupHeader.vaultId !== header.vaultId ||
          backupHeader.keyVersion !== header.keyVersion
        ) {
          continue
        }
        key.assertHeaderMatches(backupHeader)
      } catch (error) {
        if (
          error instanceof VaultError ||
          (isObject(error) && error.code === 'ENOENT') ||
          error instanceof SyntaxError
        ) {
          continue
        }
        throw error
      }
      if (serializeVaultHeader(backupHeader) !== serialized) {
        await atomicCiphertextWrite(this.headerPath(backupRoot), serialized)
      }
    }
  }

  private async commitHeader(header: VaultHeader, key: VaultKey): Promise<void> {
    await atomicCiphertextWrite(this.headerPath(), serializeVaultHeader(header))
    this.header = header
    try {
      await this.refreshBackupHeaders(header, key)
      this.lastError = undefined
    } catch {
      // The live credential change is already durable. Report the partial
      // maintenance failure while keeping the authenticated vault usable; a
      // later unlock retries synchronization.
      this.lastError =
        'The vault credential changed, but one or more recovery snapshots could not be refreshed.'
    }
  }

  private recordPath(file: string, root = this.root): string {
    if (!/^[A-Za-z0-9_-]{22}\.svr$/.test(file)) {
      throw new VaultError('INVALID_FORMAT', 'The encrypted record filename is invalid.')
    }
    return path.join(this.recordsPath(root), file)
  }

  private requireUnlocked(): { header: VaultHeader; key: VaultKey; index: PrivateIndex } {
    if (this.state !== 'unlocked' || !this.header || !this.key || !this.index) {
      throw new VaultError('VAULT_LOCKED', 'The private vault is locked.')
    }
    return { header: this.header, key: this.key, index: this.index }
  }

  async initialize(): Promise<PrivateVaultStatus> {
    this.lock()
    this.header = null
    this.lastError = undefined
    try {
      this.deviceAvailable = Boolean(
        this.deviceProtector && (await this.deviceProtector.available())
      )
    } catch {
      this.deviceAvailable = false
    }
    try {
      this.passkeyAvailable = Boolean(
        this.passkeyProvider && (await this.passkeyProvider.available())
      )
    } catch {
      this.passkeyAvailable = false
    }
    let serialized: string
    try {
      serialized = await readUtf8Limited(this.headerPath(), MAX_HEADER_BYTES)
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') {
        this.state = 'uninitialized'
        return this.status()
      }
      this.state = 'error'
      this.lastError = 'The encrypted vault header could not be read.'
      return this.status()
    }
    try {
      this.header = parseVaultHeader(JSON.parse(serialized) as unknown)
    } catch {
      this.state = 'error'
      this.lastError = 'The encrypted vault header is damaged or unsupported.'
      return this.status()
    }

    const deviceSlot = this.header.keySlots.some((slot) => slot.type === 'device')
    if (deviceSlot && this.deviceProtector && this.deviceAvailable) {
      try {
        let shouldReprotect = false
        const key = await unlockVaultWithDevice(
          this.header,
          async (wrapped) => {
            const result = await this.deviceProtector!.unprotect(wrapped)
            shouldReprotect = result.shouldReprotect
            return result.key
          }
        )
        await this.adoptUnlockedKey(key)
        if (shouldReprotect) {
          try {
            await this.setSeamlessOnThisDevice(true)
          } catch {
            // The existing device wrap already authenticated the vault. Keep
            // that successful unlock instead of reporting "locked" while the
            // key remains resident; the user can retry refreshing the device
            // slot from Settings.
            this.lastError =
              'Sibyl unlocked the vault, but could not refresh secure device storage.'
          }
        }
        return this.status()
      } catch {
        // Device credentials can legitimately disappear after an OS reinstall or
        // hardware change. Keep the recovery-passphrase path available.
        if (this.state === 'error') return this.status()
      }
    }
    this.state = 'locked'
    return this.status()
  }

  async setup(
    recoveryPassphrase: string,
    seamlessOnThisDevice: boolean,
    initialRecords: InitialPrivateRecord[]
  ): Promise<PrivateVaultStatus> {
    if (this.state !== 'uninitialized') {
      throw new VaultError('INVALID_FORMAT', 'A private vault already exists.')
    }
    if (initialRecords.length > MAX_INDEX_ENTRIES) {
      throw new VaultError('INVALID_FORMAT', 'There are too many private records to migrate.')
    }
    const identities = new Set<string>()
    for (const record of initialRecords) {
      const identity = recordIdentity(record.kind, record.logicalId)
      if (identities.has(identity)) {
        throw new VaultError('INVALID_FORMAT', 'Private migration contains duplicate records.')
      }
      identities.add(identity)
    }

    const created = await createVault(recoveryPassphrase)
    const parent = path.dirname(this.root)
    let staging: string | null = null
    try {
      let header = created.header
      try {
        this.deviceAvailable = Boolean(
          this.deviceProtector && (await this.deviceProtector.available())
        )
      } catch {
        this.deviceAvailable = false
      }
      if (
        seamlessOnThisDevice &&
        this.deviceProtector &&
        this.deviceAvailable
      ) {
        header = await addDeviceKeySlot(
          header,
          created.key,
          (master) => this.deviceProtector!.protect(master)
        )
      }

      await ensureDir(parent)
      staging = path.join(parent, `.sibyl-vault-staging-${randomBytes(12).toString('hex')}`)
      await ensureDir(this.recordsPath(staging))
      const index = emptyIndex()
      for (const record of initialRecords) {
        const entry = await this.writeNewRecord(
          staging,
          created.key,
          record.kind,
          record.logicalId,
          record.value,
          1
        )
        index.records.push(entry)
      }
      await this.writeIndex(staging, created.key, index)
      await atomicCiphertextWrite(this.headerPath(staging), serializeVaultHeader(header))
      await this.verifyGeneration(staging, header, created.key, index)
      await fs.rename(staging, this.root)
      staging = null

      this.header = header
      this.key = created.key
      this.index = index
      this.state = 'unlocked'
      this.lastError = undefined
      return this.status()
    } catch (error) {
      created.key.destroy()
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async unlockWithPassphrase(recoveryPassphrase: string): Promise<PrivateVaultStatus> {
    if (!this.header) {
      throw new VaultError('INVALID_FORMAT', 'The encrypted vault header is unavailable.')
    }
    const waitMs = this.nextUnlockAt - Date.now()
    if (waitMs > 0) {
      throw new VaultError(
        'UNLOCK_FAILED',
        `Wait ${Math.max(1, Math.ceil(waitMs / 1000))} second${waitMs > 1000 ? 's' : ''} before trying again.`
      )
    }
    let key: VaultKey
    try {
      key = await unlockVaultWithPassphrase(this.header, recoveryPassphrase)
    } catch (error) {
      if (error instanceof VaultError && error.code === 'UNLOCK_FAILED') {
        this.unlockFailures += 1
        const delayMs = Math.min(30_000, 500 * 2 ** Math.min(this.unlockFailures - 1, 6))
        this.nextUnlockAt = Date.now() + delayMs
      }
      throw error
    }
    await this.adoptUnlockedKey(key)
    this.unlockFailures = 0
    this.nextUnlockAt = 0
    return this.status()
  }

  async unlockWithPasskey(): Promise<PrivateVaultStatus> {
    if (!this.header || !this.passkeyProvider) {
      throw new VaultError('UNLOCK_FAILED', 'The vault could not be unlocked.')
    }
    const waitMs = this.nextUnlockAt - Date.now()
    if (waitMs > 0) {
      throw new VaultError(
        'UNLOCK_FAILED',
        `Wait ${Math.max(1, Math.ceil(waitMs / 1000))} second${waitMs > 1000 ? 's' : ''} before trying again.`
      )
    }
    let key: VaultKey
    try {
      key = await unlockVaultWithPasskey(
        this.header,
        (credentialId, salt) =>
          this.passkeyProvider!.evaluate(credentialId, salt)
      )
    } catch (error) {
      if (error instanceof VaultError && error.code === 'UNLOCK_FAILED') {
        this.unlockFailures += 1
        const delayMs = Math.min(
          30_000,
          500 * 2 ** Math.min(this.unlockFailures - 1, 6)
        )
        this.nextUnlockAt = Date.now() + delayMs
      }
      throw error
    }
    await this.adoptUnlockedKey(key)
    this.unlockFailures = 0
    this.nextUnlockAt = 0
    return this.status()
  }

  lock(): void {
    this.key?.destroy()
    this.key = null
    this.index = null
    this.lastError = undefined
    if (this.header) this.state = 'locked'
  }

  async setSeamlessOnThisDevice(enabled: boolean): Promise<PrivateVaultStatus> {
    await this.writes.run(async () => {
      const { header, key } = this.requireUnlocked()
      let next: VaultHeader
      if (enabled) {
        if (!this.deviceProtector || !(await this.deviceProtector.available())) {
          throw new VaultError(
            'UNLOCK_FAILED',
            'Secure device storage is unavailable on this system.'
          )
        }
        this.deviceAvailable = true
        next = await addDeviceKeySlot(
          header,
          key,
          (master) => this.deviceProtector!.protect(master)
        )
      } else {
        next = {
          ...header,
          keySlots: header.keySlots.filter((slot) => slot.type !== 'device')
        }
      }
      await this.commitHeader(next, key)
    })
    return this.status()
  }

  async setPasskey(enabled: boolean): Promise<PrivateVaultStatus> {
    await this.writes.run(async () => {
      const { header, key } = this.requireUnlocked()
      let next: VaultHeader
      if (!enabled) {
        next = {
          ...header,
          keySlots: header.keySlots.filter((slot) => slot.type !== 'passkey')
        }
      } else {
        if (
          !this.passkeyProvider ||
          !(await this.passkeyProvider.available())
        ) {
          throw new VaultError(
            'UNLOCK_FAILED',
            'A PRF-capable passkey authenticator is unavailable.'
          )
        }
        const enrollment = await this.passkeyProvider.enroll()
        try {
          next = addPasskeyKeySlot(
            header,
            key,
            enrollment.credentialId,
            enrollment.salt,
            enrollment.prfOutput
          )
        } finally {
          enrollment.credentialId.fill(0)
          enrollment.salt.fill(0)
          enrollment.prfOutput.fill(0)
        }
      }
      await this.commitHeader(next, key)
    })
    return this.status()
  }

  async changeRecoveryPassphrase(recoveryPassphrase: string): Promise<PrivateVaultStatus> {
    await this.writes.run(async () => {
      const { header, key } = this.requireUnlocked()
      const next = await replaceRecoveryPassphraseSlot(header, key, recoveryPassphrase)
      await this.commitHeader(next, key)
    })
    this.unlockFailures = 0
    this.nextUnlockAt = 0
    return this.status()
  }

  private async createBackupUnlocked(protectedBackupPath?: string): Promise<void> {
    const { header, key, index } = this.requireUnlocked()
    const backups = this.backupsPath()
    await ensureDir(backups)
    const staging = path.join(
      backups,
      `.staging-${randomBytes(16).toString('base64url')}`
    )
    const destination = path.join(
      backups,
      `${randomBytes(16).toString('base64url')}.svb`
    )
    try {
      await ensureDir(this.recordsPath(staging))
      await fs.copyFile(this.headerPath(), this.headerPath(staging))
      await fs.copyFile(this.indexPath(), this.indexPath(staging))
      for (const entry of index.records) {
        await copyCiphertext(
          this.recordPath(entry.file),
          this.recordPath(entry.file, staging)
        )
      }
      await this.verifyGeneration(staging, header, key, index)
      await fs.rename(staging, destination)

      const generations: Array<{ path: string; modified: number }> = []
      for (const name of await fs.readdir(backups)) {
        if (!BACKUP_DIR_PATTERN.test(name)) continue
        const backupPath = path.join(backups, name)
        const stat = await fs.stat(backupPath)
        if (stat.isDirectory()) generations.push({ path: backupPath, modified: stat.mtimeMs })
      }
      const staleCount = Math.max(
        0,
        generations.length - Math.min(this.backupRetention, MAX_BACKUPS)
      )
      const staleGenerations = generations
        .filter(
          (generation) =>
            generation.path !== destination && generation.path !== protectedBackupPath
        )
        .sort((left, right) => left.modified - right.modified)
        .slice(0, staleCount)
      for (const stale of staleGenerations) {
        await fs.rm(stale.path, { recursive: true, force: true })
      }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  async createBackup(): Promise<void> {
    await this.writes.run(() => this.createBackupUnlocked())
  }

  private async readBackup(
    id: string,
    key: VaultKey
  ): Promise<{ root: string; index: PrivateIndex }> {
    if (!BACKUP_DIR_PATTERN.test(id)) {
      throw new VaultError('INVALID_FORMAT', 'The encrypted backup identifier is invalid.')
    }
    const backupRoot = path.join(this.backupsPath(), id)
    const header = parseVaultHeader(
      JSON.parse(await readUtf8Limited(this.headerPath(backupRoot), MAX_HEADER_BYTES)) as unknown
    )
    if (header.vaultId !== key.vaultId || header.keyVersion !== key.keyVersion) {
      throw new VaultError('RECORD_MISMATCH', 'The encrypted backup belongs to another vault.')
    }
    key.assertHeaderMatches(header)
    const index = await this.readIndex(backupRoot, key)
    await this.verifyIndexedRecords(backupRoot, key, index)
    return { root: backupRoot, index }
  }

  async listBackups(): Promise<PrivateVaultBackup[]> {
    return this.writes.run(async () => {
      const { key } = this.requireUnlocked()
      return this.listBackupsUnlocked(key)
    })
  }

  async restoreBackup(id: string): Promise<void> {
    await this.writes.run(async () => {
      const { key, index: currentIndex } = this.requireUnlocked()
      const backup = await this.readBackup(id, key)
      await this.createBackupUnlocked(backup.root)

      const copied: string[] = []
      const restoredEntries: PrivateIndexEntry[] = []
      try {
        for (const entry of backup.index.records) {
          const file = randomRecordFile()
          await copyCiphertext(
            this.recordPath(entry.file, backup.root),
            this.recordPath(file)
          )
          copied.push(file)
          restoredEntries.push({ ...entry, file })
        }
        const restoredIndex: PrivateIndex = {
          formatVersion: INDEX_FORMAT_VERSION,
          records: restoredEntries
        }
        await this.writeIndex(this.root, key, restoredIndex)
        this.index = restoredIndex
      } catch (error) {
        for (const file of copied) {
          await fs.rm(this.recordPath(file), { force: true }).catch(() => {})
        }
        throw error
      }
      const restoredFiles = new Set(restoredEntries.map((entry) => entry.file))
      for (const entry of currentIndex.records) {
        if (!restoredFiles.has(entry.file)) {
          await fs.rm(this.recordPath(entry.file), { force: true }).catch(() => {})
        }
      }
    })
  }

  private async adoptUnlockedKey(key: VaultKey): Promise<void> {
    try {
      const index = await this.readIndex(this.root, key)
      await this.verifyIndexedRecords(this.root, key, index)
      this.key?.destroy()
      this.key = key
      this.index = index
      this.state = 'unlocked'
      this.lastError = undefined
      if (this.header) {
        try {
          await this.refreshBackupHeaders(this.header, key)
        } catch {
          this.lastError =
            'Sibyl unlocked the vault, but one or more recovery snapshots could not be refreshed.'
        }
      }
    } catch (error) {
      key.destroy()
      this.key?.destroy()
      this.key = null
      this.index = null
      this.state = 'error'
      this.lastError = 'The encrypted vault index or one of its records failed authentication.'
      throw error
    }
  }

  private async writeNewRecord(
    root: string,
    key: VaultKey,
    kind: string,
    logicalId: string,
    value: unknown,
    revision: number
  ): Promise<PrivateIndexEntry> {
    const envelope = key.encryptJson(kind, logicalId, value)
    const serialized = serializeVaultRecord(envelope)
    const file = randomRecordFile()
    await atomicCiphertextWrite(this.recordPath(file, root), serialized)
    return {
      kind,
      logicalId,
      file,
      digest: sha256(serialized),
      revision
    }
  }

  private async writeIndex(root: string, key: VaultKey, index: PrivateIndex): Promise<void> {
    const envelope = key.encryptJson(INDEX_KIND, INDEX_LOGICAL_ID, index)
    await atomicCiphertextWrite(this.indexPath(root), serializeVaultRecord(envelope))
  }

  private async readIndex(root: string, key: VaultKey): Promise<PrivateIndex> {
    const serialized = await readUtf8Limited(this.indexPath(root), MAX_ENVELOPE_BYTES)
    const envelope = parseVaultRecord(JSON.parse(serialized) as unknown)
    return privateIndex(key.decryptJson(envelope, INDEX_KIND, INDEX_LOGICAL_ID))
  }

  private async readEntry(
    root: string,
    key: VaultKey,
    entry: PrivateIndexEntry
  ): Promise<unknown> {
    const serialized = await readUtf8Limited(
      this.recordPath(entry.file, root),
      MAX_ENVELOPE_BYTES
    )
    if (sha256(serialized) !== entry.digest) {
      throw new VaultError(
        'RECORD_TAMPERED',
        'An encrypted record does not match the current authenticated index.'
      )
    }
    const envelope = parseVaultRecord(JSON.parse(serialized) as unknown)
    return key.decryptJson(envelope, entry.kind, entry.logicalId)
  }

  private async verifyIndexedRecords(
    root: string,
    key: VaultKey,
    index: PrivateIndex
  ): Promise<void> {
    for (const entry of index.records) await this.readEntry(root, key, entry)
  }

  private async verifyGeneration(
    root: string,
    header: VaultHeader,
    key: VaultKey,
    expectedIndex: PrivateIndex
  ): Promise<void> {
    const persistedHeader = key.assertHeaderMatches(
      JSON.parse(await readUtf8(this.headerPath(root))) as unknown
    )
    if (serializeVaultHeader(persistedHeader) !== serializeVaultHeader(header)) {
      throw new VaultError('RECORD_TAMPERED', 'The encrypted header read-back did not match.')
    }
    const index = await this.readIndex(root, key)
    if (JSON.stringify(index) !== JSON.stringify(expectedIndex)) {
      throw new VaultError('RECORD_TAMPERED', 'The encrypted index read-back did not match.')
    }
    await this.verifyIndexedRecords(root, key, index)
  }

  async readJson(kind: string, logicalId: string): Promise<unknown | null> {
    return this.writes.run(async () => {
      const { key, index } = this.requireUnlocked()
      const entry = index.records.find(
        (candidate) => candidate.kind === kind && candidate.logicalId === logicalId
      )
      return entry ? this.readEntry(this.root, key, entry) : null
    })
  }

  async listJson(kind: string): Promise<Array<{ logicalId: string; value: unknown }>> {
    return this.writes.run(async () => {
      const { key, index } = this.requireUnlocked()
      const out: Array<{ logicalId: string; value: unknown }> = []
      for (const entry of index.records) {
        if (entry.kind !== kind) continue
        out.push({
          logicalId: entry.logicalId,
          value: await this.readEntry(this.root, key, entry)
        })
      }
      return out
    })
  }

  async writeJson(kind: string, logicalId: string, value: unknown): Promise<void> {
    await this.writes.run(async () => {
      const { key, index } = this.requireUnlocked()
      await this.createBackupUnlocked()
      const identity = recordIdentity(kind, logicalId)
      const previous = index.records.find(
        (entry) => recordIdentity(entry.kind, entry.logicalId) === identity
      )
      const nextEntry = await this.writeNewRecord(
        this.root,
        key,
        kind,
        logicalId,
        value,
        (previous?.revision ?? 0) + 1
      )
      const next: PrivateIndex = {
        formatVersion: INDEX_FORMAT_VERSION,
        records: [
          ...index.records.filter(
            (entry) => recordIdentity(entry.kind, entry.logicalId) !== identity
          ),
          nextEntry
        ]
      }
      try {
        await this.writeIndex(this.root, key, next)
      } catch (error) {
        await fs.rm(this.recordPath(nextEntry.file), { force: true }).catch(() => {})
        throw error
      }
      this.index = next
      if (previous) await fs.rm(this.recordPath(previous.file), { force: true }).catch(() => {})
    })
  }

  /**
   * Atomically upsert a related set of private records behind one authenticated
   * index commit. Plaintext values stay in memory; only encrypted record files
   * are written before the index swap makes the batch visible.
   */
  async writeJsonBatch(records: InitialPrivateRecord[]): Promise<void> {
    await this.writes.run(async () => {
      const { key, index } = this.requireUnlocked()
      if (records.length === 0) return
      if (records.length > MAX_INDEX_ENTRIES) {
        throw new VaultError('INVALID_FORMAT', 'The private import contains too many records.')
      }
      const identities = new Set<string>()
      for (const record of records) {
        const identity = recordIdentity(record.kind, record.logicalId)
        if (identities.has(identity)) {
          throw new VaultError('INVALID_FORMAT', 'The private import contains duplicate records.')
        }
        identities.add(identity)
      }
      const retainedCount = index.records.filter(
        (entry) => !identities.has(recordIdentity(entry.kind, entry.logicalId))
      ).length
      if (retainedCount + records.length > MAX_INDEX_ENTRIES) {
        throw new VaultError('INVALID_FORMAT', 'The private import contains too many records.')
      }

      await this.createBackupUnlocked()
      const created: PrivateIndexEntry[] = []
      try {
        for (const record of records) {
          const identity = recordIdentity(record.kind, record.logicalId)
          const previous = index.records.find(
            (entry) => recordIdentity(entry.kind, entry.logicalId) === identity
          )
          created.push(
            await this.writeNewRecord(
              this.root,
              key,
              record.kind,
              record.logicalId,
              record.value,
              (previous?.revision ?? 0) + 1
            )
          )
        }

        const next: PrivateIndex = {
          formatVersion: INDEX_FORMAT_VERSION,
          records: [
            ...index.records.filter(
              (entry) => !identities.has(recordIdentity(entry.kind, entry.logicalId))
            ),
            ...created
          ]
        }
        if (next.records.length > MAX_INDEX_ENTRIES) {
          throw new VaultError('INVALID_FORMAT', 'The private import contains too many records.')
        }
        await this.writeIndex(this.root, key, next)
        this.index = next
      } catch (error) {
        await Promise.all(
          created.map((entry) =>
            fs.rm(this.recordPath(entry.file), { force: true }).catch(() => {})
          )
        )
        throw error
      }

      const replaced = index.records.filter((entry) =>
        identities.has(recordIdentity(entry.kind, entry.logicalId))
      )
      await Promise.all(
        replaced.map((entry) =>
          fs.rm(this.recordPath(entry.file), { force: true }).catch(() => {})
        )
      )
    })
  }

  /** Authenticate the live vault and every retained snapshot without restoring. */
  async verifyRecovery(): Promise<{ currentRecords: number; validBackups: number }> {
    return this.writes.run(async () => {
      const { header, key, index } = this.requireUnlocked()
      await this.verifyGeneration(this.root, header, key, index)
      const backups = await this.listBackupsUnlocked(key)
      if (backups.some((backup) => !backup.valid)) {
        throw new VaultError(
          'RECORD_TAMPERED',
          'One or more encrypted recovery snapshots failed authentication.'
        )
      }
      return {
        currentRecords: index.records.length,
        validBackups: backups.filter((backup) => backup.valid).length
      }
    })
  }

  private async listBackupsUnlocked(key: VaultKey): Promise<PrivateVaultBackup[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.backupsPath())
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') return []
      throw error
    }
    const summaries: PrivateVaultBackup[] = []
    for (const id of names.filter((name) => BACKUP_DIR_PATTERN.test(name))) {
      const backupRoot = path.join(this.backupsPath(), id)
      const stat = await fs.stat(backupRoot)
      if (!stat.isDirectory()) continue
      try {
        const { index } = await this.readBackup(id, key)
        summaries.push({
          id,
          createdAt: stat.mtime.toISOString(),
          recordCount: index.records.length,
          valid: true
        })
      } catch {
        summaries.push({
          id,
          createdAt: stat.mtime.toISOString(),
          recordCount: 0,
          valid: false
        })
      }
    }
    summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    return summaries
  }

  async delete(kind: string, logicalId: string): Promise<void> {
    await this.writes.run(async () => {
      const { key, index } = this.requireUnlocked()
      const identity = recordIdentity(kind, logicalId)
      const previous = index.records.find(
        (entry) => recordIdentity(entry.kind, entry.logicalId) === identity
      )
      if (!previous) return
      await this.createBackupUnlocked()
      const next: PrivateIndex = {
        formatVersion: INDEX_FORMAT_VERSION,
        records: index.records.filter(
          (entry) => recordIdentity(entry.kind, entry.logicalId) !== identity
        )
      }
      await this.writeIndex(this.root, key, next)
      this.index = next
      await fs.rm(this.recordPath(previous.file), { force: true }).catch(() => {})
    })
  }
}
