import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { parseParamLabel, parseQuant } from '@shared/format'
import type {
  AppSettings,
  Conversation,
  InstalledModel,
  Persona,
  PrivateVaultBackup,
  PrivateVaultStatus,
  RendererSettings,
  RendererSettingsPatch,
  ResourceAvailability,
  StorageIssue,
  SystemPromptPreset
} from '@shared/types'
import {
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_ACCESSIBILITY_SETTINGS,
  DEFAULT_GENERATION_OPTIONS,
  DEFAULT_GENERATION_PROFILES
} from '@shared/types'
import { DEFAULT_TTS_SETTINGS, type InstalledVoice } from '@shared/tts'
import { DEFAULT_ACCENT } from '@shared/themes'
import { DEFAULT_PERSONAS, gradientFor, initialsOf } from '@shared/personas'
import { migrateConversationIdentity, normalizePersona } from '@shared/roleplay'
import { parseCanonicalId, parseConversation } from '@shared/validation'
import { SerialQueue } from '@shared/serial'
import type { PreparedPortableImport } from '@shared/portable'
import {
  PrivateVaultStore,
  type DeviceKeyProtector,
  type InitialPrivateRecord
} from './vaultStore'
import { passkeyProvider } from './passkey'

/** Deep-ish clone so callers can't mutate the shared default persona objects. */
function clonePersona(p: Persona): Persona {
  return normalizePersona(structuredClone(p))
}

/** Convert a legacy prompt preset (name + prompt) into a brief-only persona. */
function presetToPersona(p: SystemPromptPreset): Persona {
  return {
    id: p.id,
    name: p.name,
    role: '',
    brief: p.prompt,
    avatar: { monogram: initialsOf(p.name), gradient: gradientFor(p.id) },
    voiceTags: []
  }
}

/**
 * Persistent JSON store rooted in Electron's userData directory.
 *
 * - All writes are atomic (temp file + rename) to survive crashes mid-write.
 * - The Hugging Face token is encrypted at rest with the OS keychain via
 *   Electron `safeStorage`; it is never written to disk in plaintext.
 */

function userDataDir(): string {
  return app.getPath('userData')
}

function defaultModelsDir(): string {
  return path.join(userDataDir(), 'models')
}

function registryPath(): string {
  return path.join(userDataDir(), 'models.json')
}

function conversationsDir(): string {
  return path.join(userDataDir(), 'conversations')
}

function privateVaultDir(): string {
  return path.join(userDataDir(), 'vault')
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

// Monotonic per-process counter so two rapid writes to the same file never share
// a temp path (which would let one write's rename clobber the other's in-flight file).
let tmpWriteSeq = 0

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.${tmpWriteSeq++}.tmp`
  try {
    await fs.writeFile(tmp, data, 'utf8')
    await fs.rename(tmp, filePath)
  } catch (err) {
    // Best-effort cleanup of the temp file so a failed write doesn't orphan it.
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

const settingsQueue = new SerialQueue()
const modelRegistryQueue = new SerialQueue()
const voiceRegistryQueue = new SerialQueue()
const conversationQueues = new Map<string, SerialQueue>()

function conversationQueue(id: string): SerialQueue {
  let queue = conversationQueues.get(id)
  if (!queue) {
    queue = new SerialQueue()
    conversationQueues.set(id, queue)
  }
  return queue
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface PersistedSettings extends Omit<AppSettings, 'hfToken'> {
  /** base64 of safeStorage-encrypted token, or null. */
  hfTokenEnc: string | null
}

function defaultSettings(): AppSettings {
  return {
    modelsDir: defaultModelsDir(),
    hfToken: null,
    generation: { ...DEFAULT_GENERATION_OPTIONS },
    load: {
      gpuLayers: -1,
      contextSize: 8192,
      systemPrompt:
        'You are Sibyl, a helpful, knowledgeable and concise AI assistant running locally on the user’s machine.'
    },
    context: { ...DEFAULT_CONTEXT_SETTINGS },
    theme: 'dark',
    accent: DEFAULT_ACCENT,
    gpu: 'auto',
    verifyDownloads: true,
    personas: DEFAULT_PERSONAS.map(clonePersona),
    promptPresets: [],
    generationProfiles: DEFAULT_GENERATION_PROFILES.map((p) => ({ ...p, options: { ...p.options } })),
    tts: { ...DEFAULT_TTS_SETTINGS },
    accessibility: { ...DEFAULT_ACCESSIBILITY_SETTINGS },
    backupRetention: 3,
    telemetry: false
  }
}

/** Whether OS-backed secure storage is available to encrypt secrets (e.g. the HF token). */
export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encryptToken(token: string | null): string | null {
  if (!token) return null
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(token).toString('base64')
    }
  } catch {
    /* fall through */
  }
  return null
}

function decryptToken(enc: string | null): string | null {
  if (!enc) return null
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    }
  } catch {
    /* corrupted or key changed */
  }
  return null
}

const deviceKeyProtector: DeviceKeyProtector = {
  available: async () => {
    try {
      if (process.platform === 'win32') return safeStorage.isEncryptionAvailable()
      return await safeStorage.isAsyncEncryptionAvailable()
    } catch {
      return false
    }
  },
  protect: async (masterKey) => {
    if (process.platform === 'win32') {
      return safeStorage.encryptString(masterKey.toString('base64url'))
    }
    return safeStorage.encryptStringAsync(masterKey.toString('base64url'))
  },
  unprotect: async (wrappedKey) => {
    if (process.platform === 'win32') {
      const result = safeStorage.decryptString(wrappedKey)
      if (!/^[A-Za-z0-9_-]{43}$/.test(result)) {
        throw new Error('Secure device storage returned invalid key material.')
      }
      return {
        key: Buffer.from(result, 'base64url'),
        shouldReprotect: false
      }
    }
    const result = await safeStorage.decryptStringAsync(wrappedKey)
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.result)) {
      throw new Error('Secure device storage returned invalid key material.')
    }
    return {
      key: Buffer.from(result.result, 'base64url'),
      shouldReprotect: result.shouldReEncrypt
    }
  }
}

let privateStore: PrivateVaultStore | null = null

function vaultStore(): PrivateVaultStore {
  if (!privateStore) {
    privateStore = new PrivateVaultStore(
      privateVaultDir(),
      deviceKeyProtector,
      passkeyProvider
    )
  }
  return privateStore
}

function isFsError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

async function legacySettingsFiles(): Promise<string[]> {
  try {
    return (await fs.readdir(userDataDir()))
      .filter((name) => name === 'settings.json' || name.startsWith('settings.json.'))
      .map((name) => path.join(userDataDir(), name))
  } catch (error) {
    if (isFsError(error, 'ENOENT')) return []
    throw error
  }
}

async function legacyConversationFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(conversationsDir(), { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new Error('The legacy conversations directory contains an unexpected subdirectory.')
      }
      files.push(path.join(conversationsDir(), entry.name))
    }
    return files
  } catch (error) {
    if (isFsError(error, 'ENOENT')) return []
    throw error
  }
}

async function hasLegacyPrivateData(): Promise<boolean> {
  return (
    (await legacySettingsFiles()).length > 0 ||
    (await legacyConversationFiles()).length > 0
  )
}

async function initialPrivateRecords(): Promise<InitialPrivateRecord[]> {
  const records: InitialPrivateRecord[] = []
  const settingsFiles = await legacySettingsFiles()
  let activeSettings: unknown = null
  for (const file of settingsFiles) {
    const raw = await fs.readFile(file)
    if (path.basename(file) === 'settings.json') {
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          activeSettings = parsed
          raw.fill(0)
          continue
        }
      } catch {
        // Preserve malformed legacy data below and use safe defaults for the
        // live settings record.
      }
    }
    records.push({
      kind: 'legacy-private',
      logicalId: `settings-recovery-${records.length + 1}`,
      value: { originalName: path.basename(file), bytes: raw.toString('base64') }
    })
    raw.fill(0)
  }
  records.push({
    kind: 'settings',
    logicalId: 'main',
    value: activeSettings ?? persistedSettings(defaultSettings())
  })

  const conversationFiles = await legacyConversationFiles()
  for (const file of conversationFiles) {
    const raw = await fs.readFile(file)
    let migrated = false
    if (path.extname(file) === '.json') {
      try {
        const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown
        const conversation = parseConversation(parsed)
        records.push({
          kind: 'conversation',
          logicalId: conversation.id,
          value: conversation
        })
        migrated = true
      } catch {
        // Preserve malformed or obsolete data as an encrypted recovery record
        // rather than deleting its only copy.
      }
    }
    if (!migrated) {
      records.push({
        kind: 'legacy-private',
        logicalId: `conversation-recovery-${records.length + 1}`,
        value: { originalName: path.basename(file), bytes: raw.toString('base64') }
      })
    }
    raw.fill(0)
  }
  records.push({
    kind: 'migration',
    logicalId: 'legacy',
    value: {
      importedLegacyPrivateData: settingsFiles.length > 0 || conversationFiles.length > 0
    }
  })
  return records
}

async function removeLegacyPrivateData(): Promise<void> {
  for (const file of await legacySettingsFiles()) await fs.rm(file, { force: true })
  const conversationFiles = await legacyConversationFiles()
  for (const file of conversationFiles) await fs.rm(file, { force: true })
  if (conversationFiles.length > 0) {
    await fs.rm(conversationsDir(), { recursive: true, force: true })
  }
}

async function finishLegacyMigration(
  status: PrivateVaultStatus
): Promise<PrivateVaultStatus> {
  let migrationRequired: boolean
  try {
    migrationRequired = await hasLegacyPrivateData()
  } catch {
    vaultStore().lock()
    return {
      ...vaultStore().status(),
      state: 'error',
      migrationRequired: true,
      error: 'Sibyl could not safely inspect the legacy private-data store.'
    }
  }
  if (status.state !== 'unlocked' || !migrationRequired) {
    return { ...status, migrationRequired }
  }
  try {
    // Preserve a verified ciphertext-only recovery generation before removing
    // the final normal-access copies of the legacy plaintext.
    await vaultStore().createBackup()
    await removeLegacyPrivateData()
    migrationRequired = await hasLegacyPrivateData()
    if (migrationRequired) throw new Error('Legacy private data remains after cleanup.')
    return { ...status, migrationRequired: false }
  } catch {
    // Do not hydrate the renderer while a verified encrypted copy and a
    // plaintext legacy copy coexist. A subsequent passphrase unlock retries
    // cleanup without rebuilding or overwriting the encrypted vault.
    vaultStore().lock()
    return {
      ...vaultStore().status(),
      state: 'error',
      migrationRequired: true,
      error:
        'Your encrypted copy is safe, but Sibyl could not remove the old plaintext files. Close other apps using those files, then unlock again to retry.'
    }
  }
}

export async function initializePrivateVault(): Promise<PrivateVaultStatus> {
  const status = await vaultStore().initialize()
  cachedSettings = null
  return finishLegacyMigration(status)
}

export async function privateVaultStatus(): Promise<PrivateVaultStatus> {
  const status = vaultStore().status()
  try {
    return { ...status, migrationRequired: await hasLegacyPrivateData() }
  } catch {
    return {
      ...status,
      state: 'error',
      migrationRequired: true,
      error: 'Sibyl could not safely inspect the legacy private-data store.'
    }
  }
}

export async function setupPrivateVault(
  recoveryPassphrase: string,
  seamlessOnThisDevice: boolean
): Promise<PrivateVaultStatus> {
  const status = await vaultStore().setup(
    recoveryPassphrase,
    seamlessOnThisDevice,
    await initialPrivateRecords()
  )
  cachedSettings = null
  return finishLegacyMigration(status)
}

export async function unlockPrivateVault(
  recoveryPassphrase: string
): Promise<PrivateVaultStatus> {
  const status = await vaultStore().unlockWithPassphrase(recoveryPassphrase)
  cachedSettings = null
  return finishLegacyMigration(status)
}

export async function unlockPrivateVaultWithPasskey(): Promise<PrivateVaultStatus> {
  const status = await vaultStore().unlockWithPasskey()
  cachedSettings = null
  return finishLegacyMigration(status)
}

export function lockPrivateVault(): PrivateVaultStatus {
  cachedSettings = null
  vaultStore().lock()
  return vaultStore().status()
}

export async function setPrivateVaultSeamless(
  enabled: boolean
): Promise<PrivateVaultStatus> {
  const status = await vaultStore().setSeamlessOnThisDevice(enabled)
  return { ...status, migrationRequired: await hasLegacyPrivateData() }
}

export async function setPrivateVaultPasskey(
  enabled: boolean
): Promise<PrivateVaultStatus> {
  const status = await vaultStore().setPasskey(enabled)
  return { ...status, migrationRequired: await hasLegacyPrivateData() }
}

export async function changePrivateVaultRecoveryPassphrase(
  recoveryPassphrase: string
): Promise<PrivateVaultStatus> {
  const status = await vaultStore().changeRecoveryPassphrase(recoveryPassphrase)
  return { ...status, migrationRequired: false }
}

export async function listPrivateVaultBackups(): Promise<PrivateVaultBackup[]> {
  return vaultStore().listBackups()
}

export async function createPrivateVaultBackup(): Promise<void> {
  await vaultStore().createBackup()
}

export async function verifyPrivateVaultRecovery(): Promise<{
  currentRecords: number
  validBackups: number
}> {
  return vaultStore().verifyRecovery()
}

export async function restorePrivateVaultBackup(id: string): Promise<void> {
  await vaultStore().restoreBackup(id)
  cachedSettings = null
}

let cachedSettings: AppSettings | null = null

async function loadSettingsUnlocked(): Promise<AppSettings> {
  if (cachedSettings) return cachedSettings
  const persisted = (await vaultStore().readJson('settings', 'main')) as PersistedSettings | null
  const base = defaultSettings()
  if (!persisted) {
    cachedSettings = base
    return base
  }
  // Persona library: an upgrade from a pre-persona build has no `personas`. Fold
  // any legacy prompt presets into brief-only personas; if there were none, seed
  // the starter library so the feature is discoverable.
  let personas = persisted.personas
  if (!personas) {
    const migrated = (persisted.promptPresets ?? []).map(presetToPersona)
    personas = migrated.length ? migrated : DEFAULT_PERSONAS.map(clonePersona)
  }

  cachedSettings = {
    ...base,
    ...persisted,
    generation: { ...base.generation, ...persisted.generation },
    load: { ...base.load, ...persisted.load },
    context: { ...base.context, ...persisted.context },
    tts: { ...base.tts, ...persisted.tts },
    accessibility: { ...base.accessibility, ...persisted.accessibility },
    personas: personas.map(normalizePersona),
    hfToken: decryptToken(persisted.hfTokenEnc),
    telemetry: false
  }
  vaultStore().setBackupRetention(cachedSettings.backupRetention)
  return cachedSettings
}

export async function getSettings(): Promise<AppSettings> {
  if (cachedSettings) return cachedSettings
  return settingsQueue.run(loadSettingsUnlocked)
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return settingsQueue.run(async () => {
    const current = await loadSettingsUnlocked()
    const next: AppSettings = {
      ...current,
      ...patch,
      generation: { ...current.generation, ...(patch.generation ?? {}) },
      load: { ...current.load, ...(patch.load ?? {}) },
      context: { ...current.context, ...(patch.context ?? {}) },
      tts: { ...current.tts, ...(patch.tts ?? {}) },
      accessibility: {
        ...current.accessibility,
        ...(patch.accessibility ?? {})
      },
      backupRetention: patch.backupRetention ?? current.backupRetention,
      telemetry: false
    }

    vaultStore().setBackupRetention(next.backupRetention)
    await vaultStore().writeJson('settings', 'main', persistedSettings(next))

    // Only expose the new snapshot after the rename has durably succeeded.
    cachedSettings = next
    return next
  })
}

/** Strip the decrypted secret before settings cross into renderer memory. */
export function settingsForRenderer(settings: AppSettings): RendererSettings {
  const { hfToken, ...visible } = settings
  return { ...visible, hfTokenConfigured: hfToken !== null }
}

export async function getModelsDir(): Promise<string> {
  const s = await getSettings()
  await ensureDir(s.modelsDir)
  return s.modelsDir
}

// ---------------------------------------------------------------------------
// Installed model registry
// ---------------------------------------------------------------------------

let modelRegistry: InstalledModel[] | null = null
let voiceRegistry: InstalledVoice[] | null = null
const storageIssues = new Map<StorageIssue['resource'], StorageIssue>()
const recoveryPaths = new Map<StorageIssue['resource'], string>()

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined
}

async function latestRecoveryCopy(filePath: string): Promise<string | null> {
  const prefix = `${path.basename(filePath)}.corrupt-`
  try {
    const matches = (await fs.readdir(path.dirname(filePath)))
      .filter((name) => name.startsWith(prefix))
      .sort()
    return matches.length ? path.join(path.dirname(filePath), matches[matches.length - 1]) : null
  } catch {
    return null
  }
}

function persistedSettings(settings: AppSettings): PersistedSettings {
  const hfTokenEnc = encryptToken(settings.hfToken)
  if (settings.hfToken != null && hfTokenEnc == null) {
    throw new Error(
      'Could not store your Hugging Face token securely: this system’s secure ' +
        'storage (OS keychain) is unavailable, so the token was not saved.'
    )
  }
  return {
    modelsDir: settings.modelsDir,
    generation: settings.generation,
    load: settings.load,
    context: settings.context,
    theme: settings.theme,
    accent: settings.accent,
    gpu: settings.gpu,
    verifyDownloads: settings.verifyDownloads,
    personas: settings.personas,
    promptPresets: settings.promptPresets,
    generationProfiles: settings.generationProfiles,
    tts: settings.tts,
    accessibility: settings.accessibility,
    backupRetention: settings.backupRetention,
    telemetry: false,
    hfTokenEnc
  }
}

async function readRegistry<T>(
  resource: StorageIssue['resource'],
  filePath: string,
  validate: (value: unknown) => value is T[]
): Promise<T[]> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      const recovery = await latestRecoveryCopy(filePath)
      if (recovery) {
        storageIssues.set(resource, {
          resource,
          kind: 'malformed',
          message: `The ${resource} registry was malformed. Sibyl preserved it as a recovery copy.`,
          recoverable: true
        })
        recoveryPaths.set(resource, recovery)
      }
      return []
    }
    storageIssues.set(resource, {
      resource,
      kind: 'unreadable',
      message: `The ${resource} registry cannot be read. Existing entries were kept in memory.`,
      recoverable: false
    })
    throw err
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!validate(parsed)) throw new Error('Registry schema is invalid')
    storageIssues.delete(resource)
    recoveryPaths.delete(resource)
    return parsed
  } catch {
    const backup = `${filePath}.corrupt-${Date.now()}`
    try {
      await fs.rename(filePath, backup)
    } catch (err) {
      storageIssues.set(resource, {
        resource,
        kind: 'unreadable',
        message: `The ${resource} registry is malformed but could not be quarantined. Restore permissions and retry.`,
        recoverable: false
      })
      throw err
    }
    storageIssues.set(resource, {
      resource,
      kind: 'malformed',
      message: `The ${resource} registry was malformed. Sibyl preserved it as a recovery copy.`,
      recoverable: true
    })
    recoveryPaths.set(resource, backup)
    return []
  }
}

function isModelArray(value: unknown): value is InstalledModel[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as InstalledModel).id === 'string' &&
        typeof (entry as InstalledModel).path === 'string'
    )
  )
}

function isVoiceArray(value: unknown): value is InstalledVoice[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as InstalledVoice).id === 'string' &&
        typeof (entry as InstalledVoice).modelPath === 'string' &&
        typeof (entry as InstalledVoice).configPath === 'string'
    )
  )
}

function durableModel(model: InstalledModel): InstalledModel {
  const { availability: _availability, availabilityError: _error, ...saved } = model
  return saved
}

function durableVoice(voice: InstalledVoice): InstalledVoice {
  const { availability: _availability, availabilityError: _error, ...saved } = voice
  return saved
}

async function fileAvailability(filePath: string): Promise<{
  availability: ResourceAvailability
  availabilityError?: string
}> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.isFile()) return { availability: 'available' }
    return { availability: 'missing', availabilityError: 'The registered path is not a file.' }
  } catch (err) {
    const code = errorCode(err)
    if (code === 'EACCES' || code === 'EPERM') {
      return { availability: 'unreadable', availabilityError: 'The file is not readable.' }
    }
    if (code === 'ENOENT') {
      try {
        await fs.access(path.dirname(filePath))
        return { availability: 'missing', availabilityError: 'The file is missing.' }
      } catch {
        return {
          availability: 'unavailable',
          availabilityError: 'The containing drive or folder is unavailable.'
        }
      }
    }
    return { availability: 'unavailable', availabilityError: 'The file is temporarily unavailable.' }
  }
}

async function loadModelsUnlocked(): Promise<InstalledModel[]> {
  if (modelRegistry && storageIssues.get('models')?.kind !== 'unreadable') return modelRegistry
  try {
    modelRegistry = await readRegistry('models', registryPath(), isModelArray)
  } catch {
    return modelRegistry ?? []
  }
  return modelRegistry
}

export async function listInstalledModels(): Promise<InstalledModel[]> {
  return modelRegistryQueue.run(async () => {
    const models = await loadModelsUnlocked()
    return Promise.all(models.map(async (model) => ({ ...model, ...(await fileAvailability(model.path)) })))
  })
}

export async function upsertInstalledModel(model: InstalledModel): Promise<void> {
  await modelRegistryQueue.run(async () => {
    const models = await loadModelsUnlocked()
    if (storageIssues.get('models')?.kind === 'unreadable') {
      throw new Error('The model registry is unreadable; reconnect it or restore permissions and retry.')
    }
    const next = models.map(durableModel)
    const saved = durableModel(model)
    const idx = next.findIndex((m) => m.id === saved.id)
    if (idx >= 0) next[idx] = saved
    else next.push(saved)
    await atomicWrite(registryPath(), JSON.stringify(next, null, 2))
    modelRegistry = next
  })
}

export async function removeInstalledModel(id: string): Promise<InstalledModel | null> {
  return modelRegistryQueue.run(async () => {
    const models = await loadModelsUnlocked()
    if (storageIssues.get('models')?.kind === 'unreadable') {
      throw new Error('The model registry is unreadable; reconnect it or restore permissions and retry.')
    }
    const target = models.find((m) => m.id === id) ?? null
    const next = models.filter((m) => m.id !== id)
    await atomicWrite(registryPath(), JSON.stringify(next, null, 2))
    modelRegistry = next
    return target
  })
}

export async function getInstalledModel(id: string): Promise<InstalledModel | null> {
  const models = await listInstalledModels()
  return models.find((m) => m.id === id) ?? null
}

/**
 * Register a pre-downloaded .gguf the user already has on disk, *in place* (no
 * copy — these files are often tens of GB). Marked `local` so removal only
 * deregisters it and never deletes the user's file. The id is derived from the
 * absolute path so importing the same file twice updates one entry.
 */
export async function importLocalModel(filePath: string): Promise<InstalledModel> {
  const abs = path.resolve(filePath)
  const stat = await fs.stat(abs)
  if (!stat.isFile()) throw new Error('That path is not a file.')
  const filename = path.basename(abs)
  if (!/\.gguf$/i.test(filename)) throw new Error('Please choose a .gguf model file.')

  const model: InstalledModel = {
    id: `local-${createHash('sha1').update(abs).digest('hex').slice(0, 12)}`,
    repoId: 'local',
    filename,
    path: abs,
    sizeBytes: stat.size,
    quant: parseQuant(filename),
    paramLabel: parseParamLabel(filename),
    local: true,
    installedAt: new Date().toISOString()
  }
  await upsertInstalledModel(model)
  return model
}

export async function relocateInstalledModel(id: string, filePath: string): Promise<InstalledModel> {
  const target = await getInstalledModel(id)
  if (!target) throw new Error('Model registry entry not found.')
  const abs = path.resolve(filePath)
  const stat = await fs.stat(abs)
  if (!stat.isFile() || !/\.gguf$/i.test(abs)) throw new Error('Please choose a .gguf model file.')
  const updated = {
    ...target,
    filename: path.basename(abs),
    path: abs,
    sizeBytes: stat.size,
    // Once the user explicitly points Sibyl at a file, treat it as user-owned;
    // a later library removal must never delete that chosen path.
    local: true,
    availability: 'available' as const,
    availabilityError: undefined
  }
  await upsertInstalledModel(updated)
  return updated
}

// ---------------------------------------------------------------------------
// TTS voice registry
// ---------------------------------------------------------------------------

/** Directory holding downloaded Piper voice models (.onnx + .onnx.json). */
export function voicesDir(): string {
  return path.join(userDataDir(), 'tts', 'voices')
}

export async function getVoicesDir(): Promise<string> {
  const dir = voicesDir()
  await ensureDir(dir)
  return dir
}

function voicesRegistryPath(): string {
  return path.join(userDataDir(), 'tts', 'voices.json')
}

export async function listInstalledVoices(): Promise<InstalledVoice[]> {
  return voiceRegistryQueue.run(async () => {
    if (!voiceRegistry || storageIssues.get('voices')?.kind === 'unreadable') {
      try {
        voiceRegistry = await readRegistry('voices', voicesRegistryPath(), isVoiceArray)
      } catch {
        return voiceRegistry ?? []
      }
    }
    return Promise.all(
      voiceRegistry.map(async (voice) => {
        const model = await fileAvailability(voice.modelPath)
        const config = await fileAvailability(voice.configPath)
        return {
          ...voice,
          ...(model.availability === 'available' ? config : model)
        }
      })
    )
  })
}

export async function upsertInstalledVoice(voice: InstalledVoice): Promise<void> {
  await voiceRegistryQueue.run(async () => {
    if (!voiceRegistry) voiceRegistry = await readRegistry('voices', voicesRegistryPath(), isVoiceArray)
    if (storageIssues.get('voices')?.kind === 'unreadable') {
      throw new Error('The voice registry is unreadable; restore permissions and retry.')
    }
    const next = voiceRegistry.map(durableVoice)
    const saved = durableVoice(voice)
    const idx = next.findIndex((v) => v.id === saved.id)
    if (idx >= 0) next[idx] = saved
    else next.push(saved)
    await atomicWrite(voicesRegistryPath(), JSON.stringify(next, null, 2))
    voiceRegistry = next
  })
}

export async function getInstalledVoice(id: string): Promise<InstalledVoice | null> {
  const voices = await listInstalledVoices()
  return voices.find((v) => v.id === id) ?? null
}

export async function removeInstalledVoice(id: string): Promise<InstalledVoice | null> {
  return voiceRegistryQueue.run(async () => {
    if (!voiceRegistry) voiceRegistry = await readRegistry('voices', voicesRegistryPath(), isVoiceArray)
    if (storageIssues.get('voices')?.kind === 'unreadable') {
      throw new Error('The voice registry is unreadable; restore permissions and retry.')
    }
    const target = voiceRegistry.find((v) => v.id === id) ?? null
    const next = voiceRegistry.filter((v) => v.id !== id)
    await atomicWrite(voicesRegistryPath(), JSON.stringify(next, null, 2))
    voiceRegistry = next
    return target
  })
}

export function listStorageIssues(): StorageIssue[] {
  return [...storageIssues.values()]
}

export function recoveryPathFor(resource: StorageIssue['resource']): string | null {
  return recoveryPaths.get(resource) ?? null
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function listConversations(): Promise<Conversation[]> {
  const records = await vaultStore().listJson('conversation')
  const settings = await getSettings()
  const out: Conversation[] = []
  for (const record of records) {
    const parsed = parseConversation(record.value)
    const candidate = migrateConversationIdentity(parsed, settings.personas)
    if (JSON.stringify(candidate) === JSON.stringify(parsed)) {
      out.push(candidate)
      continue
    }

    // A list can overlap a renderer save. Re-read and migrate while holding the
    // same per-conversation queue as save/delete so an older list snapshot can
    // never overwrite a newer durable snapshot.
    const migrated = await conversationQueue(parsed.id).run(async () => {
      const currentValue = await vaultStore().readJson('conversation', parsed.id)
      if (currentValue == null) return null
      const current = parseConversation(currentValue)
      const latest = migrateConversationIdentity(current, settings.personas)
      if (JSON.stringify(latest) !== JSON.stringify(current)) {
        await vaultStore().writeJson('conversation', latest.id, latest)
      }
      return latest
    })
    if (migrated) out.push(migrated)
  }
  // Most recently updated first.
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return out
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const canonical = parseCanonicalId(id, 'conversationId')
  return conversationQueue(canonical).run(async () => {
    const value = await vaultStore().readJson('conversation', canonical)
    if (value == null) return null
    const parsed = parseConversation(value)
    const migrated = migrateConversationIdentity(parsed, (await getSettings()).personas)
    if (JSON.stringify(migrated) !== JSON.stringify(parsed)) {
      await vaultStore().writeJson('conversation', canonical, migrated)
    }
    return migrated
  })
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  await conversationQueue(conversation.id).run(async () => {
    const migrated = migrateConversationIdentity(conversation, (await getSettings()).personas)
    const existing = await vaultStore().readJson('conversation', conversation.id)
    const durable = existing == null ? null : parseConversation(existing)
    if (durable && durable.updatedAt > migrated.updatedAt) {
      throw new Error('A newer conversation snapshot is already saved.')
    }
    await vaultStore().writeJson('conversation', migrated.id, migrated)
  })
}

export async function deleteConversation(id: string): Promise<void> {
  const canonical = parseCanonicalId(id, 'conversationId')
  await conversationQueue(canonical).run(async () => {
    await vaultStore().delete('conversation', canonical)
  })
}

/**
 * Commit a validated portable import as one authenticated vault-index swap.
 * Conversation bundles retain this device's global preferences; full-library
 * bundles restore portable preferences but never replace paths or credentials.
 */
export async function applyPortableImport(
  prepared: PreparedPortableImport
): Promise<{ conversationIds: string[] }> {
  return settingsQueue.run(async () => {
    const current = await loadSettingsUnlocked()
    const { personas: _portablePersonas, ...portableSettings } = prepared.settings
    const importedSettings: RendererSettingsPatch =
      prepared.scope === 'library' ? portableSettings : {}
    const mergedPersonas = [...current.personas, ...prepared.personas]
    const next: AppSettings = {
      ...current,
      ...importedSettings,
      generation: {
        ...current.generation,
        ...(importedSettings.generation ?? {})
      },
      load: {
        ...current.load,
        ...(importedSettings.load ?? {})
      },
      context: {
        ...current.context,
        ...(importedSettings.context ?? {})
      },
      tts: {
        ...current.tts,
        ...(importedSettings.tts ?? {})
      },
      accessibility: {
        ...current.accessibility,
        ...(importedSettings.accessibility ?? {})
      },
      personas: mergedPersonas,
      modelsDir: current.modelsDir,
      hfToken: current.hfToken,
      telemetry: false
    }
    const records: InitialPrivateRecord[] = [
      {
        kind: 'settings',
        logicalId: 'main',
        value: persistedSettings(next)
      },
      ...prepared.conversations.map((conversation) => ({
        kind: 'conversation',
        logicalId: conversation.id,
        value: conversation
      }))
    ]
    await vaultStore().writeJsonBatch(records)
    vaultStore().setBackupRetention(next.backupRetention)
    cachedSettings = next
    return { conversationIds: prepared.conversations.map((conversation) => conversation.id) }
  })
}
