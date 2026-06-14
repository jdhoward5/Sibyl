// Canonical IPC channel names + the typed bridge API shape.
// Both the preload bridge and the main-process router import from here so the
// contract can never drift between the two sides.

import type {
  AppSettings,
  CompactionInfo,
  Conversation,
  ContextUsage,
  DownloadProgress,
  EngineStatus,
  GenerationEvent,
  GenerationOptions,
  HFModelDetail,
  HFModelSummary,
  InstalledModel,
  Result
} from './types'

export const IPC = {
  // Hugging Face discovery
  hfSearch: 'hf:search',
  hfModelDetail: 'hf:modelDetail',

  // Downloads
  downloadStart: 'download:start',
  downloadCancel: 'download:cancel',
  downloadList: 'download:list',
  downloadProgress: 'download:progress', // main → renderer event

  // Installed models
  modelsList: 'models:list',
  modelsDelete: 'models:delete',
  modelsReveal: 'models:reveal',

  // Engine / inference
  engineLoad: 'engine:load',
  engineUnload: 'engine:unload',
  engineStatus: 'engine:status',
  engineStatusEvent: 'engine:statusEvent', // main → renderer event

  // Chat
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatEvent: 'chat:event', // main → renderer streaming event
  chatCompact: 'chat:compact', // summarize older turns to reclaim context

  // Context window
  contextUsage: 'context:usage', // on-demand snapshot for a conversation
  contextEvent: 'context:event', // main → renderer usage updates

  // Conversations persistence
  convList: 'conv:list',
  convGet: 'conv:get',
  convSave: 'conv:save',
  convDelete: 'conv:delete',

  // Settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  // Misc
  appInfo: 'app:info'
} as const

export interface ChatSendRequest {
  conversationId: string
  /** The user message text to send. */
  message: string
  /** Assistant message id the renderer pre-allocated for streaming into. */
  assistantMessageId: string
  options?: Partial<GenerationOptions>
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: string
  modelsDir: string
  /** Whether the OS keychain is available to securely store secrets (HF token). */
  secureStorageAvailable: boolean
}

/**
 * The full surface exposed on `window.oracle`. Every method is async and
 * returns a structured Result (or void for fire-and-forget) — the renderer
 * never touches ipcRenderer or node directly.
 */
export interface OracleBridge {
  hf: {
    search(query: string, sort?: 'trending' | 'downloads' | 'likes'): Promise<Result<HFModelSummary[]>>
    modelDetail(repoId: string): Promise<Result<HFModelDetail>>
  }
  downloads: {
    start(repoId: string, filename: string): Promise<Result<{ id: string }>>
    cancel(id: string): Promise<Result<void>>
    list(): Promise<Result<DownloadProgress[]>>
    onProgress(cb: (p: DownloadProgress) => void): () => void
  }
  models: {
    list(): Promise<Result<InstalledModel[]>>
    delete(id: string): Promise<Result<void>>
    reveal(id: string): Promise<Result<void>>
  }
  engine: {
    load(modelId: string): Promise<Result<EngineStatus>>
    unload(): Promise<Result<void>>
    status(): Promise<Result<EngineStatus>>
    onStatus(cb: (s: EngineStatus) => void): () => void
  }
  chat: {
    send(req: ChatSendRequest): Promise<Result<void>>
    abort(conversationId: string): Promise<Result<void>>
    /** Summarize older turns of a conversation into a compaction record. */
    compact(conversationId: string): Promise<Result<CompactionInfo>>
    onEvent(cb: (e: GenerationEvent) => void): () => void
  }
  context: {
    /** Estimate (or read, if active) the context fill for a conversation. */
    usage(conversationId: string | null): Promise<Result<ContextUsage>>
    onUsage(cb: (u: ContextUsage) => void): () => void
  }
  conversations: {
    list(): Promise<Result<Conversation[]>>
    get(id: string): Promise<Result<Conversation>>
    save(conversation: Conversation): Promise<Result<void>>
    delete(id: string): Promise<Result<void>>
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    set(patch: Partial<AppSettings>): Promise<Result<AppSettings>>
  }
  app: {
    info(): Promise<Result<AppInfo>>
  }
}

declare global {
  interface Window {
    oracle: OracleBridge
  }
}
