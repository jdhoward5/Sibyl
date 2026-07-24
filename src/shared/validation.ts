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
  RendererSettingsPatch,
  SystemPromptPreset,
  UserCharacter
} from './types'
import type { ChatAbortRequest, ChatAdvanceRequest, ChatSendRequest, TtsSpeakRequest } from './ipc'
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
  keys(v, ['id', 'role', 'content', 'createdAt', 'stats', 'error', 'stopped', 'speakerId', 'speakerName', 'director'], path)
  if (v.role !== 'system' && v.role !== 'user' && v.role !== 'assistant') {
    invalid(`${path}.role`, 'unsupported role')
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
    director: optional(v.director, (x) => bool(x, `${path}.director`))
  }
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
      'scenePremise'
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
    if (totalText > IPC_LIMITS.conversationText) {
      invalid(`${path}.messages`, `combined text must be at most ${IPC_LIMITS.conversationText} characters`)
    }
    messages.push(message)
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
  return {
    id: parseCanonicalId(v.id, `${path}.id`),
    title: string(v.title, `${path}.title`, 500),
    modelId: nullable(v.modelId, (x) => parseModelId(x, `${path}.modelId`)),
    messages,
    createdAt: string(v.createdAt, `${path}.createdAt`, 64, false),
    updatedAt: string(v.updatedAt, `${path}.updatedAt`, 64, false),
    compaction: optional(v.compaction, (x) => parseCompaction(x, `${path}.compaction`)),
    overrides: optional(v.overrides, (x) => parseOverrides(x, `${path}.overrides`)),
    personaId: optional(v.personaId, (x) => parseCanonicalId(x, `${path}.personaId`)),
    userCharacter: optional(v.userCharacter, (x) => parseUserCharacter(x, `${path}.userCharacter`)),
    cast,
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
    ['autoCompact', 'compactThreshold', 'warnThreshold', 'keepRecentMessages', 'keepRecentFraction', 'summaryTokenFraction'],
    path
  )
  return {
    autoCompact: bool(v.autoCompact, `${path}.autoCompact`),
    compactThreshold: finite(v.compactThreshold, `${path}.compactThreshold`, 0.1, 0.99),
    warnThreshold: finite(v.warnThreshold, `${path}.warnThreshold`, 0.1, 0.99),
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

function parsePersona(value: unknown, path: string): Persona {
  const v = object(value, path)
  keys(v, ['id', 'name', 'role', 'brief', 'greeting', 'avatar', 'voiceTags', 'generation'], path)
  const avatar = object(v.avatar, `${path}.avatar`)
  keys(avatar, ['monogram', 'gradient'], `${path}.avatar`)
  if (!Array.isArray(avatar.gradient) || avatar.gradient.length !== 2) {
    invalid(`${path}.avatar.gradient`, 'expected two colors')
  }
  if (!Array.isArray(v.voiceTags) || v.voiceTags.length > 32) {
    invalid(`${path}.voiceTags`, 'expected an array of at most 32 items')
  }
  return {
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
    generation: optional(v.generation, (x) => parseGenerationOptions(x, `${path}.generation`))
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
  if (v.telemetry !== undefined && v.telemetry !== false) invalid(`${path}.telemetry`, 'must remain false')
  if (v.telemetry !== undefined) out.telemetry = false
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
