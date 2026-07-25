// Canonical IPC channel names + the typed bridge API shape.
// Both the preload bridge and the main-process router import from here so the
// contract can never drift between the two sides.

import type {
  CompactionResult,
  Conversation,
  ContextUsage,
  ContextUsageProjection,
  DownloadProgress,
  EngineStatus,
  GenerationEvent,
  GenerationOptions,
  HFModelDetail,
  HFModelSummary,
  InstalledModel,
  PrivateVaultBackup,
  PrivateVaultStatus,
  RendererSettings,
  RendererSettingsPatch,
  Result,
  SceneDirectorDecision,
  StorageIssue,
  UpdateStatus
} from './types'
import type { ExportFormat } from './export'
import type { PortableBundlePreview } from './portable'
import type { InstalledVoice, TtsEvent, TtsStatus, TtsVoiceDownload } from './tts'

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
  modelsLocate: 'models:locate',
  storageIssues: 'storage:issues',
  storageRevealRecovery: 'storage:revealRecovery',

  // Engine / inference
  engineLoad: 'engine:load',
  engineUnload: 'engine:unload',
  engineStatus: 'engine:status',
  engineStatusEvent: 'engine:statusEvent', // main → renderer event

  // Chat
  chatSend: 'chat:send',
  chatAdvance: 'chat:advance', // generate one beat of a self-roleplay scene
  chatDirect: 'chat:direct', // private ephemeral local-director decision
  chatDirectAbort: 'chat:directAbort',
  chatAbort: 'chat:abort',
  chatEvent: 'chat:event', // main → renderer streaming event
  chatCompact: 'chat:compact', // summarize older turns to reclaim context
  chatInvalidate: 'chat:invalidate', // drop the warm session after history edits

  // Context window
  contextUsage: 'context:usage', // on-demand snapshot for a conversation
  contextProjectedUsage: 'context:projectedUsage', // preflight incl. pending input/speaker
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
  settingsSetHfToken: 'settings:setHfToken',
  settingsClearHfToken: 'settings:clearHfToken',

  // Encrypted private-data vault
  vaultStatus: 'vault:status',
  vaultSetup: 'vault:setup',
  vaultUnlock: 'vault:unlock',
  vaultUnlockPasskey: 'vault:unlockPasskey',
  vaultLock: 'vault:lock',
  vaultSetSeamless: 'vault:setSeamless',
  vaultSetPasskey: 'vault:setPasskey',
  vaultChangeRecoveryPassphrase: 'vault:changeRecoveryPassphrase',
  vaultListBackups: 'vault:listBackups',
  vaultCreateBackup: 'vault:createBackup',
  vaultVerifyRecovery: 'vault:verifyRecovery',
  vaultRestoreBackup: 'vault:restoreBackup',

  // Encrypted portable data
  portableExportConversation: 'portable:exportConversation',
  portableExportLibrary: 'portable:exportLibrary',
  portableInspectImport: 'portable:inspectImport',
  portableCommitImport: 'portable:commitImport',
  portableDiscardImport: 'portable:discardImport',

  // Text-to-speech (on-device Piper voices)
  ttsStatus: 'tts:status',
  ttsStatusEvent: 'tts:statusEvent', // main → renderer event
  ttsVoicesList: 'tts:voicesList', // installed voices on disk
  ttsVoiceDownloads: 'tts:voiceDownloads', // in-flight voice downloads
  ttsVoiceDownload: 'tts:voiceDownload',
  ttsVoiceCancel: 'tts:voiceCancel',
  ttsVoiceDelete: 'tts:voiceDelete',
  ttsVoiceProgress: 'tts:voiceProgress', // main → renderer event
  ttsSpeak: 'tts:speak',
  ttsStop: 'tts:stop',
  ttsEvent: 'tts:event', // main → renderer streaming audio

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

export interface ChatAdvanceRequest {
  conversationId: string
  /** Persona id (from the cast) of the character who should speak this beat. */
  speakerId: string
  /** Assistant message id the renderer pre-allocated for streaming into. */
  assistantMessageId: string
  options?: Partial<GenerationOptions>
}

export interface ChatAbortRequest {
  conversationId: string
  messageId: string
  operationId?: string
}

export interface TtsSpeakRequest {
  /** The assistant message this speech belongs to (drives the UI highlight). */
  messageId: string
  /** The text to speak (typically the assistant message's content). */
  text: string
  /** Override the configured voice for this request. */
  voiceId?: string
  /** Override the configured speaking rate for this request. */
  rate?: number
}

export interface VaultSetupRequest {
  recoveryPassphrase: string
  seamlessOnThisDevice: boolean
}

export interface AppInfo {
  version: string
  electron: string
  node: string
  platform: string
  modelsDir: string
  systemMemoryTotalBytes: number
  systemMemoryFreeBytes: number
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
    /** Locate a moved/unavailable model and update its existing registry entry. */
    locate(id: string): Promise<Result<InstalledModel | null>>
  }
  engine: {
    load(modelId: string): Promise<Result<EngineStatus>>
    unload(): Promise<Result<void>>
    status(): Promise<Result<EngineStatus>>
    onStatus(cb: (s: EngineStatus) => void): () => void
  }
  chat: {
    send(req: ChatSendRequest): Promise<Result<void>>
    /** Generate the next beat of a self-roleplay scene (one cast persona speaks). */
    advance(req: ChatAdvanceRequest): Promise<Result<void>>
    direct(conversationId: string): Promise<Result<SceneDirectorDecision>>
    abortDirector(conversationId: string): Promise<Result<{ aborted: boolean }>>
    abort(req: ChatAbortRequest): Promise<Result<{ aborted: boolean }>>
    /** Summarize older turns of a conversation into a compaction record. */
    compact(conversationId: string): Promise<Result<CompactionResult>>
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
    /** Estimate the next request including pending input and/or a selected scene speaker. */
    projectedUsage(projection: ContextUsageProjection): Promise<Result<ContextUsage>>
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
    get(): Promise<Result<RendererSettings>>
    set(patch: RendererSettingsPatch): Promise<Result<RendererSettings>>
    /** Store or replace the token without ever echoing it back to the renderer. */
    setHfToken(token: string): Promise<Result<void>>
    clearHfToken(): Promise<Result<void>>
  }
  vault: {
    status(): Promise<Result<PrivateVaultStatus>>
    setup(request: VaultSetupRequest): Promise<Result<PrivateVaultStatus>>
    unlock(recoveryPassphrase: string): Promise<Result<PrivateVaultStatus>>
    unlockPasskey(): Promise<Result<PrivateVaultStatus>>
    lock(): Promise<Result<PrivateVaultStatus>>
    setSeamless(enabled: boolean): Promise<Result<PrivateVaultStatus>>
    setPasskey(enabled: boolean): Promise<Result<PrivateVaultStatus>>
    changeRecoveryPassphrase(recoveryPassphrase: string): Promise<Result<PrivateVaultStatus>>
    listBackups(): Promise<Result<PrivateVaultBackup[]>>
    createBackup(): Promise<Result<void>>
    verifyRecovery(): Promise<Result<{ currentRecords: number; validBackups: number }>>
    restoreBackup(id: string): Promise<Result<void>>
  }
  portable: {
    exportConversation(
      id: string,
      recoveryPassphrase: string
    ): Promise<Result<{ saved: boolean; path?: string }>>
    exportLibrary(
      recoveryPassphrase: string
    ): Promise<Result<{ saved: boolean; path?: string }>>
    inspectImport(recoveryPassphrase: string): Promise<Result<PortableBundlePreview | null>>
    commitImport(token: string): Promise<Result<{ conversationIds: string[] }>>
    discardImport(token: string): Promise<Result<void>>
  }
  app: {
    info(): Promise<Result<AppInfo>>
    storageIssues(): Promise<Result<StorageIssue[]>>
    revealRecovery(resource: StorageIssue['resource']): Promise<Result<void>>
  }
  tts: {
    /** Current speech-subsystem status (availability + what's speaking). */
    status(): Promise<Result<TtsStatus>>
    onStatus(cb: (s: TtsStatus) => void): () => void
    /** Voices downloaded and registered on disk. */
    listVoices(): Promise<Result<InstalledVoice[]>>
    /** Voice downloads currently in flight. */
    listDownloads(): Promise<Result<TtsVoiceDownload[]>>
    /** Download a catalog voice (by id) from Hugging Face and register it. */
    downloadVoice(voiceId: string): Promise<Result<void>>
    cancelVoiceDownload(voiceId: string): Promise<Result<void>>
    /** Remove a downloaded voice's files + registry entry. */
    deleteVoice(voiceId: string): Promise<Result<void>>
    onVoiceProgress(cb: (p: TtsVoiceDownload) => void): () => void
    /** Synthesize + stream speech for a message. Audio arrives via onEvent. */
    speak(req: TtsSpeakRequest): Promise<Result<void>>
    /** Stop the current speech. */
    stop(): Promise<Result<void>>
    onEvent(cb: (e: TtsEvent) => void): () => void
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
