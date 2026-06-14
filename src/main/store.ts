import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings, Conversation, InstalledModel } from '@shared/types'
import { DEFAULT_CONTEXT_SETTINGS, DEFAULT_GENERATION_OPTIONS } from '@shared/types'

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

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.tmp`
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, filePath)
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
        'You are Oracle, a helpful, knowledgeable and concise AI assistant running locally on the user’s machine.'
    },
    context: { ...DEFAULT_CONTEXT_SETTINGS },
    theme: 'dark',
    gpu: 'auto',
    verifyDownloads: true,
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

export async function getSettings(): Promise<AppSettings> {
  if (cachedSettings) return cachedSettings
  const persisted = await readJSON<PersistedSettings | null>(settingsPath(), null)
  const base = defaultSettings()
  if (!persisted) {
    cachedSettings = base
    return base
  }
  cachedSettings = {
    ...base,
    ...persisted,
    generation: { ...base.generation, ...persisted.generation },
    load: { ...base.load, ...persisted.load },
    context: { ...base.context, ...persisted.context },
    hfToken: decryptToken(persisted.hfTokenEnc),
    telemetry: false
  }
  return cachedSettings
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    generation: { ...current.generation, ...(patch.generation ?? {}) },
    load: { ...current.load, ...(patch.load ?? {}) },
    context: { ...current.context, ...(patch.context ?? {}) },
    telemetry: false
  }

  // Encrypt the token for persistence. If a non-null token can't be encrypted
  // (OS secure storage unavailable / keychain error), don't silently drop it:
  // clear it so memory and disk agree, then report the failure to the caller.
  const hfTokenEnc = encryptToken(next.hfToken)
  const tokenStoreFailed = next.hfToken != null && hfTokenEnc == null
  if (tokenStoreFailed) next.hfToken = null

  cachedSettings = next

  const persisted: PersistedSettings = {
    modelsDir: next.modelsDir,
    generation: next.generation,
    load: next.load,
    context: next.context,
    theme: next.theme,
    gpu: next.gpu,
    verifyDownloads: next.verifyDownloads,
    telemetry: false,
    hfTokenEnc
  }
  await atomicWrite(settingsPath(), JSON.stringify(persisted, null, 2))

  if (tokenStoreFailed) {
    throw new Error(
      'Could not store your Hugging Face token securely: this system’s secure ' +
        'storage (OS keychain) is unavailable, so the token was not saved.'
    )
  }
  return next
}

export async function getModelsDir(): Promise<string> {
  const s = await getSettings()
  await ensureDir(s.modelsDir)
  return s.modelsDir
}

// ---------------------------------------------------------------------------
// Installed model registry
// ---------------------------------------------------------------------------

export async function listInstalledModels(): Promise<InstalledModel[]> {
  const models = await readJSON<InstalledModel[]>(registryPath(), [])
  // Drop entries whose files no longer exist on disk.
  const alive = models.filter((m) => existsSync(m.path))
  if (alive.length !== models.length) {
    await atomicWrite(registryPath(), JSON.stringify(alive, null, 2))
  }
  return alive
}

export async function upsertInstalledModel(model: InstalledModel): Promise<void> {
  const models = await readJSON<InstalledModel[]>(registryPath(), [])
  const idx = models.findIndex((m) => m.id === model.id)
  if (idx >= 0) models[idx] = model
  else models.push(model)
  await atomicWrite(registryPath(), JSON.stringify(models, null, 2))
}

export async function removeInstalledModel(id: string): Promise<InstalledModel | null> {
  const models = await readJSON<InstalledModel[]>(registryPath(), [])
  const target = models.find((m) => m.id === id) ?? null
  const next = models.filter((m) => m.id !== id)
  await atomicWrite(registryPath(), JSON.stringify(next, null, 2))
  return target
}

export async function getInstalledModel(id: string): Promise<InstalledModel | null> {
  const models = await listInstalledModels()
  return models.find((m) => m.id === id) ?? null
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function convFile(id: string): string {
  // Guard against path traversal from a crafted id.
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  return path.join(conversationsDir(), `${safe}.json`)
}

export async function listConversations(): Promise<Conversation[]> {
  await ensureDir(conversationsDir())
  const files = await fs.readdir(conversationsDir())
  const out: Conversation[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const conv = await readJSON<Conversation | null>(path.join(conversationsDir(), f), null)
    if (conv) out.push(conv)
  }
  // Most recently updated first.
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return out
}

export async function getConversation(id: string): Promise<Conversation | null> {
  return readJSON<Conversation | null>(convFile(id), null)
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  await atomicWrite(convFile(conversation.id), JSON.stringify(conversation, null, 2))
}

export async function deleteConversation(id: string): Promise<void> {
  try {
    await fs.unlink(convFile(id))
  } catch {
    /* already gone */
  }
}
