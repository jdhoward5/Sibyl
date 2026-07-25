import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { SibylBridge, ChatSendRequest, ChatAdvanceRequest, TtsSpeakRequest } from '@shared/ipc'
import type { Conversation, RendererSettingsPatch } from '@shared/types'

/**
 * The single bridge exposed to the renderer. Every method funnels through
 * ipcRenderer.invoke (request/response) or a guarded event subscription.
 * The renderer never receives the raw IpcRendererEvent, only typed payloads.
 */

// A dropped file must never become a top-frame navigation. Main independently
// rejects the resulting URL as a defense in depth; preventing the default here
// also avoids a disruptive failed-navigation flash.
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: SibylBridge = {
  hf: {
    search: (query, sort) => ipcRenderer.invoke(IPC.hfSearch, query, sort),
    modelDetail: (repoId) => ipcRenderer.invoke(IPC.hfModelDetail, repoId)
  },
  downloads: {
    start: (repoId, filename) => ipcRenderer.invoke(IPC.downloadStart, repoId, filename),
    cancel: (id) => ipcRenderer.invoke(IPC.downloadCancel, id),
    list: () => ipcRenderer.invoke(IPC.downloadList),
    onProgress: (cb) => subscribe(IPC.downloadProgress, cb)
  },
  models: {
    list: () => ipcRenderer.invoke(IPC.modelsList),
    delete: (id) => ipcRenderer.invoke(IPC.modelsDelete, id),
    reveal: (id) => ipcRenderer.invoke(IPC.modelsReveal, id),
    import: () => ipcRenderer.invoke(IPC.modelsImport),
    locate: (id) => ipcRenderer.invoke(IPC.modelsLocate, id)
  },
  engine: {
    load: (modelId) => ipcRenderer.invoke(IPC.engineLoad, modelId),
    unload: () => ipcRenderer.invoke(IPC.engineUnload),
    status: () => ipcRenderer.invoke(IPC.engineStatus),
    onStatus: (cb) => subscribe(IPC.engineStatusEvent, cb)
  },
  chat: {
    send: (req: ChatSendRequest) => ipcRenderer.invoke(IPC.chatSend, req),
    advance: (req: ChatAdvanceRequest) => ipcRenderer.invoke(IPC.chatAdvance, req),
    direct: (conversationId) => ipcRenderer.invoke(IPC.chatDirect, conversationId),
    abortDirector: (conversationId) => ipcRenderer.invoke(IPC.chatDirectAbort, conversationId),
    abort: (req) => ipcRenderer.invoke(IPC.chatAbort, req),
    compact: (conversationId) => ipcRenderer.invoke(IPC.chatCompact, conversationId),
    invalidateSession: (conversationId) => ipcRenderer.invoke(IPC.chatInvalidate, conversationId),
    onEvent: (cb) => subscribe(IPC.chatEvent, cb)
  },
  context: {
    usage: (conversationId) => ipcRenderer.invoke(IPC.contextUsage, conversationId),
    projectedUsage: (projection) => ipcRenderer.invoke(IPC.contextProjectedUsage, projection),
    onUsage: (cb) => subscribe(IPC.contextEvent, cb)
  },
  conversations: {
    list: () => ipcRenderer.invoke(IPC.convList),
    get: (id) => ipcRenderer.invoke(IPC.convGet, id),
    save: (conversation: Conversation) => ipcRenderer.invoke(IPC.convSave, conversation),
    delete: (id) => ipcRenderer.invoke(IPC.convDelete, id),
    export: (id, format) => ipcRenderer.invoke(IPC.convExport, id, format)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: RendererSettingsPatch) => ipcRenderer.invoke(IPC.settingsSet, patch),
    setHfToken: (token) => ipcRenderer.invoke(IPC.settingsSetHfToken, token),
    clearHfToken: () => ipcRenderer.invoke(IPC.settingsClearHfToken)
  },
  vault: {
    status: () => ipcRenderer.invoke(IPC.vaultStatus),
    setup: (request) => ipcRenderer.invoke(IPC.vaultSetup, request),
    unlock: (recoveryPassphrase) => ipcRenderer.invoke(IPC.vaultUnlock, recoveryPassphrase),
    unlockPasskey: () => ipcRenderer.invoke(IPC.vaultUnlockPasskey),
    lock: () => ipcRenderer.invoke(IPC.vaultLock),
    setSeamless: (enabled) => ipcRenderer.invoke(IPC.vaultSetSeamless, enabled),
    setPasskey: (enabled) => ipcRenderer.invoke(IPC.vaultSetPasskey, enabled),
    changeRecoveryPassphrase: (recoveryPassphrase) =>
      ipcRenderer.invoke(IPC.vaultChangeRecoveryPassphrase, recoveryPassphrase),
    listBackups: () => ipcRenderer.invoke(IPC.vaultListBackups),
    createBackup: () => ipcRenderer.invoke(IPC.vaultCreateBackup),
    verifyRecovery: () => ipcRenderer.invoke(IPC.vaultVerifyRecovery),
    restoreBackup: (id) => ipcRenderer.invoke(IPC.vaultRestoreBackup, id)
  },
  portable: {
    exportConversation: (id, recoveryPassphrase) =>
      ipcRenderer.invoke(IPC.portableExportConversation, id, recoveryPassphrase),
    exportLibrary: (recoveryPassphrase) =>
      ipcRenderer.invoke(IPC.portableExportLibrary, recoveryPassphrase),
    inspectImport: (recoveryPassphrase) =>
      ipcRenderer.invoke(IPC.portableInspectImport, recoveryPassphrase),
    commitImport: (token) => ipcRenderer.invoke(IPC.portableCommitImport, token),
    discardImport: (token) => ipcRenderer.invoke(IPC.portableDiscardImport, token)
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    storageIssues: () => ipcRenderer.invoke(IPC.storageIssues),
    revealRecovery: (resource) => ipcRenderer.invoke(IPC.storageRevealRecovery, resource)
  },
  tts: {
    status: () => ipcRenderer.invoke(IPC.ttsStatus),
    onStatus: (cb) => subscribe(IPC.ttsStatusEvent, cb),
    listVoices: () => ipcRenderer.invoke(IPC.ttsVoicesList),
    listDownloads: () => ipcRenderer.invoke(IPC.ttsVoiceDownloads),
    downloadVoice: (voiceId) => ipcRenderer.invoke(IPC.ttsVoiceDownload, voiceId),
    cancelVoiceDownload: (voiceId) => ipcRenderer.invoke(IPC.ttsVoiceCancel, voiceId),
    deleteVoice: (voiceId) => ipcRenderer.invoke(IPC.ttsVoiceDelete, voiceId),
    onVoiceProgress: (cb) => subscribe(IPC.ttsVoiceProgress, cb),
    speak: (req: TtsSpeakRequest) => ipcRenderer.invoke(IPC.ttsSpeak, req),
    stop: () => ipcRenderer.invoke(IPC.ttsStop),
    onEvent: (cb) => subscribe(IPC.ttsEvent, cb)
  },
  update: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    status: () => ipcRenderer.invoke(IPC.updateStatus),
    onEvent: (cb) => subscribe(IPC.updateEvent, cb)
  }
}

contextBridge.exposeInMainWorld('sibyl', bridge)
