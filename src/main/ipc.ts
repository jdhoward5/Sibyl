import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC, type AppInfo, type ChatSendRequest } from '@shared/ipc'
import { buildExport, exportFileBaseName, type ExportFormat } from '@shared/export'
import type {
  AppSettings,
  ContextUsage,
  Conversation,
  EngineStatus,
  GenerationEvent,
  Result
} from '@shared/types'
import { getModelDetail, searchModels, type SortKey } from './hf'
import { downloadManager } from './downloads'
import { engine } from './engine'
import { updater } from './updater'
import {
  deleteConversation,
  getConversation,
  getInstalledModel,
  getSettings,
  importLocalModel,
  isSecureStorageAvailable,
  listConversations,
  listInstalledModels,
  removeInstalledModel,
  saveConversation,
  setSettings
} from './store'

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

function fail<T>(error: unknown): Result<T> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/** Wrap an async handler so it always resolves to a Result and never throws across IPC. */
function handle<T>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<T>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return ok(await fn(event, ...args))
    } catch (err) {
      return fail<T>(err)
    }
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerIpc(): void {
  // --- Hugging Face -------------------------------------------------------
  handle(IPC.hfSearch, async (_e, query: string, sort?: SortKey) =>
    searchModels(String(query ?? ''), (sort as SortKey) ?? 'trending')
  )
  handle(IPC.hfModelDetail, async (_e, repoId: string) => getModelDetail(String(repoId)))

  // --- Downloads ----------------------------------------------------------
  handle(IPC.downloadStart, async (_e, repoId: string, filename: string) =>
    downloadManager.start(String(repoId), String(filename))
  )
  handle(IPC.downloadCancel, async (_e, id: string) => {
    downloadManager.cancel(String(id))
  })
  handle(IPC.downloadList, async () => downloadManager.list())

  // --- Installed models ---------------------------------------------------
  handle(IPC.modelsList, async () => listInstalledModels())
  handle(IPC.modelsDelete, async (_e, id: string) => {
    if (engine && (await engine.status()).modelId === id) {
      await engine.unload()
    }
    const removed = await removeInstalledModel(String(id))
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
  handle(IPC.modelsReveal, async (_e, id: string) => {
    const model = await getInstalledModel(String(id))
    if (model) shell.showItemInFolder(model.path)
  })
  handle(IPC.modelsImport, async () => {
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
  handle(IPC.engineLoad, async (_e, modelId: string) => engine.load(String(modelId)))
  handle(IPC.engineUnload, async () => {
    await engine.unload()
  })
  handle(IPC.engineStatus, async () => engine.status())

  // --- Chat ---------------------------------------------------------------
  handle(IPC.chatSend, async (_e, req: ChatSendRequest) => {
    const conversation = await getConversation(req.conversationId)
    if (!conversation) throw new Error(`Conversation not found: ${req.conversationId}`)
    // Fire generation; streaming events flow over IPC.chatEvent.
    void engine.generate(conversation, req.message, req.assistantMessageId, req.options)
  })
  handle(IPC.chatAbort, async () => {
    engine.abortGeneration()
  })
  handle(IPC.chatCompact, async (_e, conversationId: string) => {
    const conversation = await getConversation(String(conversationId))
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`)
    return engine.compact(conversation)
  })
  handle(IPC.chatInvalidate, async (_e, conversationId: string) => {
    engine.invalidateSession(String(conversationId))
  })

  // --- Context window -----------------------------------------------------
  handle(IPC.contextUsage, async (_e, conversationId: string | null) => {
    const conversation = conversationId ? await getConversation(String(conversationId)) : null
    return engine.computeUsage(conversation)
  })

  // --- Conversations ------------------------------------------------------
  handle(IPC.convList, async () => listConversations())
  handle(IPC.convGet, async (_e, id: string) => {
    const conv = await getConversation(String(id))
    if (!conv) throw new Error(`Conversation not found: ${id}`)
    return conv
  })
  handle(IPC.convSave, async (_e, conversation: Conversation) => {
    await saveConversation(conversation)
  })
  handle(IPC.convDelete, async (_e, id: string) => {
    await deleteConversation(String(id))
  })
  handle(IPC.convExport, async (_e, id: string, format: ExportFormat) => {
    const conversation = await getConversation(String(id))
    if (!conversation) throw new Error(`Conversation not found: ${id}`)
    const fmt: ExportFormat =
      format === 'json' || format === 'text' ? format : 'markdown'
    const { content, ext } = buildExport(conversation, fmt)
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
  handle(IPC.settingsGet, async () => getSettings())
  handle(IPC.settingsSet, async (_e, patch: Partial<AppSettings>) => setSettings(patch))

  // --- App info -----------------------------------------------------------
  handle(IPC.appInfo, async (): Promise<AppInfo> => {
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

  // --- Auto-update --------------------------------------------------------
  handle(IPC.updateCheck, async () => updater.check())
  handle(IPC.updateInstall, async () => {
    await updater.install()
  })
  handle(IPC.updateStatus, async () => updater.getStatus())

  // --- Event forwarding main → renderer -----------------------------------
  downloadManager.on('progress', (p) => broadcast(IPC.downloadProgress, p))
  engine.on('event', (e: GenerationEvent) => broadcast(IPC.chatEvent, e))
  engine.on('status', (s: EngineStatus) => broadcast(IPC.engineStatusEvent, s))
  engine.on('context', (u: ContextUsage) => broadcast(IPC.contextEvent, u))
  updater.on('status', (s) => broadcast(IPC.updateEvent, s))
}
