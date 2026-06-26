import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { SibylBridge, ChatSendRequest, TtsSpeakRequest } from '@shared/ipc'
import type { AppSettings, Conversation } from '@shared/types'

/**
 * The single bridge exposed to the renderer. Every method funnels through
 * ipcRenderer.invoke (request/response) or a guarded event subscription.
 * The renderer never receives the raw IpcRendererEvent, only typed payloads.
 */

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
    import: () => ipcRenderer.invoke(IPC.modelsImport)
  },
  engine: {
    load: (modelId) => ipcRenderer.invoke(IPC.engineLoad, modelId),
    unload: () => ipcRenderer.invoke(IPC.engineUnload),
    status: () => ipcRenderer.invoke(IPC.engineStatus),
    onStatus: (cb) => subscribe(IPC.engineStatusEvent, cb)
  },
  chat: {
    send: (req: ChatSendRequest) => ipcRenderer.invoke(IPC.chatSend, req),
    abort: (conversationId) => ipcRenderer.invoke(IPC.chatAbort, conversationId),
    compact: (conversationId) => ipcRenderer.invoke(IPC.chatCompact, conversationId),
    invalidateSession: (conversationId) => ipcRenderer.invoke(IPC.chatInvalidate, conversationId),
    onEvent: (cb) => subscribe(IPC.chatEvent, cb)
  },
  context: {
    usage: (conversationId) => ipcRenderer.invoke(IPC.contextUsage, conversationId),
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
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo)
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
