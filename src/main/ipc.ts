import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type AppInfo,
  type ChatSendRequest,
  type ChatAdvanceRequest,
  type TtsSpeakRequest
} from '@shared/ipc'
import { buildExport, exportFileBaseName, type ExportFormat } from '@shared/export'
import type {
  ContextUsage,
  Conversation,
  EngineStatus,
  GenerationEvent,
  Result
} from '@shared/types'
import { getModelDetail, repoContainsGgufFile, searchModels } from './hf'
import { downloadManager } from './downloads'
import { engine } from './engine'
import { tts } from './tts'
import { updater } from './updater'
import type { TtsEvent, TtsStatus, TtsVoiceDownload } from '@shared/tts'
import {
  deleteConversation,
  getConversation,
  getInstalledModel,
  getSettings,
  importLocalModel,
  isSecureStorageAvailable,
  listConversations,
  listInstalledModels,
  listInstalledVoices,
  removeInstalledModel,
  saveConversation,
  setSettings,
  settingsForRenderer
} from './store'
import {
  assertChatAdvanceState,
  assertChatSendState,
  parseArgs,
  parseCanonicalId,
  parseChatAdvanceRequest,
  parseChatSendRequest,
  parseConversation,
  parseExportFormat,
  parseHfToken,
  parseModelId,
  parseNoArgs,
  parseRendererSettingsPatch,
  parseRepoFilename,
  parseRepoId,
  parseSearchQuery,
  parseSortKey,
  parseTtsSpeakRequest
} from '@shared/validation'
import {
  isAllowedRendererUrl,
  isTrustedRendererFrame,
  type RendererUrlPolicy
} from '@shared/security'

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

function fail<T>(error: unknown): Result<T> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

function trustedSender(event: IpcMainInvokeEvent, policy: RendererUrlPolicy): boolean {
  const frame = event.senderFrame
  if (!frame) return false
  return isTrustedRendererFrame(
    {
      senderDestroyed: event.sender.isDestroyed(),
      isMainFrame: frame === event.sender.mainFrame,
      isTopFrame: frame.top === frame,
      url: frame.url
    },
    policy
  )
}

/** Authenticate, validate, and wrap every handler in a structured Result. */
function handle<TArgs extends unknown[], T>(
  channel: string,
  policy: RendererUrlPolicy,
  parse: (args: unknown[]) => TArgs,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<T>
): void {
  ipcMain.handle(channel, async (event, ...rawArgs) => {
    try {
      if (!trustedSender(event, policy)) {
        return fail<T>('IPC request rejected: untrusted renderer frame or URL.')
      }
      const args = parse(rawArgs)
      return ok(await fn(event, ...args))
    } catch (err) {
      return fail<T>(err)
    }
  })
}

function broadcast(channel: string, payload: unknown, policy: RendererUrlPolicy): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (
      !win.isDestroyed() &&
      isAllowedRendererUrl(win.webContents.mainFrame.url, policy)
    ) {
      win.webContents.send(channel, payload)
    }
  }
}

export function registerIpc(policy: RendererUrlPolicy): void {
  // --- Hugging Face -------------------------------------------------------
  handle(
    IPC.hfSearch,
    policy,
    (args) => parseArgs<[string, 'trending' | 'downloads' | 'likes' | undefined]>(
      args,
      parseSearchQuery,
      parseSortKey
    ),
    async (_e, query, sort) => searchModels(query, sort ?? 'trending')
  )
  handle(
    IPC.hfModelDetail,
    policy,
    (args) => parseArgs<[string]>(args, (v) => parseRepoId(v)),
    async (_e, repoId) => getModelDetail(repoId)
  )

  // --- Downloads ----------------------------------------------------------
  handle(
    IPC.downloadStart,
    policy,
    (args) => parseArgs<[string, string]>(args, (v) => parseRepoId(v), (v) => parseRepoFilename(v)),
    async (_e, repoId, filename) => {
      if (!(await repoContainsGgufFile(repoId, filename))) {
        throw new Error('The requested GGUF file is not present in the selected repository.')
      }
      return downloadManager.start(repoId, filename)
    }
  )
  handle(
    IPC.downloadCancel,
    policy,
    (args) => parseArgs<[string]>(args, (v) => parseModelId(v, 'downloadId')),
    async (_e, id) => {
      downloadManager.cancel(id)
    }
  )
  handle(IPC.downloadList, policy, parseNoArgs, async () => downloadManager.list())

  // --- Installed models ---------------------------------------------------
  handle(IPC.modelsList, policy, parseNoArgs, async () => listInstalledModels())
  handle(IPC.modelsDelete, policy, (args) => parseArgs<[string]>(args, (v) => parseModelId(v)), async (_e, id) => {
    if (engine && (await engine.status()).modelId === id) {
      await engine.unload()
    }
    const removed = await removeInstalledModel(id)
    // Only delete files Sibyl fetched. A locally-imported model points at the
    // user's own file, registered in place — deregister it but never unlink it.
    if (removed && !removed.local) {
      try {
        await fs.unlink(removed.path)
      } catch {
        /* file may already be gone */
      }
    }
  })
  handle(IPC.modelsReveal, policy, (args) => parseArgs<[string]>(args, (v) => parseModelId(v)), async (_e, id) => {
    const model = await getInstalledModel(id)
    if (model) shell.showItemInFolder(model.path)
  })
  handle(IPC.modelsImport, policy, parseNoArgs, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts = {
      title: 'Select a GGUF model file',
      properties: ['openFile' as const],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return importLocalModel(result.filePaths[0])
  })

  // --- Engine -------------------------------------------------------------
  handle(IPC.engineLoad, policy, (args) => parseArgs<[string]>(args, (v) => parseModelId(v)), async (_e, modelId) => engine.load(modelId))
  handle(IPC.engineUnload, policy, parseNoArgs, async () => {
    await engine.unload()
  })
  handle(IPC.engineStatus, policy, parseNoArgs, async () => engine.status())

  // --- Chat ---------------------------------------------------------------
  handle(IPC.chatSend, policy, (args) => parseArgs<[ChatSendRequest]>(args, parseChatSendRequest), async (_e, req) => {
    const conversation = await getConversation(req.conversationId)
    if (!conversation) throw new Error(`Conversation not found: ${req.conversationId}`)
    assertChatSendState(conversation, req)
    // Fire generation; streaming events flow over IPC.chatEvent.
    void engine.generate(conversation, req.message, req.assistantMessageId, req.options)
  })
  handle(IPC.chatAdvance, policy, (args) => parseArgs<[ChatAdvanceRequest]>(args, parseChatAdvanceRequest), async (_e, req) => {
    const conversation = await getConversation(req.conversationId)
    if (!conversation) throw new Error(`Conversation not found: ${req.conversationId}`)
    assertChatAdvanceState(conversation, req)
    // Generate one scene beat; streaming events flow over the same IPC.chatEvent.
    void engine.generateBeat(conversation, req.speakerId, req.assistantMessageId, req.options)
  })
  handle(IPC.chatAbort, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v, 'conversationId')), async (_e, _conversationId) => {
    engine.abortGeneration()
  })
  handle(IPC.chatCompact, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v, 'conversationId')), async (_e, conversationId) => {
    const conversation = await getConversation(conversationId)
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`)
    return engine.compact(conversation)
  })
  handle(IPC.chatInvalidate, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v, 'conversationId')), async (_e, conversationId) => {
    engine.invalidateSession(conversationId)
  })

  // --- Context window -----------------------------------------------------
  handle(
    IPC.contextUsage,
    policy,
    (args) =>
      parseArgs<[string | null]>(args, (v) =>
        v === null ? null : parseCanonicalId(v, 'conversationId')
      ),
    async (_e, conversationId) => {
    const conversation = conversationId ? await getConversation(conversationId) : null
    return engine.computeUsage(conversation)
  })

  // --- Conversations ------------------------------------------------------
  handle(IPC.convList, policy, parseNoArgs, async () => listConversations())
  handle(IPC.convGet, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v)), async (_e, id) => {
    const conv = await getConversation(id)
    if (!conv) throw new Error(`Conversation not found: ${id}`)
    return conv
  })
  handle(IPC.convSave, policy, (args) => parseArgs<[Conversation]>(args, parseConversation), async (_e, conversation) => {
    await saveConversation(conversation)
  })
  handle(IPC.convDelete, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v)), async (_e, id) => {
    await deleteConversation(id)
  })
  handle(IPC.convExport, policy, (args) => parseArgs<[string, ExportFormat]>(
    args,
    (v) => parseCanonicalId(v),
    parseExportFormat
  ), async (_e, id, format) => {
    const conversation = await getConversation(id)
    if (!conversation) throw new Error(`Conversation not found: ${id}`)
    const { content, ext } = buildExport(conversation, format)
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const options: Electron.SaveDialogOptions = {
      defaultPath: `${exportFileBaseName(conversation)}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { saved: false }
    await fs.writeFile(result.filePath, content, 'utf8')
    return { saved: true, path: result.filePath }
  })

  // --- Settings -----------------------------------------------------------
  handle(IPC.settingsGet, policy, parseNoArgs, async () => settingsForRenderer(await getSettings()))
  handle(
    IPC.settingsSet,
    policy,
    (args) => parseArgs(args, parseRendererSettingsPatch),
    async (_e, patch) => settingsForRenderer(await setSettings(patch))
  )
  handle(
    IPC.settingsSetHfToken,
    policy,
    (args) => parseArgs<[string]>(args, parseHfToken),
    async (_e, token) => {
      await setSettings({ hfToken: token })
    }
  )
  handle(IPC.settingsClearHfToken, policy, parseNoArgs, async () => {
    await setSettings({ hfToken: null })
  })

  // --- App info -----------------------------------------------------------
  handle(IPC.appInfo, policy, parseNoArgs, async (): Promise<AppInfo> => {
    const settings = await getSettings()
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      modelsDir: settings.modelsDir,
      secureStorageAvailable: isSecureStorageAvailable()
    }
  })

  // --- Text-to-speech -----------------------------------------------------
  handle(IPC.ttsStatus, policy, parseNoArgs, async () => tts.status())
  handle(IPC.ttsVoicesList, policy, parseNoArgs, async () => listInstalledVoices())
  handle(IPC.ttsVoiceDownloads, policy, parseNoArgs, async () => tts.listVoiceDownloads())
  handle(IPC.ttsVoiceDownload, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v, 'voiceId')), async (_e, voiceId) => {
    // Fire-and-forget; progress flows over IPC.ttsVoiceProgress.
    void tts.downloadVoice(voiceId)
  })
  handle(IPC.ttsVoiceCancel, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v, 'voiceId')), async (_e, voiceId) => {
    tts.cancelVoiceDownload(voiceId)
  })
  handle(IPC.ttsVoiceDelete, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v, 'voiceId')), async (_e, voiceId) => {
    await tts.deleteVoice(voiceId)
  })
  handle(IPC.ttsSpeak, policy, (args) => parseArgs<[TtsSpeakRequest]>(args, parseTtsSpeakRequest), async (_e, req) => {
    // Privacy: req.text is message content — synthesized locally, never logged.
    void tts.speak(req.messageId, req.text, { voiceId: req.voiceId, rate: req.rate })
  })
  handle(IPC.ttsStop, policy, parseNoArgs, async () => {
    tts.stop()
  })

  // --- Auto-update --------------------------------------------------------
  handle(IPC.updateCheck, policy, parseNoArgs, async () => updater.check())
  handle(IPC.updateInstall, policy, parseNoArgs, async () => {
    await updater.install()
  })
  handle(IPC.updateStatus, policy, parseNoArgs, async () => updater.getStatus())

  // --- Event forwarding main → renderer -----------------------------------
  downloadManager.on('progress', (p) => broadcast(IPC.downloadProgress, p, policy))
  engine.on('event', (e: GenerationEvent) => broadcast(IPC.chatEvent, e, policy))
  engine.on('status', (s: EngineStatus) => broadcast(IPC.engineStatusEvent, s, policy))
  engine.on('context', (u: ContextUsage) => broadcast(IPC.contextEvent, u, policy))
  tts.on('event', (e: TtsEvent) => broadcast(IPC.ttsEvent, e, policy))
  tts.on('status', (s: TtsStatus) => broadcast(IPC.ttsStatusEvent, s, policy))
  tts.on('voiceProgress', (p: TtsVoiceDownload) => broadcast(IPC.ttsVoiceProgress, p, policy))
  updater.on('status', (s) => broadcast(IPC.updateEvent, s, policy))
}
