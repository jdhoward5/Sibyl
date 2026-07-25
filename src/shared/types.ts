// Shared domain types used by main, preload and renderer.
// Keep this file free of any runtime/node imports — it must be safe to load in the renderer.

import type { AccentThemeKey } from './themes'
import type { TtsSettings } from './tts'

export interface HFModelSummary {
  id: string // e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF"
  author: string
  downloads: number
  likes: number
  lastModified: string
  tags: string[]
  /** Best-effort pipeline tag, e.g. "text-generation". */
  pipelineTag?: string
  gated: boolean
}

export interface HFGGUFFile {
  /** Filename within the repo, e.g. "Llama-3.2-3B-Instruct-Q4_K_M.gguf". */
  rfilename: string
  /** Size in bytes when known. */
  size?: number
  /** Parsed quantization label, e.g. "Q4_K_M". */
  quant?: string
  /** True if this is one shard of a multi-part GGUF. */
  multipart: boolean
}

export interface HFModelDetail extends HFModelSummary {
  ggufFiles: HFGGUFFile[]
  /** README excerpt for display. */
  description?: string
}

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface DownloadProgress {
  id: string // unique download id
  repoId: string
  filename: string
  status: DownloadStatus
  receivedBytes: number
  totalBytes: number
  /** Bytes/sec, smoothed. */
  speed: number
  /** Estimated seconds remaining, or null when unknown. */
  etaSeconds: number | null
  /** Progress (0..1) of the post-download checksum/hash pass; null when not hashing. */
  verifyFraction?: number | null
  error?: string
}

/** A model file installed on disk and ready to load. */
export interface InstalledModel {
  id: string // stable id derived from repoId + filename
  repoId: string
  filename: string
  path: string
  sizeBytes: number
  quant?: string
  /** Parameter count label parsed from metadata/name, e.g. "3B". */
  paramLabel?: string
  /** Max context length advertised by the GGUF metadata. */
  trainContextLength?: number
  /** Detected chat template family. */
  chatWrapper?: string
  /**
   * Whether the download passed the strongest integrity check attempted at
   * install time. `false`/absent means it couldn't be checked (unknown expected
   * size, or installed before integrity checks existed) — not that it is
   * known-bad; a corrupt file is rejected at download time and never reaches the
   * registry.
   */
  verified?: boolean
  /**
   * How the download was verified: `'sha256'` = content matched Hugging Face's
   * published checksum; `'size'` = only the byte count was checked. Absent for
   * models installed before integrity checks existed.
   */
  verifiedBy?: 'size' | 'sha256'
  /**
   * True when the model was imported from a file the user already had on disk
   * (registered in place, not downloaded into the models folder). Removing a
   * local model only deregisters it — Sibyl never deletes a file it didn't fetch.
   */
  local?: boolean
  installedAt: string
  /** Current filesystem reachability; registry entries are retained while unavailable. */
  availability?: ResourceAvailability
  /** Human-readable reason when `availability !== 'available'`. */
  availabilityError?: string
}

export type ResourceAvailability = 'available' | 'missing' | 'unavailable' | 'unreadable'

export interface StorageIssue {
  resource: 'models' | 'voices'
  kind: 'malformed' | 'unreadable'
  message: string
  /** A quarantined recovery copy exists and can be revealed to the user. */
  recoverable: boolean
}

export type PrivateVaultState = 'uninitialized' | 'locked' | 'unlocked' | 'error'

/** Renderer-safe vault lifecycle state. Contains no private data or key material. */
export interface PrivateVaultStatus {
  state: PrivateVaultState
  hasDeviceSlot: boolean
  hasPasskeySlot: boolean
  recoveryAvailable: boolean
  deviceStorageAvailable: boolean
  passkeyAvailable: boolean
  migrationRequired: boolean
  error?: string
}

/** Opaque, content-free summary of an encrypted local vault snapshot. */
export interface PrivateVaultBackup {
  id: string
  createdAt: string
  recordCount: number
  valid: boolean
}

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  createdAt: string
  /** Generation stats attached to assistant messages once complete. */
  stats?: GenerationStats
  /** Set on an assistant message when its generation failed; drives the retry UI. */
  error?: string
  /** A user-stopped partial response remains editable/retryable. */
  stopped?: boolean
  /**
   * Scene beats only: the persona id of the AI character who spoke this line.
   * Absent on the human's own turns. A scene interleaves many speakers, so a beat
   * carries its own attribution rather than relying on the conversation's persona.
   */
  speakerId?: string
  /**
   * Display name captured when the beat was written, so the transcript still
   * attributes it correctly if the persona is later renamed or removed.
   */
  speakerName?: string
  /**
   * Scene only: marks an out-of-character director note (the human stepping in to
   * steer the scene). Stored with `role: 'user'`; rendered as a stage direction
   * and fed to every character as guidance, not as spoken dialogue.
   */
  director?: boolean
  /** Structured public/private content. When absent, legacy `content` is public. */
  segments?: MessageSegment[]
  /** Links a rendered director note to its independently managed direction. */
  directionId?: string
}

export type KnowledgeVisibility =
  | { kind: 'public' }
  | { kind: 'private'; characterIds: string[] }

export interface MessageSegment {
  id: string
  kind: 'dialogue' | 'action' | 'thought' | 'note'
  content: string
  visibility: KnowledgeVisibility
}

export interface GenerationStats {
  promptTokens: number
  completionTokens: number
  tokensPerSecond: number
  durationMs: number
  /** KV-cache fill (tokens resident in the context window) right after this turn. */
  contextTokens?: number
}

/**
 * Record of a compaction pass: older turns folded into a model-written summary
 * to reclaim context. The summary is cumulative — each pass re-summarizes the
 * previous summary plus the newly folded turns.
 */
export interface CompactionInfo {
  /** Summary that stands in for every folded message. */
  summary: string
  /** All messages up to and including this id are folded into `summary`. */
  throughMessageId: string
  /** Total number of messages folded so far (cumulative across passes). */
  foldedCount: number
  /** Approx tokens the folded content occupied before compaction. */
  originalTokens: number
  /** Approx tokens the summary occupies. */
  summaryTokens: number
  /** When compaction last ran (ISO). */
  compactedAt: string
}

/**
 * Per-conversation overrides of the global system prompt / sampling params. Each
 * field is optional — an omitted field falls back to the global `AppSettings`.
 * The model is not overridable here; it stays globally selected.
 */
export interface ConversationOverrides {
  /** Replaces the global system prompt for this conversation when set & non-empty. */
  systemPrompt?: string
  /** Replaces the global generation options for this conversation when set. */
  generation?: GenerationOptions
}

/** A monogram + 2-colour gradient avatar (image avatars are a future option). */
export interface PersonaAvatar {
  /** 1–2 character monogram shown in the circle. */
  monogram: string
  /** Two-stop gradient `[from, to]` (hex). */
  gradient: [string, string]
}

/**
 * A reusable character you roleplay/write with. Subsumes the old `promptPresets`
 * (name + brief) and carries voice, an opening line, an avatar and per-persona
 * sampling defaults. A conversation references one via `personaId`.
 */
export interface Persona {
  /** Forward-only persona schema. */
  schemaVersion?: 2
  /** Monotonic library revision; snapshots retain the revision they captured. */
  version?: number
  id: string
  name: string
  /** One-line role subtitle, e.g. "Caravan guard". */
  role: string
  /** The system prompt, surfaced to writers as the "Character brief". */
  brief: string
  /** Optional opening assistant message seeded into a fresh thread. */
  greeting?: string
  avatar: PersonaAvatar
  /** Small cosmetic voice chips, e.g. ["3rd-person", "present"]. */
  voiceTags: string[]
  /** Per-persona sampling defaults; falls back to the global generation options. */
  generation?: GenerationOptions
  /** Information every participant may know. */
  publicDescription?: string
  /** Goals visible only to this character's prompt and the human. */
  privateMotivations?: string[]
  /** Facts visible only to this character's prompt and the human. */
  secrets?: string[]
  behavioralConstraints?: string[]
  speechGuidance?: string
  relationships?: PersonaRelationship[]
  voice?: PersonaVoice
}

export interface CompactionResult {
  compaction: CompactionInfo
  /** Validated public facts extracted during roleplay maintenance. */
  roleplayFacts?: RoleplayFact[]
}

export interface PersonaRelationship {
  personaId: string
  summary: string
  visibility: 'public' | 'private'
}

export interface PersonaVoice {
  voiceId?: string
  rate?: number
}

/** Prompt-critical identity frozen into a conversation. */
export interface PersonaSnapshot {
  schemaVersion: 1
  sourcePersonaId: string
  sourceVersion: number
  capturedAt: string
  persona: Persona
}

export interface ScenePersonaOverride {
  personaId: string
  publicDescription?: string
  privateMotivations?: string[]
  secrets?: string[]
  behavioralConstraints?: string[]
  speechGuidance?: string
  relationships?: PersonaRelationship[]
  voice?: PersonaVoice
}

export interface RoleplayFact {
  id: string
  category:
    | 'time'
    | 'location'
    | 'object'
    | 'condition'
    | 'obligation'
    | 'relationship'
    | 'plot'
    | 'goal'
    | 'other'
  text: string
  visibility: KnowledgeVisibility
  provenanceMessageIds: string[]
  userAuthored: boolean
  pinned: boolean
  updatedAt: string
}

export interface RoleplayState {
  schemaVersion: 1
  /** Compact prose representation used in prompts. */
  recap?: string
  facts: RoleplayFact[]
  /** Number of successful beats since the last maintenance pass. */
  beatsSinceMaintenance: number
  maintainedAt?: string
}

export type DirectionScope = 'next-beat' | 'until-resolved' | 'persistent' | 'scene-metadata'

export interface SceneDirection {
  id: string
  content: string
  target: { kind: 'cast' } | { kind: 'speaker'; speakerId: string }
  scope: DirectionScope
  enabled: boolean
  createdAt: string
  /** Set only after the influenced beat was durably saved. */
  consumedAt?: string
  consumedByMessageId?: string
  resolvedAt?: string
}

export interface SceneDirectorSettings {
  enabled: boolean
  useModel: boolean
  sceneGoal?: string
  pacing: 'slow' | 'balanced' | 'fast'
  initiative: 'low' | 'balanced' | 'high'
  interruption: 'never' | 'natural-pauses' | 'often'
  inspectIntent: boolean
}

export interface SceneDirectorDecision {
  action: 'continue' | 'pause' | 'end'
  speakerId?: string
  /** Private and ephemeral unless inspectIntent is enabled. */
  intent: string
  usedModel: boolean
  fallbackReason?: string
  promptTokens: number
  completionTokens: number
  durationMs: number
}

/** The writer's own character, injected into the prompt as "The user plays …". */
export interface UserCharacter {
  name: string
  description: string
}

export interface Conversation {
  /** Forward-only conversation schema. Missing means legacy v1. */
  schemaVersion?: 2
  id: string
  title: string
  modelId: string | null
  messages: ChatMessage[]
  createdAt: string
  updatedAt: string
  /** Present once older turns have been summarized to save context. */
  compaction?: CompactionInfo
  /** Per-conversation overrides of the global system prompt / generation params. */
  overrides?: ConversationOverrides
  /** The persona (from `settings.personas`) this thread is written with, if any. */
  personaId?: string
  /** Frozen identity for an ordinary single-persona thread. */
  personaSnapshot?: PersonaSnapshot
  /** The writer's own character for this thread (optional). */
  userCharacter?: UserCharacter
  /**
   * Self-roleplay scene: persona ids (from `settings.personas`) of the AI
   * characters in the cast. Two or more turns the thread into a scene where the
   * characters converse with each other and the human can watch, join in, or
   * direct. Empty/absent ⇒ an ordinary single-persona thread.
   */
  cast?: string[]
  /** Frozen cast identities, in cast order. */
  castSnapshots?: PersonaSnapshot[]
  /** Per-scene changes that do not mutate the reusable persona library. */
  personaOverrides?: ScenePersonaOverride[]
  /** Public-only is a compatibility mode for small models. */
  knowledgeMode?: 'scoped' | 'public-only'
  roleplayState?: RoleplayState
  directions?: SceneDirection[]
  director?: SceneDirectorSettings
  /** Scene-wide speech fallback between a character override and global TTS. */
  sceneVoice?: PersonaVoice
  /** Optional one-line premise/setting shown to every character in a scene. */
  scenePremise?: string
}

export interface GenerationOptions {
  temperature: number
  topP: number
  topK: number
  minP: number
  maxTokens: number
  /** Repeat penalty applied over the recent window. */
  repeatPenalty: number
  seed?: number
  /** Strings that, when generated, stop the response early. */
  stopSequences?: string[]
}

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  minP: 0.05,
  maxTokens: 2048,
  repeatPenalty: 1.1,
  stopSequences: []
}

/** A reusable, named system prompt the user can apply globally or per-conversation. */
export interface SystemPromptPreset {
  id: string
  name: string
  prompt: string
}

/** A reusable, named bundle of generation options (e.g. "Precise" vs "Creative"). */
export interface GenerationProfile {
  id: string
  name: string
  options: GenerationOptions
}

/** Built-in generation profiles shipped out of the box; editable/removable like user ones. */
export const DEFAULT_GENERATION_PROFILES: GenerationProfile[] = [
  {
    id: 'precise',
    name: 'Precise',
    options: { temperature: 0.2, topP: 0.7, topK: 20, minP: 0.05, maxTokens: 2048, repeatPenalty: 1.1 }
  },
  {
    id: 'balanced',
    name: 'Balanced',
    options: { ...DEFAULT_GENERATION_OPTIONS }
  },
  {
    id: 'creative',
    name: 'Creative',
    options: { temperature: 1.0, topP: 0.95, topK: 80, minP: 0.02, maxTokens: 2048, repeatPenalty: 1.05 }
  }
]

export interface LoadOptions {
  /** Number of layers to offload to GPU; -1 = auto/max. */
  gpuLayers: number
  /** Context window size in tokens. */
  contextSize: number
  /** System prompt seeded into new sessions. */
  systemPrompt: string
}

/** Tunables for how the context window is managed during a chat. */
export interface ContextSettings {
  /** Summarize older turns automatically when the window fills past the threshold. */
  autoCompact: boolean
  /** Fraction (0..1) of the window at which auto-compaction runs before a send. */
  compactThreshold: number
  /** Fraction (0..1) at which the UI surfaces a warning. */
  warnThreshold: number
  /** Upper bound on most-recent messages kept verbatim (never folded). */
  keepRecentMessages: number
  /**
   * Token budget for the kept-recent tail, as a fraction of the window. When the
   * recent messages are large, compaction folds more than usual (down to a floor)
   * so the live tail fits this budget — a fixed message count can't guarantee
   * compaction frees enough.
   */
  keepRecentFraction: number
  /** Summary token budget as a fraction of the window (scales with context size). */
  summaryTokenFraction: number
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  autoCompact: true,
  compactThreshold: 0.85,
  warnThreshold: 0.7,
  keepRecentMessages: 6,
  keepRecentFraction: 0.35,
  summaryTokenFraction: 0.06
}

export interface AccessibilitySettings {
  reducedMotion: boolean
  highContrast: boolean
  /** Root UI scale; 1.25 is the supported large-text mode. */
  textScale: 1 | 1.125 | 1.25
}

export const DEFAULT_ACCESSIBILITY_SETTINGS: AccessibilitySettings = {
  reducedMotion: false,
  highContrast: false,
  textScale: 1
}

export interface AppSettings {
  /** Directory where GGUF models are stored. */
  modelsDir: string
  /** Optional Hugging Face token for gated/private models. Stored encrypted at rest. */
  hfToken: string | null
  generation: GenerationOptions
  load: Omit<LoadOptions, 'systemPrompt'> & { systemPrompt: string }
  context: ContextSettings
  theme: 'dark' | 'light'
  /** Accent palette applied to the chat surface (buttons, caret, user voice). */
  accent: AccentThemeKey
  /**
   * Preferred GPU backend; 'auto' lets the engine decide. The relevant choices
   * are platform-specific — 'cuda'/'vulkan' on Windows, 'metal' on macOS — but
   * any unavailable backend degrades gracefully (→ auto → CPU) in the engine.
   */
  gpu: 'auto' | 'cuda' | 'vulkan' | 'metal' | 'cpu'
  /**
   * Verify a download's SHA-256 against Hugging Face's published checksum after
   * it finishes. Slower for large models; when off, only the (cheap) byte-size
   * check runs. The size check always runs regardless.
   */
  verifyDownloads: boolean
  /** The persona library — reusable characters to write with. */
  personas: Persona[]
  /**
   * Legacy reusable system prompts. Superseded by `personas` (migrated on first
   * load); still read for one version for back-compat.
   */
  promptPresets: SystemPromptPreset[]
  /** Reusable named generation-parameter bundles (built-ins + user-defined). */
  generationProfiles: GenerationProfile[]
  /** On-device text-to-speech (Piper) preferences. */
  tts: TtsSettings
  accessibility: AccessibilitySettings
  /** Ciphertext-only private-vault generations retained locally. */
  backupRetention: 1 | 3 | 5 | 10
  telemetry: false // Sibyl never sends telemetry.
}

/**
 * Settings safe to expose to the renderer. The decrypted Hugging Face token is
 * deliberately replaced by a presence bit; only main may hold the secret.
 */
export type RendererSettings = Omit<AppSettings, 'hfToken'> & {
  hfTokenConfigured: boolean
}

/** Renderer-writable settings. Secrets and main-owned paths are not writable here. */
export type RendererSettingsPatch = Partial<
  Omit<RendererSettings, 'hfTokenConfigured' | 'modelsDir'>
>

export interface EngineStatus {
  state: 'idle' | 'loading' | 'ready' | 'generating' | 'unloading' | 'shutting-down' | 'error'
  modelId: string | null
  gpuType: 'cuda' | 'vulkan' | 'metal' | false | null
  vramTotalBytes: number | null
  vramUsedBytes: number | null
  contextSize: number | null
  error?: string
  operation?: EngineOperation
}

export type EngineOperationKind =
  | 'load'
  | 'unload'
  | 'generate'
  | 'scene-beat'
  | 'scene-director'
  | 'compact'
  | 'shutdown'

export interface EngineOperation {
  id: string
  kind: EngineOperationKind
  conversationId?: string
  messageId?: string
  modelId?: string
}

/**
 * Auto-update state, broadcast main → renderer. A single snapshot the renderer
 * renders the Updates UI from; mirrors the Squirrel (native autoUpdater) lifecycle.
 *  - `idle`         no check has run yet this session
 *  - `checking`     a check is in flight
 *  - `available`    a newer release exists (Squirrel auto-downloads it)
 *  - `not-available` the running build is the latest
 *  - `downloading`  Squirrel is fetching the update package (automatic)
 *  - `downloaded`   the update is staged; a restart will apply it
 *  - `error`        the last check/download failed
 *  - `dev-disabled` running unpackaged (dev) — updates are unavailable
 *  - `unsupported`  this platform has no in-app updater (e.g. the unsigned macOS
 *                   build — Squirrel.Mac requires code-signing); update manually
 */
export interface UpdateStatus {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'dev-disabled'
    | 'unsupported'
  /** The running app version (always set). */
  currentVersion: string
  /** The available/target release version, when known. */
  version?: string
  /** Release notes for the available version, when provided by the feed. */
  releaseNotes?: string
  /** ISO release date of the available version, when provided. */
  releaseDate?: string
  /** Error message when `state === 'error'`. */
  error?: string
}

/** Severity of context-window pressure. */
export type ContextLevel = 'ok' | 'warn' | 'critical'

/** Live snapshot of how full the active context window is. */
export interface ContextUsage {
  /** Conversation this pertains to, or null when nothing is loaded. */
  conversationId: string | null
  /** Tokens occupying the window (system + summary + live history). */
  usedTokens: number
  /** Total size of the loaded context window in tokens (0 when no model). */
  contextSize: number
  /** Tokens budgeted for the next response (generation.maxTokens). */
  responseReserveTokens: number
  /** usedTokens / contextSize, clamped to 0..1. */
  fraction: number
  /** Severity given the configured thresholds. */
  level: ContextLevel
  /** True when usedTokens + responseReserveTokens exceeds contextSize. */
  willOverflow: boolean
  /** True when measured from the live KV cache; false when estimated by tokenizing. */
  exact: boolean
}

/** Prospective context calculation used before committing a new turn. */
export interface ContextUsageProjection {
  conversationId: string
  /** A not-yet-persisted human line or director note to include in the estimate. */
  prospectiveInput?: {
    content: string
    director?: boolean
  }
  /** The scene character selected for the next beat, when already known. */
  nextSpeakerId?: string
}

/** Streaming events emitted from main → renderer during generation. */
export type GenerationEvent =
  | { type: 'token'; conversationId: string; messageId: string; text: string }
  | { type: 'done'; conversationId: string; messageId: string; stats: GenerationStats }
  | { type: 'aborted'; conversationId: string; messageId: string; stats: GenerationStats }
  | { type: 'error'; conversationId: string; messageId: string; error: string }

export interface Result<T> {
  ok: boolean
  data?: T
  error?: string
}
