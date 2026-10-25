import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import type { IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type AppInfo,
  type ChatAbortRequest,
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
import { deleteInstalledModel, downloadManager } from './downloads'
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
  listStorageIssues,
  changePrivateVaultRecoveryPassphrase,
  createPrivateVaultBackup,
  listPrivateVaultBackups,
  lockPrivateVault,
  privateVaultStatus,
  recoveryPathFor,
  relocateInstalledModel,
  restorePrivateVaultBackup,
  saveConversation,
  setPrivateVaultSeamless,
  setPrivateVaultPasskey,
  setSettings,
  setupPrivateVault,
  settingsForRenderer,
  unlockPrivateVault,
  unlockPrivateVaultWithPasskey,
  verifyPrivateVaultRecovery
} from './store'
import {
  assertChatAdvanceState,
  assertChatSendState,
  parseArgs,
  parseCanonicalId,
  parseChatAbortRequest,
  parseChatAdvanceRequest,
  parseChatSendRequest,
  parseConversation,
  parseContextUsageProjection,
  parseExportFormat,
  parseHfToken,
  parseModelId,
  parseNoArgs,
  parsePortableImportToken,
  parseRendererSettingsPatch,
  parseRepoFilename,
  parseRepoId,
  parseRecoveryPassphrase,
  parseSearchQuery,
  parseSortKey,
  parseTtsSpeakRequest,
  parseVaultBackupId,
  parseVaultSetupRequest
} from '@shared/validation'
import {
  commitPortableImport,
  clearPortableImports,
  discardPortableImport,
  exportPortableConversation,
  exportPortableLibrary,
  inspectPortableImport
} from './portableService'
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
  // --- Encrypted private-data vault ---------------------------------------
  handle(IPC.vaultStatus, policy, parseNoArgs, async () => privateVaultStatus())
  handle(
    IPC.vaultSetup,
    policy,
    (args) => parseArgs(args, parseVaultSetupRequest),
    async (_event, request) =>
      setupPrivateVault(request.recoveryPassphrase, request.seamlessOnThisDevice)
  )
  handle(
    IPC.vaultUnlock,
    policy,
    (args) => parseArgs(args, parseRecoveryPassphrase),
    async (_event, recoveryPassphrase) => unlockPrivateVault(recoveryPassphrase)
  )
  handle(
    IPC.vaultUnlockPasskey,
    policy,
    parseNoArgs,
    async () => unlockPrivateVaultWithPasskey()
  )
  handle(
    IPC.vaultSetSeamless,
    policy,
    (args) =>
      parseArgs<[boolean]>(args, (value) => {
        if (typeof value !== 'boolean') throw new Error('Invalid IPC argument enabled: expected a boolean.')
        return value
      }),
    async (_event, enabled) => setPrivateVaultSeamless(enabled)
  )
  handle(
    IPC.vaultSetPasskey,
    policy,
    (args) =>
      parseArgs<[boolean]>(args, (value) => {
        if (typeof value !== 'boolean') {
          throw new Error(
            'Invalid IPC argument enabled: expected a boolean.'
          )
        }
        return value
      }),
    async (_event, enabled) => setPrivateVaultPasskey(enabled)
  )
  handle(IPC.vaultLock, policy, parseNoArgs, async (event) => {
    clearPortableImports()
    await tts.dispose()
    await engine.unload()
    const status = lockPrivateVault()
    setTimeout(() => {
      if (!event.sender.isDestroyed()) event.sender.reload()
    }, 50)
    return status
  })
  handle(
    IPC.vaultChangeRecoveryPassphrase,
    policy,
    (args) => parseArgs(args, parseRecoveryPassphrase),
    async (_event, recoveryPassphrase) =>
      changePrivateVaultRecoveryPassphrase(recoveryPassphrase)
  )
  handle(IPC.vaultListBackups, policy, parseNoArgs, async () => listPrivateVaultBackups())
  handle(IPC.vaultCreateBackup, policy, parseNoArgs, async () => {
    await createPrivateVaultBackup()
  })
  handle(IPC.vaultVerifyRecovery, policy, parseNoArgs, async () =>
    verifyPrivateVaultRecovery()
  )
  handle(
    IPC.vaultRestoreBackup,
    policy,
    (args) => parseArgs(args, parseVaultBackupId),
    async (event, id) => {
      clearPortableImports()
      await tts.dispose()
      await engine.unload()
      await restorePrivateVaultBackup(id)
      setTimeout(() => {
        if (!event.sender.isDestroyed()) event.sender.reload()
      }, 50)
    }
  )

  // --- Encrypted portable bundles ----------------------------------------
  handle(
    IPC.portableExportConversation,
    policy,
    (args) =>
      parseArgs<[string, string]>(
        args,
        (value) => parseCanonicalId(value, 'conversationId'),
        parseRecoveryPassphrase
      ),
    async (_event, conversationId, recoveryPassphrase) => {
      const encrypted = await exportPortableConversation(
        conversationId,
        recoveryPassphrase
      )
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.SaveDialogOptions = {
        defaultPath: `Sibyl-conversation-${new Date().toISOString().slice(0, 10)}.sibyl`,
        filters: [{ name: 'Encrypted Sibyl bundle', extensions: ['sibyl'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { saved: false }
      await fs.writeFile(result.filePath, encrypted, { encoding: 'utf8', mode: 0o600 })
      return { saved: true, path: result.filePath }
    }
  )
  handle(
    IPC.portableExportLibrary,
    policy,
    (args) => parseArgs<[string]>(args, parseRecoveryPassphrase),
    async (_event, recoveryPassphrase) => {
      const encrypted = await exportPortableLibrary(recoveryPassphrase)
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.SaveDialogOptions = {
        defaultPath: `Sibyl-library-${new Date().toISOString().slice(0, 10)}.sibyl`,
        filters: [{ name: 'Encrypted Sibyl bundle', extensions: ['sibyl'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { saved: false }
      await fs.writeFile(result.filePath, encrypted, { encoding: 'utf8', mode: 0o600 })
      return { saved: true, path: result.filePath }
    }
  )
  handle(
    IPC.portableInspectImport,
    policy,
    (args) => parseArgs<[string]>(args, parseRecoveryPassphrase),
    async (_event, recoveryPassphrase) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.OpenDialogOptions = {
        title: 'Open an encrypted Sibyl bundle',
        properties: ['openFile'],
        filters: [{ name: 'Encrypted Sibyl bundle', extensions: ['sibyl'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      return inspectPortableImport(result.filePaths[0], recoveryPassphrase)
    }
  )
  handle(
    IPC.portableCommitImport,
    policy,
    (args) => parseArgs<[string]>(args, parsePortableImportToken),
    async (_event, token) => {
      tts.stop()
      await engine.unload()
      return commitPortableImport(token)
    }
  )
  handle(
    IPC.portableDiscardImport,
    policy,
    (args) => parseArgs<[string]>(args, parsePortableImportToken),
    async (_event, token) => {
      discardPortableImport(token)
    }
  )

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
    const status = await engine.status()
    if (status.modelId === id || status.operation?.modelId === id) {
      await engine.unload()
    }
    await deleteInstalledModel(id)
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
  handle(IPC.modelsLocate, policy, (args) => parseArgs<[string]>(args, (v) => parseModelId(v)), async (_e, id) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts = {
      title: 'Locate the GGUF model file',
      properties: ['openFile' as const],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    return relocateInstalledModel(id, result.filePaths[0])
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
    void engine.generate(conversation, req.message, req.assistantMessageId, req.options).catch(() => {})
  })
  handle(IPC.chatAdvance, policy, (args) => parseArgs<[ChatAdvanceRequest]>(args, parseChatAdvanceRequest), async (_e, req) => {
    const conversation = await getConversation(req.conversationId)
    if (!conversation) throw new Error(`Conversation not found: ${req.conversationId}`)
    assertChatAdvanceState(conversation, req)
    // Generate one scene beat; streaming events flow over the same IPC.chatEvent.
    void engine.generateBeat(conversation, req.speakerId, req.assistantMessageId, req.options).catch(() => {})
  })
  handle(
    IPC.chatDirect,
    policy,
    (args) => parseArgs<[string]>(args, (value) => parseCanonicalId(value, 'conversationId')),
    async (_e, conversationId) => {
      const conversation = await getConversation(conversationId)
      if (!conversation) throw new Error(`Conversation not found: ${conversationId}`)
      return engine.directScene(conversation)
    }
  )
  handle(
    IPC.chatDirectAbort,
    policy,
    (args) => parseArgs<[string]>(args, (value) => parseCanonicalId(value, 'conversationId')),
    async (_e, conversationId) => ({ aborted: engine.abortSceneDirector(conversationId) })
  )
  handle(IPC.chatAbort, policy, (args) => parseArgs<[ChatAbortRequest]>(args, parseChatAbortRequest), async (_e, req) => {
    return { aborted: engine.abortGeneration(req) }
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
  handle(
    IPC.contextProjectedUsage,
    policy,
    (args) => parseArgs(args, parseContextUsageProjection),
    async (_e, projection) => {
      const conversation = await getConversation(projection.conversationId)
      if (!conversation) throw new Error(`Conversation not found: ${projection.conversationId}`)
      return engine.computeProjectedUsage(conversation, projection)
    }
  )

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
  handle(IPC.appHardware, policy, parseNoArgs, async () => engine.hardware())
  handle(IPC.appInfo, policy, parseNoArgs, async (): Promise<AppInfo> => {
    const settings = await getSettings()
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      modelsDir: settings.modelsDir,
      systemMemoryTotalBytes: totalmem(),
      systemMemoryFreeBytes: freemem(),
      secureStorageAvailable: isSecureStorageAvailable()
    }
  })
  handle(IPC.storageIssues, policy, parseNoArgs, async () => listStorageIssues())
  handle(
    IPC.storageRevealRecovery,
    policy,
    (args) =>
      parseArgs<['models' | 'voices']>(args, (value) => {
        if (value !== 'models' && value !== 'voices') throw new Error('Invalid storage resource.')
        return value
      }),
    async (_e, resource) => {
      const recoveryPath = recoveryPathFor(resource)
      if (!recoveryPath) throw new Error('No recovery copy is available.')
      shell.showItemInFolder(recoveryPath)
    }
  )

  // --- Text-to-speech -----------------------------------------------------
  handle(IPC.ttsStatus, policy, parseNoArgs, async () => tts.status())
  handle(IPC.ttsVoicesList, policy, parseNoArgs, async () => listInstalledVoices())
  handle(IPC.ttsVoiceDownloads, policy, parseNoArgs, async () => tts.listVoiceDownloads())
  handle(IPC.ttsVoiceDownload, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v, 'voiceId')), async (_e, voiceId) => {
    // Fire-and-forget; progress flows over IPC.ttsVoiceProgress.
    void Promise.resolve(tts.downloadVoice(voiceId)).catch(() => {})
  })
  handle(IPC.ttsVoiceCancel, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v, 'voiceId')), async (_e, voiceId) => {
    tts.cancelVoiceDownload(voiceId)
  })
  handle(IPC.ttsVoiceDelete, policy, (args) => parseArgs<[string]>(args, (v) => parseCanonicalId(v, 'voiceId')), async (_e, voiceId) => {
    await tts.deleteVoice(voiceId)
  })
  handle(IPC.ttsSpeak, policy, (args) => parseArgs<[TtsSpeakRequest]>(args, parseTtsSpeakRequest), async (_e, req) => {
    // Privacy: req.text is message content — synthesized locally, never logged.
    void Promise.resolve(
      tts.speak(req.messageId, req.text, { voiceId: req.voiceId, rate: req.rate })
    ).catch(() => {})
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
