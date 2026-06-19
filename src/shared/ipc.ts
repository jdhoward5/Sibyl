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
  Result,
  UpdateStatus
} from './types'
import type { ExportFormat } from './export'

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
  modelsImport: 'models:import', // pick a pre-downloaded .gguf and register it in place

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
  chatInvalidate: 'chat:invalidate', // drop the warm session after history edits

  // Context window
  contextUsage: 'context:usage', // on-demand snapshot for a conversation
  contextEvent: 'context:event', // main → renderer usage updates

  // Conversations persistence
  convList: 'conv:list',
  convGet: 'conv:get',
  convSave: 'conv:save',
  convDelete: 'conv:delete',
  convExport: 'conv:export', // render + save a conversation to a file via dialog

  // Settings
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  // Auto-update (Squirrel auto-downloads, so there's no manual download step)
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateStatus: 'update:status',
  updateEvent: 'update:event', // main → renderer status updates

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
 * The full surface exposed on `window.sibyl`. Every method is async and
 * returns a structured Result (or void for fire-and-forget) — the renderer
 * never touches ipcRenderer or node directly.
 */
export interface SibylBridge {
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
    /**
     * Open a native file picker for a local .gguf and register it in place.
     * Resolves to the new model, or `null` when the user cancels the dialog.
     */
    import(): Promise<Result<InstalledModel | null>>
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
    /**
     * Drop the engine's warm session for this conversation so the next send
     * rebuilds history from persisted state. Call after editing/deleting/
     * regenerating messages.
     */
    invalidateSession(conversationId: string): Promise<Result<void>>
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
    /** Render a conversation and prompt the user to save it to a file. */
    export(id: string, format: ExportFormat): Promise<Result<{ saved: boolean; path?: string }>>
  }
  settings: {
    get(): Promise<Result<AppSettings>>
    set(patch: Partial<AppSettings>): Promise<Result<AppSettings>>
  }
  app: {
    info(): Promise<Result<AppInfo>>
  }
  update: {
    /** Check GitHub for a newer release; Squirrel auto-downloads if one exists. */
    check(): Promise<Result<UpdateStatus>>
    /** Apply a downloaded update (swaps side-by-side on quit) and relaunch. */
    install(): Promise<Result<void>>
    /** Read the last known update status without triggering a check. */
    status(): Promise<Result<UpdateStatus>>
    onEvent(cb: (s: UpdateStatus) => void): () => void
  }
}

declare global {
  interface Window {
    sibyl: SibylBridge
  }
}
