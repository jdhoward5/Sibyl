// Runtime validation for values crossing the renderer → main IPC boundary.
// Keep this module pure: shared code must never import Node or Electron.

import type {
  AppSettings,
  ChatMessage,
  CompactionInfo,
  ContextSettings,
  Conversation,
  ConversationOverrides,
  ContextUsageProjection,
  GenerationOptions,
  GenerationProfile,
  Persona,
  PersonaRelationship,
  PersonaSnapshot,
  RoleplayFact,
  RoleplayState,
  SceneDirection,
  SceneDirectorSettings,
  ScenePersonaOverride,
  RendererSettingsPatch,
  SystemPromptPreset,
  UserCharacter
} from './types'
import { DEFAULT_CONTEXT_SETTINGS } from './types'
import { normalizeCompactionTarget } from './context'
import type {
  ChatAbortRequest,
  ChatAdvanceRequest,
  ChatSendRequest,
  TtsSpeakRequest,
  VaultSetupRequest
} from './ipc'
import type { TtsSettings } from './tts'
import { ACCENT_THEMES } from './themes'

export const IPC_LIMITS = {
  id: 128,
  modelId: 1_024,
  repoId: 200,
  repoFilename: 512,
  query: 200,
  token: 4096,
  message: 100_000,
  conversationMessages: 10_000,
  conversationText: 5_000_000,
  settingsText: 5_000_000,
  personas: 256,
  cast: 32,
  stopSequences: 16,
  stopSequence: 256,
  profiles: 128
} as const

type Dict = Record<string, unknown>

function invalid(path: string, detail: string): never {
  throw new Error(`Invalid IPC argument ${path}: ${detail}.`)
}

function object(value: unknown, path: string): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'expected an object')
  return value as Dict
}

function keys(value: Dict, allowed: readonly string[], path: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  if (extra) invalid(`${path}.${extra}`, 'unknown field')
}

function string(value: unknown, path: string, max: number, allowEmpty = true): string {
  if (typeof value !== 'string') invalid(path, 'expected a string')
  if (!allowEmpty && value.length === 0) invalid(path, 'must not be empty')
  if (value.length > max) invalid(path, `must be at most ${max} characters`)
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'expected a boolean')
  return value
}

function finite(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'expected a finite number')
  const clamped = Math.min(max, Math.max(min, value))
  return integer ? Math.round(clamped) : clamped
}

function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value)
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value)
}

const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function parseCanonicalId(value: unknown, path = 'id'): string {
  const id = string(value, path, IPC_LIMITS.id, false)
  if (!CANONICAL_ID.test(id)) invalid(path, 'must be a canonical identifier')
  return id
}

export function parseModelId(value: unknown, path = 'modelId'): string {
  const id = string(value, path, IPC_LIMITS.modelId, false)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) invalid(path, 'contains invalid characters')
  if (id.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    invalid(path, 'contains an invalid path segment')
  }
  return id
}

export function parseRepoId(value: unknown, path = 'repoId'): string {
  const id = string(value, path, IPC_LIMITS.repoId, false)
  const parts = id.split('/')
  if (
    parts.length !== 2 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) ||
        part === '.' ||
        part === '..'
    )
  ) {
    invalid(path, 'expected a canonical owner/repository id')
  }
  return id
}

export function parseRepoFilename(value: unknown, path = 'filename'): string {
  const filename = string(value, path, IPC_LIMITS.repoFilename, false)
  if (filename.includes('\\') || filename.startsWith('/') || filename.includes('\0')) {
    invalid(path, 'must be a repository-relative path')
  }
  const parts = filename.split('/')
  if (
    parts.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
    ) ||
    !filename.toLowerCase().endsWith('.gguf')
  ) {
    invalid(path, 'must identify a canonical GGUF file')
  }
  return filename
}

export function parseSearchQuery(value: unknown): string {
  return string(value, 'query', IPC_LIMITS.query)
}

export function parseSortKey(value: unknown): 'trending' | 'downloads' | 'likes' | undefined {
  if (value === undefined) return undefined
  if (value !== 'trending' && value !== 'downloads' && value !== 'likes') {
    invalid('sort', 'unsupported sort key')
  }
  return value
}

export function parseExportFormat(value: unknown): 'markdown' | 'json' | 'text' {
  if (value !== 'markdown' && value !== 'json' && value !== 'text') {
    invalid('format', 'unsupported export format')
  }
  return value
}

export function parseHfToken(value: unknown): string {
  const token = string(value, 'token', IPC_LIMITS.token, false)
  if (token.trim() !== token || /\s/.test(token)) invalid('token', 'must not contain whitespace')
  return token
}

export function parseRecoveryPassphrase(value: unknown): string {
  const passphrase = string(value, 'recoveryPassphrase', 1024, false)
  if (passphrase.length < 12) {
    invalid('recoveryPassphrase', 'must be at least 12 characters')
  }
  if (new TextEncoder().encode(passphrase).length > 1024) {
    invalid('recoveryPassphrase', 'must be at most 1024 UTF-8 bytes')
  }
  return passphrase
}

export function parseVaultSetupRequest(value: unknown): VaultSetupRequest {
  const v = object(value, 'vaultSetup')
  keys(v, ['recoveryPassphrase', 'seamlessOnThisDevice'], 'vaultSetup')
  return {
    recoveryPassphrase: parseRecoveryPassphrase(v.recoveryPassphrase),
    seamlessOnThisDevice: bool(v.seamlessOnThisDevice, 'vaultSetup.seamlessOnThisDevice')
  }
}

export function parseVaultBackupId(value: unknown): string {
  const id = string(value, 'vaultBackupId', 26, false)
  if (!/^[A-Za-z0-9_-]{22}\.svb$/.test(id)) {
    invalid('vaultBackupId', 'must be an opaque encrypted-backup identifier')
  }
  return id
}

export function parsePortableImportToken(value: unknown): string {
  const token = string(value, 'portableImportToken', 64, false)
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
    invalid('portableImportToken', 'must be an opaque import-preview token')
  }
  return token
}

function parseGenerationOptions(
  value: unknown,
  path: string,
  partial: true
): Partial<GenerationOptions>
function parseGenerationOptions(value: unknown, path: string, partial?: false): GenerationOptions
function parseGenerationOptions(
  value: unknown,
  path: string,
  partial = false
): GenerationOptions | Partial<GenerationOptions> {
  const v = object(value, path)
  const allowed = [
    'temperature',
    'topP',
    'topK',
    'minP',
    'maxTokens',
    'repeatPenalty',
    'seed',
    'stopSequences'
  ]
  keys(v, allowed, path)
  const required = allowed.slice(0, 6)
  if (!partial) {
    const missing = required.find((key) => v[key] === undefined)
    if (missing) invalid(`${path}.${missing}`, 'missing field')
  }
  const out: Partial<GenerationOptions> = {}
  if (v.temperature !== undefined) out.temperature = finite(v.temperature, `${path}.temperature`, 0, 5)
  if (v.topP !== undefined) out.topP = finite(v.topP, `${path}.topP`, 0, 1)
  if (v.topK !== undefined) out.topK = finite(v.topK, `${path}.topK`, 0, 10_000, true)
  if (v.minP !== undefined) out.minP = finite(v.minP, `${path}.minP`, 0, 1)
  if (v.maxTokens !== undefined) out.maxTokens = finite(v.maxTokens, `${path}.maxTokens`, 1, 131_072, true)
  if (v.repeatPenalty !== undefined) {
    out.repeatPenalty = finite(v.repeatPenalty, `${path}.repeatPenalty`, 0, 10)
  }
  if (v.seed !== undefined) out.seed = finite(v.seed, `${path}.seed`, -2_147_483_648, 2_147_483_647, true)
  if (v.stopSequences !== undefined) {
    if (!Array.isArray(v.stopSequences)) invalid(`${path}.stopSequences`, 'expected an array')
    if (v.stopSequences.length > IPC_LIMITS.stopSequences) {
      invalid(`${path}.stopSequences`, `must contain at most ${IPC_LIMITS.stopSequences} items`)
    }
    out.stopSequences = v.stopSequences.map((s, i) =>
      string(s, `${path}.stopSequences[${i}]`, IPC_LIMITS.stopSequence, false)
    )
  }
  return out as GenerationOptions | Partial<GenerationOptions>
}

function parseStats(value: unknown, path: string): ChatMessage['stats'] {
  const v = object(value, path)
  keys(v, ['promptTokens', 'completionTokens', 'tokensPerSecond', 'durationMs', 'contextTokens'], path)
  return {
    promptTokens: finite(v.promptTokens, `${path}.promptTokens`, 0, 100_000_000, true),
    completionTokens: finite(v.completionTokens, `${path}.completionTokens`, 0, 100_000_000, true),
    tokensPerSecond: finite(v.tokensPerSecond, `${path}.tokensPerSecond`, 0, 1_000_000),
    durationMs: finite(v.durationMs, `${path}.durationMs`, 0, 86_400_000, true),
    contextTokens:
      v.contextTokens === undefined
        ? undefined
        : finite(v.contextTokens, `${path}.contextTokens`, 0, 100_000_000, true)
  }
}

function parseMessage(value: unknown, path: string): ChatMessage {
  const v = object(value, path)
  keys(v, ['id', 'role', 'content', 'createdAt', 'stats', 'error', 'stopped', 'speakerId', 'speakerName', 'director', 'segments', 'directionId'], path)
  if (v.role !== 'system' && v.role !== 'user' && v.role !== 'assistant') {
    invalid(`${path}.role`, 'unsupported role')
  }
  let segments: ChatMessage['segments']
  if (v.segments !== undefined) {
    if (!Array.isArray(v.segments) || v.segments.length > 128) {
      invalid(`${path}.segments`, 'expected an array of at most 128 items')
    }
    segments = v.segments.map((item, index) => {
      const segmentPath = `${path}.segments[${index}]`
      const segment = object(item, segmentPath)
      keys(segment, ['id', 'kind', 'content', 'visibility'], segmentPath)
      if (!['dialogue', 'action', 'thought', 'note'].includes(segment.kind as string)) {
        invalid(`${segmentPath}.kind`, 'unsupported segment kind')
      }
      return {
        id: parseCanonicalId(segment.id, `${segmentPath}.id`),
        kind: segment.kind as NonNullable<ChatMessage['segments']>[number]['kind'],
        content: string(segment.content, `${segmentPath}.content`, IPC_LIMITS.message),
        visibility: parseKnowledgeVisibility(segment.visibility, `${segmentPath}.visibility`)
      }
    })
  }
  return {
    id: parseCanonicalId(v.id, `${path}.id`),
    role: v.role,
    content: string(v.content, `${path}.content`, IPC_LIMITS.message),
    createdAt: string(v.createdAt, `${path}.createdAt`, 64, false),
    stats: optional(v.stats, (x) => parseStats(x, `${path}.stats`)),
    error: optional(v.error, (x) => string(x, `${path}.error`, 2_000)),
    stopped: optional(v.stopped, (x) => bool(x, `${path}.stopped`)),
    speakerId: optional(v.speakerId, (x) => parseCanonicalId(x, `${path}.speakerId`)),
    speakerName: optional(v.speakerName, (x) => string(x, `${path}.speakerName`, 200, false)),
    director: optional(v.director, (x) => bool(x, `${path}.director`)),
    segments,
    directionId: optional(v.directionId, (x) => parseCanonicalId(x, `${path}.directionId`))
  }
}

function parseKnowledgeVisibility(value: unknown, path: string) {
  const v = object(value, path)
  keys(v, ['kind', 'characterIds'], path)
  if (v.kind === 'public') {
    if (v.characterIds !== undefined) invalid(`${path}.characterIds`, 'not allowed for public visibility')
    return { kind: 'public' as const }
  }
  if (v.kind !== 'private') invalid(`${path}.kind`, 'unsupported visibility')
  if (!Array.isArray(v.characterIds) || v.characterIds.length < 1 || v.characterIds.length > IPC_LIMITS.cast) {
    invalid(`${path}.characterIds`, `expected 1–${IPC_LIMITS.cast} character ids`)
  }
  const characterIds = v.characterIds.map((id, index) =>
    parseCanonicalId(id, `${path}.characterIds[${index}]`)
  )
  if (new Set(characterIds).size !== characterIds.length) {
    invalid(`${path}.characterIds`, 'character ids must be unique')
  }
  return { kind: 'private' as const, characterIds }
}

function parseCompaction(value: unknown, path: string): CompactionInfo {
  const v = object(value, path)
  keys(
    v,
    ['summary', 'throughMessageId', 'foldedCount', 'originalTokens', 'summaryTokens', 'compactedAt'],
    path
  )
  return {
    summary: string(v.summary, `${path}.summary`, IPC_LIMITS.message),
    throughMessageId: parseCanonicalId(v.throughMessageId, `${path}.throughMessageId`),
    foldedCount: finite(v.foldedCount, `${path}.foldedCount`, 0, IPC_LIMITS.conversationMessages, true),
    originalTokens: finite(v.originalTokens, `${path}.originalTokens`, 0, 100_000_000, true),
    summaryTokens: finite(v.summaryTokens, `${path}.summaryTokens`, 0, 100_000_000, true),
    compactedAt: string(v.compactedAt, `${path}.compactedAt`, 64, false)
  }
}

function parseOverrides(value: unknown, path: string): ConversationOverrides {
  const v = object(value, path)
  keys(v, ['systemPrompt', 'generation'], path)
  return {
    systemPrompt: optional(v.systemPrompt, (x) => string(x, `${path}.systemPrompt`, IPC_LIMITS.message)),
    generation: optional(v.generation, (x) => parseGenerationOptions(x, `${path}.generation`))
  }
}

function parseUserCharacter(value: unknown, path: string): UserCharacter {
  const v = object(value, path)
  keys(v, ['name', 'description'], path)
  return {
    name: string(v.name, `${path}.name`, 200, false),
    description: string(v.description, `${path}.description`, 10_000)
  }
}

function parsePersonaSnapshot(value: unknown, path: string): PersonaSnapshot {
  const v = object(value, path)
  keys(v, ['schemaVersion', 'sourcePersonaId', 'sourceVersion', 'capturedAt', 'persona'], path)
  if (v.schemaVersion !== 1) invalid(`${path}.schemaVersion`, 'unsupported snapshot schema')
  return {
    schemaVersion: 1,
    sourcePersonaId: parseCanonicalId(v.sourcePersonaId, `${path}.sourcePersonaId`),
    sourceVersion: finite(v.sourceVersion, `${path}.sourceVersion`, 1, 1_000_000_000, true),
    capturedAt: string(v.capturedAt, `${path}.capturedAt`, 64, false),
    persona: parsePersona(v.persona, `${path}.persona`)
  }
}

function parseStringList(value: unknown, path: string, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max) {
    invalid(path, `expected an array of at most ${max} items`)
  }
  return value.map((item, index) => string(item, `${path}[${index}]`, 10_000, false))
}

function parseRelationship(value: unknown, path: string): PersonaRelationship {
  const v = object(value, path)
  keys(v, ['personaId', 'summary', 'visibility'], path)
  if (v.visibility !== 'public' && v.visibility !== 'private') {
    invalid(`${path}.visibility`, 'unsupported visibility')
  }
  return {
    personaId: parseCanonicalId(v.personaId, `${path}.personaId`),
    summary: string(v.summary, `${path}.summary`, 10_000, false),
    visibility: v.visibility
  }
}

function parsePersonaOverride(value: unknown, path: string): ScenePersonaOverride {
  const v = object(value, path)
  keys(v, ['personaId', 'publicDescription', 'privateMotivations', 'secrets', 'behavioralConstraints', 'speechGuidance', 'relationships', 'voice'], path)
  let relationships: PersonaRelationship[] | undefined
  if (v.relationships !== undefined) {
    if (!Array.isArray(v.relationships) || v.relationships.length > 128) {
      invalid(`${path}.relationships`, 'expected an array of at most 128 items')
    }
    relationships = v.relationships.map((item, index) =>
      parseRelationship(item, `${path}.relationships[${index}]`)
    )
  }
  let voice: ScenePersonaOverride['voice']
  if (v.voice !== undefined) {
    const source = object(v.voice, `${path}.voice`)
    keys(source, ['voiceId', 'rate'], `${path}.voice`)
    voice = {
      voiceId: optional(source.voiceId, (item) => parseCanonicalId(item, `${path}.voice.voiceId`)),
      rate: optional(source.rate, (item) => finite(item, `${path}.voice.rate`, 0.5, 2))
    }
  }
  return {
    personaId: parseCanonicalId(v.personaId, `${path}.personaId`),
    publicDescription: optional(v.publicDescription, (item) => string(item, `${path}.publicDescription`, 10_000)),
    privateMotivations: optional(v.privateMotivations, (item) => parseStringList(item, `${path}.privateMotivations`)),
    secrets: optional(v.secrets, (item) => parseStringList(item, `${path}.secrets`)),
    behavioralConstraints: optional(v.behavioralConstraints, (item) => parseStringList(item, `${path}.behavioralConstraints`)),
    speechGuidance: optional(v.speechGuidance, (item) => string(item, `${path}.speechGuidance`, 10_000)),
    relationships,
    voice
  }
}

function parseRoleplayFact(value: unknown, path: string): RoleplayFact {
  const v = object(value, path)
  keys(v, ['id', 'category', 'text', 'visibility', 'provenanceMessageIds', 'userAuthored', 'pinned', 'updatedAt'], path)
  const categories: RoleplayFact['category'][] = [
    'time', 'location', 'object', 'condition', 'obligation', 'relationship', 'plot', 'goal', 'other'
  ]
  if (!categories.includes(v.category as RoleplayFact['category'])) {
    invalid(`${path}.category`, 'unsupported fact category')
  }
  const provenanceMessageIds = parseStringList(v.provenanceMessageIds, `${path}.provenanceMessageIds`, 256)
    .map((id, index) => parseCanonicalId(id, `${path}.provenanceMessageIds[${index}]`))
  return {
    id: parseCanonicalId(v.id, `${path}.id`),
    category: v.category as RoleplayFact['category'],
    text: string(v.text, `${path}.text`, 10_000, false),
    visibility: parseKnowledgeVisibility(v.visibility, `${path}.visibility`),
    provenanceMessageIds,
    userAuthored: bool(v.userAuthored, `${path}.userAuthored`),
    pinned: bool(v.pinned, `${path}.pinned`),
    updatedAt: string(v.updatedAt, `${path}.updatedAt`, 64, false)
  }
}

function parseRoleplayState(value: unknown, path: string): RoleplayState {
  const v = object(value, path)
  keys(v, ['schemaVersion', 'recap', 'facts', 'beatsSinceMaintenance', 'maintainedAt'], path)
  if (v.schemaVersion !== 1) invalid(`${path}.schemaVersion`, 'unsupported roleplay-state schema')
  if (!Array.isArray(v.facts) || v.facts.length > 2_000) {
    invalid(`${path}.facts`, 'expected an array of at most 2000 facts')
  }
  const facts = v.facts.map((item, index) => parseRoleplayFact(item, `${path}.facts[${index}]`))
  if (new Set(facts.map((fact) => fact.id)).size !== facts.length) {
    invalid(`${path}.facts`, 'fact ids must be unique')
  }
  return {
    schemaVersion: 1,
    recap: optional(v.recap, (item) => string(item, `${path}.recap`, IPC_LIMITS.message)),
    facts,
    beatsSinceMaintenance: finite(v.beatsSinceMaintenance, `${path}.beatsSinceMaintenance`, 0, 1_000_000, true),
    maintainedAt: optional(v.maintainedAt, (item) => string(item, `${path}.maintainedAt`, 64, false))
  }
}

function parseDirection(value: unknown, path: string): SceneDirection {
  const v = object(value, path)
  keys(v, ['id', 'content', 'target', 'scope', 'enabled', 'createdAt', 'consumedAt', 'consumedByMessageId', 'resolvedAt'], path)
  if (!['next-beat', 'until-resolved', 'persistent', 'scene-metadata'].includes(v.scope as string)) {
    invalid(`${path}.scope`, 'unsupported direction scope')
  }
  const target = object(v.target, `${path}.target`)
  keys(target, ['kind', 'speakerId'], `${path}.target`)
  let parsedTarget: SceneDirection['target']
  if (target.kind === 'cast') {
    if (target.speakerId !== undefined) invalid(`${path}.target.speakerId`, 'not allowed for cast target')
    parsedTarget = { kind: 'cast' }
  } else if (target.kind === 'speaker') {
    parsedTarget = {
      kind: 'speaker',
      speakerId: parseCanonicalId(target.speakerId, `${path}.target.speakerId`)
    }
  } else {
    invalid(`${path}.target.kind`, 'unsupported direction target')
  }
  return {
    id: parseCanonicalId(v.id, `${path}.id`),
    content: string(v.content, `${path}.content`, IPC_LIMITS.message, false),
    target: parsedTarget,
    scope: v.scope as SceneDirection['scope'],
    enabled: bool(v.enabled, `${path}.enabled`),
    createdAt: string(v.createdAt, `${path}.createdAt`, 64, false),
    consumedAt: optional(v.consumedAt, (item) => string(item, `${path}.consumedAt`, 64, false)),
    consumedByMessageId: optional(v.consumedByMessageId, (item) => parseCanonicalId(item, `${path}.consumedByMessageId`)),
    resolvedAt: optional(v.resolvedAt, (item) => string(item, `${path}.resolvedAt`, 64, false))
  }
}

function parseDirectorSettings(value: unknown, path: string): SceneDirectorSettings {
  const v = object(value, path)
  keys(v, ['enabled', 'useModel', 'sceneGoal', 'pacing', 'initiative', 'interruption', 'inspectIntent'], path)
  if (!['slow', 'balanced', 'fast'].includes(v.pacing as string)) {
    invalid(`${path}.pacing`, 'unsupported pacing')
  }
  if (!['low', 'balanced', 'high'].includes(v.initiative as string)) {
    invalid(`${path}.initiative`, 'unsupported initiative')
  }
  if (!['never', 'natural-pauses', 'often'].includes(v.interruption as string)) {
    invalid(`${path}.interruption`, 'unsupported interruption policy')
  }
  return {
    enabled: bool(v.enabled, `${path}.enabled`),
    useModel: bool(v.useModel, `${path}.useModel`),
    sceneGoal: optional(v.sceneGoal, (item) => string(item, `${path}.sceneGoal`, 10_000)),
    pacing: v.pacing as SceneDirectorSettings['pacing'],
    initiative: v.initiative as SceneDirectorSettings['initiative'],
    interruption: v.interruption as SceneDirectorSettings['interruption'],
    inspectIntent: bool(v.inspectIntent, `${path}.inspectIntent`)
  }
}

function parsePersonaVoice(value: unknown, path: string): Persona['voice'] {
  const source = object(value, path)
  keys(source, ['voiceId', 'rate'], path)
  return {
    voiceId: optional(source.voiceId, (item) => parseCanonicalId(item, `${path}.voiceId`)),
    rate: optional(source.rate, (item) => finite(item, `${path}.rate`, 0.5, 2))
  }
}

export function parseConversation(value: unknown): Conversation {
  const path = 'conversation'
  const v = object(value, path)
  keys(
    v,
    [
      'id',
      'title',
      'modelId',
      'messages',
      'createdAt',
      'updatedAt',
      'compaction',
      'overrides',
      'personaId',
      'userCharacter',
      'cast',
      'scenePremise',
      'schemaVersion',
      'personaSnapshot',
      'castSnapshots',
      'personaOverrides',
      'knowledgeMode',
      'roleplayState',
      'directions',
      'director',
      'sceneVoice'
    ],
    path
  )
  if (!Array.isArray(v.messages)) invalid(`${path}.messages`, 'expected an array')
  if (v.messages.length > IPC_LIMITS.conversationMessages) {
    invalid(`${path}.messages`, `must contain at most ${IPC_LIMITS.conversationMessages} items`)
  }
  const messages: ChatMessage[] = []
  let totalText = 0
  for (let i = 0; i < v.messages.length; i++) {
    const message = parseMessage(v.messages[i], `${path}.messages[${i}]`)
    totalText += message.content.length
    totalText += message.segments?.reduce((sum, segment) => sum + segment.content.length, 0) ?? 0
    if (totalText > IPC_LIMITS.conversationText) {
      invalid(`${path}.messages`, `combined text must be at most ${IPC_LIMITS.conversationText} characters`)
    }
    messages.push(message)
    if (
      message.segments &&
      new Set(message.segments.map((segment) => segment.id)).size !== message.segments.length
    ) {
      invalid(`${path}.messages[${i}].segments`, 'segment ids must be unique')
    }
  }
  if (new Set(messages.map((m) => m.id)).size !== messages.length) {
    invalid(`${path}.messages`, 'message ids must be unique')
  }
  let cast: string[] | undefined
  if (v.cast !== undefined) {
    if (!Array.isArray(v.cast)) invalid(`${path}.cast`, 'expected an array')
    if (v.cast.length > IPC_LIMITS.cast) invalid(`${path}.cast`, `must contain at most ${IPC_LIMITS.cast} items`)
    cast = v.cast.map((id, i) => parseCanonicalId(id, `${path}.cast[${i}]`))
    if (new Set(cast).size !== cast.length) invalid(`${path}.cast`, 'persona ids must be unique')
  }
  let castSnapshots: PersonaSnapshot[] | undefined
  if (v.castSnapshots !== undefined) {
    if (!Array.isArray(v.castSnapshots) || v.castSnapshots.length > IPC_LIMITS.cast) {
      invalid(`${path}.castSnapshots`, `expected an array of at most ${IPC_LIMITS.cast} items`)
    }
    castSnapshots = v.castSnapshots.map((item, index) =>
      parsePersonaSnapshot(item, `${path}.castSnapshots[${index}]`)
    )
  }
  let personaOverrides: ScenePersonaOverride[] | undefined
  if (v.personaOverrides !== undefined) {
    if (!Array.isArray(v.personaOverrides) || v.personaOverrides.length > IPC_LIMITS.cast) {
      invalid(`${path}.personaOverrides`, `expected an array of at most ${IPC_LIMITS.cast} items`)
    }
    personaOverrides = v.personaOverrides.map((item, index) =>
      parsePersonaOverride(item, `${path}.personaOverrides[${index}]`)
    )
  }
  let directions: SceneDirection[] | undefined
  if (v.directions !== undefined) {
    if (!Array.isArray(v.directions) || v.directions.length > 1_000) {
      invalid(`${path}.directions`, 'expected an array of at most 1000 directions')
    }
    directions = v.directions.map((item, index) => parseDirection(item, `${path}.directions[${index}]`))
  }
  if (v.schemaVersion !== undefined && v.schemaVersion !== 2) {
    invalid(`${path}.schemaVersion`, 'unsupported conversation schema')
  }
  if (v.knowledgeMode !== undefined && v.knowledgeMode !== 'scoped' && v.knowledgeMode !== 'public-only') {
    invalid(`${path}.knowledgeMode`, 'unsupported knowledge mode')
  }
  if (
    castSnapshots &&
    new Set(castSnapshots.map((snapshot) => snapshot.sourcePersonaId)).size !== castSnapshots.length
  ) {
    invalid(`${path}.castSnapshots`, 'snapshot persona ids must be unique')
  }
  if (
    personaOverrides &&
    new Set(personaOverrides.map((override) => override.personaId)).size !==
      personaOverrides.length
  ) {
    invalid(`${path}.personaOverrides`, 'override persona ids must be unique')
  }
  if (personaOverrides?.some((override) => !cast?.includes(override.personaId))) {
    invalid(`${path}.personaOverrides`, 'overrides must target cast participants')
  }
  if (
    castSnapshots?.some(
      (snapshot) =>
        snapshot.persona.id !== snapshot.sourcePersonaId ||
        (cast && !cast.includes(snapshot.sourcePersonaId))
    )
  ) {
    invalid(`${path}.castSnapshots`, 'snapshots must match cast participant ids')
  }
  const personaSnapshot = optional(v.personaSnapshot, (x) =>
    parsePersonaSnapshot(x, `${path}.personaSnapshot`)
  )
  const personaId = optional(v.personaId, (x) => parseCanonicalId(x, `${path}.personaId`))
  if (
    personaSnapshot &&
    (personaSnapshot.persona.id !== personaSnapshot.sourcePersonaId ||
      (personaId && personaSnapshot.sourcePersonaId !== personaId))
  ) {
    invalid(`${path}.personaSnapshot`, 'snapshot must match the conversation persona id')
  }
  const roleplayState = optional(v.roleplayState, (x) =>
    parseRoleplayState(x, `${path}.roleplayState`)
  )
  const messageIds = new Set(messages.map((message) => message.id))
  for (const fact of roleplayState?.facts ?? []) {
    if (!fact.userAuthored && fact.provenanceMessageIds.length === 0) {
      invalid(`${path}.roleplayState.facts`, 'extracted facts require provenance')
    }
    if (fact.provenanceMessageIds.some((id) => !messageIds.has(id))) {
      invalid(`${path}.roleplayState.facts`, 'fact provenance must reference a message')
    }
  }
  for (const direction of directions ?? []) {
    if (
      direction.target.kind === 'speaker' &&
      (!cast || !cast.includes(direction.target.speakerId))
    ) {
      invalid(`${path}.directions`, 'target speaker must be in the cast')
    }
    if (direction.consumedByMessageId && !messageIds.has(direction.consumedByMessageId)) {
      invalid(`${path}.directions`, 'consumed direction must reference a message')
    }
  }
  const directionIds = new Set((directions ?? []).map((direction) => direction.id))
  if (directionIds.size !== (directions?.length ?? 0)) {
    invalid(`${path}.directions`, 'direction ids must be unique')
  }
  if (
    messages.some(
      (message) => message.directionId && !directionIds.has(message.directionId)
    )
  ) {
    invalid(`${path}.messages`, 'director-note links must reference a direction')
  }
  const director = optional(v.director, (item) =>
    parseDirectorSettings(item, `${path}.director`)
  )
  const sceneVoice = optional(v.sceneVoice, (item) =>
    parsePersonaVoice(item, `${path}.sceneVoice`)
  )
  const semanticSize = JSON.stringify({
    compaction: v.compaction,
    overrides: v.overrides,
    personaSnapshot,
    castSnapshots,
    personaOverrides,
    userCharacter: v.userCharacter,
    roleplayState,
    directions,
    director,
    sceneVoice,
    scenePremise: v.scenePremise
  }).length
  if (totalText + semanticSize > IPC_LIMITS.conversationText) {
    invalid(
      path,
      `combined transcript and roleplay data must be at most ${IPC_LIMITS.conversationText} characters`
    )
  }
  return {
    schemaVersion: v.schemaVersion as 2 | undefined,
    id: parseCanonicalId(v.id, `${path}.id`),
    title: string(v.title, `${path}.title`, 500),
    modelId: nullable(v.modelId, (x) => parseModelId(x, `${path}.modelId`)),
    messages,
    createdAt: string(v.createdAt, `${path}.createdAt`, 64, false),
    updatedAt: string(v.updatedAt, `${path}.updatedAt`, 64, false),
    compaction: optional(v.compaction, (x) => parseCompaction(x, `${path}.compaction`)),
    overrides: optional(v.overrides, (x) => parseOverrides(x, `${path}.overrides`)),
    personaId,
    personaSnapshot,
    userCharacter: optional(v.userCharacter, (x) => parseUserCharacter(x, `${path}.userCharacter`)),
    cast,
    castSnapshots,
    personaOverrides,
    knowledgeMode: v.knowledgeMode as Conversation['knowledgeMode'],
    roleplayState,
    directions,
    director,
    sceneVoice,
    scenePremise: optional(v.scenePremise, (x) => string(x, `${path}.scenePremise`, 10_000))
  }
}

function parseChatBase(value: unknown, advance: boolean): ChatSendRequest | ChatAdvanceRequest {
  const path = advance ? 'chatAdvance' : 'chatSend'
  const v = object(value, path)
  keys(
    v,
    advance
      ? ['conversationId', 'speakerId', 'assistantMessageId', 'options']
      : ['conversationId', 'message', 'assistantMessageId', 'options'],
    path
  )
  const base = {
    conversationId: parseCanonicalId(v.conversationId, `${path}.conversationId`),
    assistantMessageId: parseCanonicalId(v.assistantMessageId, `${path}.assistantMessageId`),
    options: optional(v.options, (x) => parseGenerationOptions(x, `${path}.options`, true))
  }
  return advance
    ? { ...base, speakerId: parseCanonicalId(v.speakerId, `${path}.speakerId`) }
    : { ...base, message: string(v.message, `${path}.message`, IPC_LIMITS.message, false) }
}

export function parseChatSendRequest(value: unknown): ChatSendRequest {
  return parseChatBase(value, false) as ChatSendRequest
}

export function parseChatAdvanceRequest(value: unknown): ChatAdvanceRequest {
  return parseChatBase(value, true) as ChatAdvanceRequest
}

export function parseChatAbortRequest(value: unknown): ChatAbortRequest {
  const path = 'chatAbort'
  const v = object(value, path)
  keys(v, ['conversationId', 'messageId', 'operationId'], path)
  return {
    conversationId: parseCanonicalId(v.conversationId, `${path}.conversationId`),
    messageId: parseCanonicalId(v.messageId, `${path}.messageId`),
    operationId: optional(v.operationId, (x) => parseCanonicalId(x, `${path}.operationId`))
  }
}

export function parseContextUsageProjection(value: unknown): ContextUsageProjection {
  const path = 'contextUsageProjection'
  const v = object(value, path)
  keys(v, ['conversationId', 'prospectiveInput', 'nextSpeakerId'], path)
  let prospectiveInput: ContextUsageProjection['prospectiveInput']
  if (v.prospectiveInput !== undefined) {
    const input = object(v.prospectiveInput, `${path}.prospectiveInput`)
    keys(input, ['content', 'director'], `${path}.prospectiveInput`)
    prospectiveInput = {
      content: string(input.content, `${path}.prospectiveInput.content`, IPC_LIMITS.message, false),
      director: optional(input.director, (x) => bool(x, `${path}.prospectiveInput.director`))
    }
  }
  return {
    conversationId: parseCanonicalId(v.conversationId, `${path}.conversationId`),
    prospectiveInput,
    nextSpeakerId: optional(v.nextSpeakerId, (x) =>
      parseCanonicalId(x, `${path}.nextSpeakerId`)
    )
  }
}

/** Ensure generation targets the exact persisted turn the renderer committed. */
export function assertChatSendState(conversation: Conversation, req: ChatSendRequest): void {
  const assistantIndex = conversation.messages.findIndex((m) => m.id === req.assistantMessageId)
  const assistant = conversation.messages[assistantIndex]
  const user = conversation.messages[assistantIndex - 1]
  if (
    assistantIndex < 1 ||
    assistant?.role !== 'assistant' ||
    assistant.content !== '' ||
    user?.role !== 'user' ||
    user.director === true ||
    user.content !== req.message
  ) {
    throw new Error('Chat request does not match the persisted user turn and assistant placeholder.')
  }
}

/** Ensure a scene beat targets a persisted empty placeholder for a cast member. */
export function assertChatAdvanceState(
  conversation: Conversation,
  req: ChatAdvanceRequest
): void {
  const assistant = conversation.messages.find((m) => m.id === req.assistantMessageId)
  if (
    !conversation.cast?.includes(req.speakerId) ||
    !assistant ||
    assistant.role !== 'assistant' ||
    assistant.content !== '' ||
    assistant.speakerId !== req.speakerId
  ) {
    throw new Error('Scene request does not match the persisted cast and assistant placeholder.')
  }
}

export function parseTtsSpeakRequest(value: unknown): TtsSpeakRequest {
  const path = 'ttsSpeak'
  const v = object(value, path)
  keys(v, ['messageId', 'text', 'voiceId', 'rate'], path)
  return {
    messageId: parseCanonicalId(v.messageId, `${path}.messageId`),
    text: string(v.text, `${path}.text`, IPC_LIMITS.message, false),
    voiceId: optional(v.voiceId, (x) => parseCanonicalId(x, `${path}.voiceId`)),
    rate: optional(v.rate, (x) => finite(x, `${path}.rate`, 0.5, 2))
  }
}

function parseContextSettings(value: unknown, path: string): ContextSettings {
  const v = object(value, path)
  keys(
    v,
    [
      'autoCompact',
      'compactThreshold',
      'warnThreshold',
      'compactTargetFraction',
      'compactRunwayTurns',
      'keepRecentMessages',
      'keepRecentFraction',
      'summaryTokenFraction'
    ],
    path
  )
  const compactThreshold = finite(v.compactThreshold, `${path}.compactThreshold`, 0.1, 0.99)
  const requestedTarget =
    v.compactTargetFraction === undefined
      ? DEFAULT_CONTEXT_SETTINGS.compactTargetFraction
      : finite(v.compactTargetFraction, `${path}.compactTargetFraction`, 0.1, 0.9)
  return {
    autoCompact: bool(v.autoCompact, `${path}.autoCompact`),
    compactThreshold,
    warnThreshold: finite(v.warnThreshold, `${path}.warnThreshold`, 0.1, 0.99),
    compactTargetFraction: normalizeCompactionTarget(requestedTarget, compactThreshold),
    compactRunwayTurns:
      v.compactRunwayTurns === undefined
        ? DEFAULT_CONTEXT_SETTINGS.compactRunwayTurns
        : finite(v.compactRunwayTurns, `${path}.compactRunwayTurns`, 1, 12, true),
    keepRecentMessages: finite(v.keepRecentMessages, `${path}.keepRecentMessages`, 1, 1_000, true),
    keepRecentFraction: finite(v.keepRecentFraction, `${path}.keepRecentFraction`, 0.05, 0.9),
    summaryTokenFraction: finite(v.summaryTokenFraction, `${path}.summaryTokenFraction`, 0.01, 0.5)
  }
}

function parseTtsSettings(value: unknown, path: string): TtsSettings {
  const v = object(value, path)
  keys(v, ['enabled', 'voiceId', 'rate', 'volume', 'autoSpeak'], path)
  return {
    enabled: bool(v.enabled, `${path}.enabled`),
    voiceId: nullable(v.voiceId, (x) => parseCanonicalId(x, `${path}.voiceId`)),
    rate: finite(v.rate, `${path}.rate`, 0.5, 2),
    volume: finite(v.volume, `${path}.volume`, 0, 1),
    autoSpeak: bool(v.autoSpeak, `${path}.autoSpeak`)
  }
}

function parseAccessibilitySettings(
  value: unknown,
  path: string
): AppSettings['accessibility'] {
  const v = object(value, path)
  keys(v, ['reducedMotion', 'highContrast', 'textScale'], path)
  const textScale = finite(v.textScale, `${path}.textScale`, 1, 1.25)
  if (![1, 1.125, 1.25].includes(textScale)) {
    invalid(`${path}.textScale`, 'unsupported text scale')
  }
  return {
    reducedMotion: bool(v.reducedMotion, `${path}.reducedMotion`),
    highContrast: bool(v.highContrast, `${path}.highContrast`),
    textScale: textScale as AppSettings['accessibility']['textScale']
  }
}

export function parsePersona(value: unknown, path = 'persona'): Persona {
  const v = object(value, path)
  keys(v, [
    'schemaVersion', 'version', 'id', 'name', 'role', 'brief', 'greeting', 'avatar',
    'voiceTags', 'generation', 'publicDescription', 'privateMotivations', 'secrets',
    'behavioralConstraints', 'speechGuidance', 'relationships', 'voice'
  ], path)
  const avatar = object(v.avatar, `${path}.avatar`)
  keys(avatar, ['monogram', 'gradient'], `${path}.avatar`)
  if (!Array.isArray(avatar.gradient) || avatar.gradient.length !== 2) {
    invalid(`${path}.avatar.gradient`, 'expected two colors')
  }
  if (!Array.isArray(v.voiceTags) || v.voiceTags.length > 32) {
    invalid(`${path}.voiceTags`, 'expected an array of at most 32 items')
  }
  if (v.schemaVersion !== undefined && v.schemaVersion !== 2) {
    invalid(`${path}.schemaVersion`, 'unsupported persona schema')
  }
  let relationships: PersonaRelationship[] | undefined
  if (v.relationships !== undefined) {
    if (!Array.isArray(v.relationships) || v.relationships.length > 128) {
      invalid(`${path}.relationships`, 'expected an array of at most 128 items')
    }
    relationships = v.relationships.map((item, index) =>
      parseRelationship(item, `${path}.relationships[${index}]`)
    )
  }
  let voice: Persona['voice']
  if (v.voice !== undefined) {
    voice = parsePersonaVoice(v.voice, `${path}.voice`)
  }
  return {
    schemaVersion: v.schemaVersion as 2 | undefined,
    version: optional(v.version, (item) => finite(item, `${path}.version`, 1, 1_000_000_000, true)),
    id: parseCanonicalId(v.id, `${path}.id`),
    name: string(v.name, `${path}.name`, 200, false),
    role: string(v.role, `${path}.role`, 500),
    brief: string(v.brief, `${path}.brief`, IPC_LIMITS.message),
    greeting: optional(v.greeting, (x) => string(x, `${path}.greeting`, IPC_LIMITS.message)),
    avatar: {
      monogram: string(avatar.monogram, `${path}.avatar.monogram`, 4, false),
      gradient: [
        string(avatar.gradient[0], `${path}.avatar.gradient[0]`, 32, false),
        string(avatar.gradient[1], `${path}.avatar.gradient[1]`, 32, false)
      ]
    },
    voiceTags: v.voiceTags.map((tag, i) => string(tag, `${path}.voiceTags[${i}]`, 100, false)),
    generation: optional(v.generation, (x) => parseGenerationOptions(x, `${path}.generation`)),
    publicDescription: optional(v.publicDescription, (item) => string(item, `${path}.publicDescription`, 10_000)),
    privateMotivations: optional(v.privateMotivations, (item) => parseStringList(item, `${path}.privateMotivations`)),
    secrets: optional(v.secrets, (item) => parseStringList(item, `${path}.secrets`)),
    behavioralConstraints: optional(v.behavioralConstraints, (item) => parseStringList(item, `${path}.behavioralConstraints`)),
    speechGuidance: optional(v.speechGuidance, (item) => string(item, `${path}.speechGuidance`, 10_000)),
    relationships,
    voice
  }
}

function parsePreset(value: unknown, path: string): SystemPromptPreset {
  const v = object(value, path)
  keys(v, ['id', 'name', 'prompt'], path)
  return {
    id: parseCanonicalId(v.id, `${path}.id`),
    name: string(v.name, `${path}.name`, 200, false),
    prompt: string(v.prompt, `${path}.prompt`, IPC_LIMITS.message)
  }
}

function parseProfile(value: unknown, path: string): GenerationProfile {
  const v = object(value, path)
  keys(v, ['id', 'name', 'options'], path)
  return {
    id: parseCanonicalId(v.id, `${path}.id`),
    name: string(v.name, `${path}.name`, 200, false),
    options: parseGenerationOptions(v.options, `${path}.options`)
  }
}

export function parseRendererSettingsPatch(value: unknown): RendererSettingsPatch {
  const path = 'settingsPatch'
  const v = object(value, path)
  keys(
    v,
    [
      'generation',
      'load',
      'context',
      'theme',
      'accent',
      'gpu',
      'verifyDownloads',
      'personas',
      'promptPresets',
      'generationProfiles',
      'tts',
      'accessibility',
      'backupRetention',
      'telemetry'
    ],
    path
  )
  const out: RendererSettingsPatch = {}
  if (v.generation !== undefined) out.generation = parseGenerationOptions(v.generation, `${path}.generation`)
  if (v.load !== undefined) {
    const load = object(v.load, `${path}.load`)
    keys(load, ['gpuLayers', 'contextSize', 'systemPrompt'], `${path}.load`)
    out.load = {
      gpuLayers: finite(load.gpuLayers, `${path}.load.gpuLayers`, -1, 10_000, true),
      contextSize: finite(load.contextSize, `${path}.load.contextSize`, 512, 1_048_576, true),
      systemPrompt: string(load.systemPrompt, `${path}.load.systemPrompt`, IPC_LIMITS.message)
    }
  }
  if (v.context !== undefined) out.context = parseContextSettings(v.context, `${path}.context`)
  if (v.theme !== undefined) {
    if (v.theme !== 'dark' && v.theme !== 'light') invalid(`${path}.theme`, 'unsupported theme')
    out.theme = v.theme
  }
  if (v.accent !== undefined) {
    const accent = string(v.accent, `${path}.accent`, 64, false)
    if (!ACCENT_THEMES.some((theme) => theme.key === accent)) {
      invalid(`${path}.accent`, 'unsupported accent')
    }
    out.accent = accent as AppSettings['accent']
  }
  if (v.gpu !== undefined) {
    if (!['auto', 'cuda', 'vulkan', 'metal', 'cpu'].includes(v.gpu as string)) {
      invalid(`${path}.gpu`, 'unsupported backend')
    }
    out.gpu = v.gpu as AppSettings['gpu']
  }
  if (v.verifyDownloads !== undefined) out.verifyDownloads = bool(v.verifyDownloads, `${path}.verifyDownloads`)
  if (v.personas !== undefined) {
    if (!Array.isArray(v.personas) || v.personas.length > IPC_LIMITS.personas) {
      invalid(`${path}.personas`, `expected an array of at most ${IPC_LIMITS.personas} items`)
    }
    out.personas = v.personas.map((p, i) => parsePersona(p, `${path}.personas[${i}]`))
    if (new Set(out.personas.map((p) => p.id)).size !== out.personas.length) {
      invalid(`${path}.personas`, 'persona ids must be unique')
    }
  }
  if (v.promptPresets !== undefined) {
    if (!Array.isArray(v.promptPresets) || v.promptPresets.length > IPC_LIMITS.profiles) {
      invalid(`${path}.promptPresets`, `expected an array of at most ${IPC_LIMITS.profiles} items`)
    }
    out.promptPresets = v.promptPresets.map((p, i) => parsePreset(p, `${path}.promptPresets[${i}]`))
  }
  if (v.generationProfiles !== undefined) {
    if (!Array.isArray(v.generationProfiles) || v.generationProfiles.length > IPC_LIMITS.profiles) {
      invalid(`${path}.generationProfiles`, `expected an array of at most ${IPC_LIMITS.profiles} items`)
    }
    out.generationProfiles = v.generationProfiles.map((p, i) =>
      parseProfile(p, `${path}.generationProfiles[${i}]`)
    )
  }
  if (v.tts !== undefined) out.tts = parseTtsSettings(v.tts, `${path}.tts`)
  if (v.accessibility !== undefined) {
    out.accessibility = parseAccessibilitySettings(
      v.accessibility,
      `${path}.accessibility`
    )
  }
  if (v.backupRetention !== undefined) {
    if (![1, 3, 5, 10].includes(v.backupRetention as number)) {
      invalid(`${path}.backupRetention`, 'expected 1, 3, 5, or 10 snapshots')
    }
    out.backupRetention = v.backupRetention as AppSettings['backupRetention']
  }
  if (v.telemetry !== undefined && v.telemetry !== false) invalid(`${path}.telemetry`, 'must remain false')
  if (v.telemetry !== undefined) out.telemetry = false
  if (JSON.stringify(out).length > IPC_LIMITS.settingsText) {
    invalid(path, `combined settings text must be at most ${IPC_LIMITS.settingsText} characters`)
  }
  return out
}

export function parseArgs<T extends unknown[]>(
  values: unknown[],
  ...parsers: { [K in keyof T]: (value: unknown) => T[K] }
): T {
  if (values.length !== parsers.length) invalid('arguments', `expected ${parsers.length}, received ${values.length}`)
  return parsers.map((parse, i) => parse(values[i])) as T
}

export function parseNoArgs(values: unknown[]): [] {
  if (values.length !== 0) invalid('arguments', `expected 0, received ${values.length}`)
  return []
}
