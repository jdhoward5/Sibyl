import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { AppSettings, Persona, RendererSettingsPatch } from '@shared/types'
import {
  PORTABLE_BUNDLE_VERSION,
  portableModelMetadata,
  preparePortableImport,
  type PortableBundlePayload,
  type PortableBundlePreview,
  type PreparedPortableImport
} from '@shared/portable'
import {
  applyPortableImport,
  getConversation,
  getSettings,
  listConversations,
  listInstalledModels
} from './store'
import { decryptPortableBundle, encryptPortableBundle } from './portable'

const MAX_BUNDLE_BYTES = 96 * 1024 * 1024
const IMPORT_SESSION_MS = 5 * 60 * 1000

interface ImportSession {
  prepared: PreparedPortableImport
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

const imports = new Map<string, ImportSession>()

function portableSettings(settings: AppSettings): RendererSettingsPatch {
  return {
    generation: structuredClone(settings.generation),
    load: structuredClone(settings.load),
    context: structuredClone(settings.context),
    theme: settings.theme,
    accent: settings.accent,
    gpu: settings.gpu,
    verifyDownloads: settings.verifyDownloads,
    promptPresets: structuredClone(settings.promptPresets),
    generationProfiles: structuredClone(settings.generationProfiles),
    tts: structuredClone(settings.tts),
    accessibility: structuredClone(settings.accessibility),
    backupRetention: settings.backupRetention,
    telemetry: false
  }
}

function referencedPersonas(
  conversation: NonNullable<Awaited<ReturnType<typeof getConversation>>>,
  personas: Persona[]
): Persona[] {
  const ids = new Set<string>()
  if (conversation.personaId) ids.add(conversation.personaId)
  for (const id of conversation.cast ?? []) ids.add(id)
  if (conversation.personaSnapshot) ids.add(conversation.personaSnapshot.sourcePersonaId)
  for (const snapshot of conversation.castSnapshots ?? []) {
    ids.add(snapshot.sourcePersonaId)
    for (const relationship of snapshot.persona.relationships ?? []) {
      ids.add(relationship.personaId)
    }
  }
  for (const override of conversation.personaOverrides ?? []) {
    ids.add(override.personaId)
    for (const relationship of override.relationships ?? []) {
      ids.add(relationship.personaId)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const persona of personas) {
      if (!ids.has(persona.id)) continue
      for (const relationship of persona.relationships ?? []) {
        if (!ids.has(relationship.personaId)) {
          ids.add(relationship.personaId)
          changed = true
        }
      }
    }
  }
  return personas.filter((persona) => ids.has(persona.id))
}

async function payloadForConversation(id: string): Promise<PortableBundlePayload> {
  const [conversation, settings, models] = await Promise.all([
    getConversation(id),
    getSettings(),
    listInstalledModels()
  ])
  if (!conversation) throw new Error('Conversation not found.')
  const modelIds = new Set(conversation.modelId ? [conversation.modelId] : [])
  return {
    schemaVersion: PORTABLE_BUNDLE_VERSION,
    scope: 'conversation',
    exportedAt: new Date().toISOString(),
    conversations: [conversation],
    personas: referencedPersonas(conversation, settings.personas),
    settings: portableSettings(settings),
    models: models.filter((model) => modelIds.has(model.id)).map(portableModelMetadata)
  }
}

async function payloadForLibrary(): Promise<PortableBundlePayload> {
  const [conversations, settings, models] = await Promise.all([
    listConversations(),
    getSettings(),
    listInstalledModels()
  ])
  return {
    schemaVersion: PORTABLE_BUNDLE_VERSION,
    scope: 'library',
    exportedAt: new Date().toISOString(),
    conversations,
    personas: structuredClone(settings.personas),
    settings: portableSettings(settings),
    models: models.map(portableModelMetadata)
  }
}

export async function exportPortableConversation(
  id: string,
  recoveryPassphrase: string
): Promise<string> {
  return encryptPortableBundle(await payloadForConversation(id), recoveryPassphrase)
}

export async function exportPortableLibrary(recoveryPassphrase: string): Promise<string> {
  return encryptPortableBundle(await payloadForLibrary(), recoveryPassphrase)
}

async function readBundle(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BUNDLE_BYTES) {
    throw new Error('The selected Sibyl bundle is empty or exceeds the supported size.')
  }
  const bytes = await fs.readFile(filePath)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    bytes.fill(0)
  }
}

function removeExpiredImports(now = Date.now()): void {
  for (const [token, session] of imports) {
    if (session.expiresAt <= now) {
      clearTimeout(session.timer)
      imports.delete(token)
    }
  }
}

function deleteImport(token: string): void {
  const session = imports.get(token)
  if (!session) return
  clearTimeout(session.timer)
  imports.delete(token)
}

export function clearPortableImports(): void {
  for (const token of imports.keys()) deleteImport(token)
}

export async function inspectPortableImport(
  filePath: string,
  recoveryPassphrase: string
): Promise<PortableBundlePreview> {
  removeExpiredImports()
  const payload = await decryptPortableBundle(await readBundle(filePath), recoveryPassphrase)
  const [existingConversations, settings, installedModels] = await Promise.all([
    listConversations(),
    getSettings(),
    listInstalledModels()
  ])
  const prepared = preparePortableImport({
    payload,
    existingPersonas: settings.personas,
    existingConversations,
    installedModels,
    newId: randomUUID
  })
  const token = randomBytes(24).toString('base64url')
  const session: ImportSession = {
    prepared,
    expiresAt: Date.now() + IMPORT_SESSION_MS,
    timer: setTimeout(() => deleteImport(token), IMPORT_SESSION_MS)
  }
  session.timer.unref()
  imports.set(token, session)
  return {
    token,
    scope: payload.scope,
    exportedAt: payload.exportedAt,
    conversationCount: prepared.conversations.length,
    personaCount: prepared.personas.length,
    modelCount: payload.models.length,
    unresolvedModelCount: prepared.unresolvedModelCount,
    collisionCount: prepared.collisionCount
  }
}

export async function commitPortableImport(
  token: string
): Promise<{ conversationIds: string[] }> {
  removeExpiredImports()
  const session = imports.get(token)
  if (!session) {
    throw new Error('This import preview expired. Open the encrypted bundle again.')
  }
  deleteImport(token)
  return applyPortableImport(session.prepared)
}

export function discardPortableImport(token: string): void {
  deleteImport(token)
}
