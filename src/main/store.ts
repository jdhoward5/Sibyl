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
  RendererSettings,
  ResourceAvailability,
  StorageIssue,
  SystemPromptPreset
} from '@shared/types'
import {
  DEFAULT_CONTEXT_SETTINGS,
  DEFAULT_GENERATION_OPTIONS,
  DEFAULT_GENERATION_PROFILES
} from '@shared/types'
import { DEFAULT_TTS_SETTINGS, type InstalledVoice } from '@shared/tts'
import { DEFAULT_ACCENT } from '@shared/themes'
import { DEFAULT_PERSONAS, gradientFor, initialsOf } from '@shared/personas'
import { parseCanonicalId, parseConversation } from '@shared/validation'
import { SerialQueue } from '@shared/serial'

/** Deep-ish clone so callers can't mutate the shared default persona objects. */
function clonePersona(p: Persona): Persona {
  return {
    ...p,
    avatar: { ...p.avatar, gradient: [...p.avatar.gradient] },
    voiceTags: [...p.voiceTags],
    generation: p.generation ? { ...p.generation } : undefined
  }
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

function settingsPath(): string {
  return path.join(userDataDir(), 'settings.json')
}

function registryPath(): string {
  return path.join(userDataDir(), 'models.json')
}

function conversationsDir(): string {
  return path.join(userDataDir(), 'conversations')
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

async function readJSON<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
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

let cachedSettings: AppSettings | null = null

async function loadSettingsUnlocked(): Promise<AppSettings> {
  if (cachedSettings) return cachedSettings
  const persisted = await readJSON<PersistedSettings | null>(settingsPath(), null)
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
    personas,
    hfToken: decryptToken(persisted.hfTokenEnc),
    telemetry: false
  }
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
      telemetry: false
    }

    // Encrypt the token for persistence. If a non-null token can't be encrypted
    // (OS secure storage unavailable / keychain error), don't silently drop it.
    const hfTokenEnc = encryptToken(next.hfToken)
    const tokenStoreFailed = next.hfToken != null && hfTokenEnc == null
    if (tokenStoreFailed) {
      throw new Error(
        'Could not store your Hugging Face token securely: this system’s secure ' +
          'storage (OS keychain) is unavailable, so the token was not saved.'
      )
    }

    const persisted: PersistedSettings = {
      modelsDir: next.modelsDir,
      generation: next.generation,
      load: next.load,
      context: next.context,
      theme: next.theme,
      accent: next.accent,
      gpu: next.gpu,
      verifyDownloads: next.verifyDownloads,
      personas: next.personas,
      promptPresets: next.promptPresets,
      generationProfiles: next.generationProfiles,
      tts: next.tts,
      telemetry: false,
      hfTokenEnc
    }
    await atomicWrite(settingsPath(), JSON.stringify(persisted, null, 2))

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

function convFile(id: string): string {
  // Reject malformed ids instead of sanitizing distinct inputs into the same
  // filesystem path.
  return path.join(conversationsDir(), `${parseCanonicalId(id, 'conversationId')}.json`)
}

/** Move a corrupt conversation file aside so it stops breaking loads but isn't lost. */
async function quarantineFile(filePath: string): Promise<void> {
  await fs.rename(filePath, `${filePath}.corrupt`).catch(() => {})
}

/**
 * Read + validate one conversation file. Returns null (and quarantines the file)
 * when it can't be parsed or fails schema validation, so a single corrupt file
 * can't crash the app or take down the whole list.
 */
async function loadConversation(filePath: string): Promise<Conversation | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return null // missing / unreadable — not corrupt, just absent
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await quarantineFile(filePath)
    return null
  }
  try {
    return parseConversation(parsed)
  } catch {
    await quarantineFile(filePath)
    return null
  }
}

export async function listConversations(): Promise<Conversation[]> {
  await ensureDir(conversationsDir())
  const files = await fs.readdir(conversationsDir())
  const out: Conversation[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const id = f.slice(0, -5)
    const conv = await conversationQueue(id).run(() =>
      loadConversation(path.join(conversationsDir(), f))
    )
    if (conv) out.push(conv)
  }
  // Most recently updated first.
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return out
}

export async function getConversation(id: string): Promise<Conversation | null> {
  return conversationQueue(id).run(() => loadConversation(convFile(id)))
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  await conversationQueue(conversation.id).run(async () => {
    const filePath = convFile(conversation.id)
    const durable = await loadConversation(filePath)
    if (durable && durable.updatedAt > conversation.updatedAt) {
      throw new Error('A newer conversation snapshot is already saved.')
    }
    await atomicWrite(filePath, JSON.stringify(conversation, null, 2))
  })
}

export async function deleteConversation(id: string): Promise<void> {
  await conversationQueue(id).run(async () => {
    try {
      await fs.unlink(convFile(id))
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err
    }
  })
}
