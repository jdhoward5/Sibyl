// Shared domain types used by main, preload and renderer.
// Keep this file free of any runtime/node imports — it must be safe to load in the renderer.

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
  installedAt: string
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

export interface Conversation {
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
  /** Number of most-recent messages always kept verbatim (never folded). */
  keepRecentMessages: number
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  autoCompact: true,
  compactThreshold: 0.85,
  warnThreshold: 0.7,
  keepRecentMessages: 6
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
  /** Preferred GPU backend; 'auto' lets the engine decide. */
  gpu: 'auto' | 'cuda' | 'vulkan' | 'cpu'
  /**
   * Verify a download's SHA-256 against Hugging Face's published checksum after
   * it finishes. Slower for large models; when off, only the (cheap) byte-size
   * check runs. The size check always runs regardless.
   */
  verifyDownloads: boolean
  /** Reusable named system prompts the user can apply globally or per-conversation. */
  promptPresets: SystemPromptPreset[]
  /** Reusable named generation-parameter bundles (built-ins + user-defined). */
  generationProfiles: GenerationProfile[]
  telemetry: false // Oracle never sends telemetry.
}

export interface EngineStatus {
  state: 'idle' | 'loading' | 'ready' | 'generating' | 'error'
  modelId: string | null
  gpuType: 'cuda' | 'vulkan' | 'metal' | false | null
  vramTotalBytes: number | null
  vramUsedBytes: number | null
  contextSize: number | null
  error?: string
}

/**
 * Auto-update state, broadcast main → renderer. A single snapshot the renderer
 * renders the Updates UI from; mirrors the electron-updater lifecycle.
 *  - `idle`         no check has run yet this session
 *  - `checking`     a check is in flight
 *  - `available`    a newer release exists (not yet downloaded)
 *  - `not-available` the running build is the latest
 *  - `downloading`  the installer is being fetched (manual, user-initiated)
 *  - `downloaded`   the installer is ready; a restart will install it
 *  - `error`        the last check/download failed
 *  - `dev-disabled` running unpackaged (dev) — updates are unavailable
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
  /** The running app version (always set). */
  currentVersion: string
  /** The available/target release version, when known. */
  version?: string
  /** Release notes for the available version, when provided by the feed. */
  releaseNotes?: string
  /** ISO release date of the available version, when provided. */
  releaseDate?: string
  /** Download progress 0..100 while `state === 'downloading'`. */
  percent?: number
  /** Download speed in bytes/sec while `state === 'downloading'`. */
  bytesPerSecond?: number
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

/** Streaming events emitted from main → renderer during generation. */
export type GenerationEvent =
  | { type: 'token'; conversationId: string; messageId: string; text: string }
  | { type: 'done'; conversationId: string; messageId: string; stats: GenerationStats }
  | { type: 'error'; conversationId: string; messageId: string; error: string }

export interface Result<T> {
  ok: boolean
  data?: T
  error?: string
}
