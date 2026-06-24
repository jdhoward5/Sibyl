import { app, BrowserWindow, session, shell } from 'electron'
import squirrelStartup from 'electron-squirrel-startup'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { registerIpc } from './ipc'
import { teardownGpu } from './shutdown'
import { initUpdater, checkForUpdates } from './updater'

// Squirrel.Windows fires the installer/uninstaller by relaunching the app with
// `--squirrel-{install,updated,uninstall,obsolete}`. electron-squirrel-startup
// creates/removes the Start Menu + Desktop shortcuts for those events and tells
// us to quit immediately. Must run before anything else (incl. the instance lock).
if (squirrelStartup) {
  app.quit()
}

// Newer llama.cpp CUDA backends abort with `CUDA error: invalid resource handle`
// if a context's CUDA streams/events are created on one libuv worker thread and
// freed on another — which is exactly what node-llama-cpp does (load and unload
// run as separate async workers). Pinning the libuv threadpool to a single worker
// keeps create + free on the same thread, so GPU teardown is clean. libuv reads
// this lazily when it first initializes the pool; setting it at the top of the
// main entry (before any fs/crypto/native async work) takes effect in practice.
// Windows/CUDA-only: the macOS Metal backend doesn't have this hazard, and a
// single-worker pool would needlessly serialize its libuv I/O (fs/crypto/dns).
if (process.platform === 'win32' && !process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '1'
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

// Lock to a single instance so model/download state isn't corrupted by two copies.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// Content-Security-Policy: no remote code, no inline scripts in production.
// Connect is limited to Hugging Face (search + model downloads) over TLS.
//
// In development the Vite dev server needs inline scripts + eval (React Refresh
// preamble) and a websocket (HMR), so we relax those locally only. Production
// stays strict. This header is the authoritative policy for the http:// dev
// server; for the packaged file:// app the meta tag (cspPlugin) also applies.
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Vite injects styles at runtime; allow inline styles only.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://huggingface.co https://*.huggingface.co https://cdn-lfs.huggingface.co https://*.hf.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:* https://huggingface.co https://*.huggingface.co https://cdn-lfs.huggingface.co https://*.hf.co",
  "object-src 'none'",
  "base-uri 'self'"
].join('; ')

const CSP = isDev ? DEV_CSP : PROD_CSP

function hardenSession(): void {
  const ses = session.defaultSession
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP]
      }
    })
  })

  // Deny all permission requests (camera, mic, geolocation, etc.) — Sibyl needs none.
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0c14',
    title: 'Sibyl',
    // Custom chrome on every platform (our TitleBar component is the caption).
    titleBarStyle: 'hidden',
    // Windows/Linux: draw the caption buttons ourselves via the overlay. macOS
    // keeps its native traffic lights (inset by titleBarStyle:'hidden') — nudge
    // them to vertically center within our 40px-tall header. titleBarOverlay is
    // a no-op on macOS, so the two are mutually exclusive by platform.
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: '#0b0c14', symbolColor: '#8b8fa8', height: 40 } }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node to require the bridge; renderer stays isolated
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true
    }
  })

  win.once('ready-to-show', () => win.show())

  if (isDev) {
    win.webContents.on('console-message', (_e, _level, message) => {
      console.log('[renderer]', message)
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log('[did-fail-load]', code, desc, url)
    })
  }

  // Headless smoke verification: optionally drive a real in-app generation
  // through the full IPC/engine stack, capture the rendered UI, then quit.
  if (process.env.SIBYL_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      void runSmoke(win)
    })
  }

  // Block in-app navigation to anywhere but our own content; open links externally.
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && url.startsWith('http://localhost')
    if (!allowed && !url.startsWith('file://')) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Reject attaching any non-preload webview / new webContents.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// Drives a real generation through the renderer's IPC bridge to validate the
// full chat path end-to-end inside Electron. Guarded entirely by env vars.
async function runSmoke(win: BrowserWindow): Promise<void> {
  const outDir = process.env.SIBYL_SMOKE_OUT || app.getPath('temp')
  const fs = await import('node:fs')
  const shot = async (name: string): Promise<void> => {
    const img = await win.webContents.capturePage()
    await fs.promises.writeFile(path.join(outDir, name), img.toPNG())
  }

  try {
    const modelFile = process.env.SIBYL_SMOKE_MODEL
    if (modelFile) {
      // Register the pre-downloaded model through the real persistence layer.
      const { upsertInstalledModel } = await import('./store')
      const { modelIdFor, parseQuant, parseParamLabel } = await import('@shared/format')
      const repoId = 'bartowski/Qwen2.5-0.5B-Instruct-GGUF'
      const filename = path.basename(modelFile)
      const size = (await fs.promises.stat(modelFile)).size
      await upsertInstalledModel({
        id: modelIdFor(repoId, filename),
        repoId,
        filename,
        path: modelFile,
        sizeBytes: size,
        quant: parseQuant(filename),
        paramLabel: parseParamLabel(repoId),
        installedAt: new Date().toISOString()
      })

      // Drive load → send → stream through window.sibyl (the real bridge).
      const result = (await win.webContents.executeJavaScript(
        `(async () => {
          const id = ${JSON.stringify(modelIdFor(repoId, filename))};
          const o = window.sibyl;
          const load = await o.engine.load(id);
          if (!load.ok) return { error: 'load failed: ' + load.error };

          async function runTurn(convId, asstId, msg) {
            const now = new Date().toISOString();
            const conv = { id: convId, title: convId, modelId: id,
              messages: [
                { id: 'u-' + asstId, role: 'user', content: msg, createdAt: now },
                { id: asstId, role: 'assistant', content: '', createdAt: now }
              ], createdAt: now, updatedAt: now };
            await o.conversations.save(conv);
            let text = '';
            let unsub;
            const done = new Promise((resolve) => {
              unsub = o.chat.onEvent((e) => {
                if (e.messageId !== asstId) return;
                if (e.type === 'token') text += e.text;
                else if (e.type === 'done') resolve({ text, stats: e.stats });
                else if (e.type === 'error') resolve({ error: e.error });
              });
            });
            const send = await o.chat.send({ conversationId: convId, message: msg, assistantMessageId: asstId });
            if (!send.ok) { if (unsub) unsub(); return { error: 'send failed: ' + send.error }; }
            const r = await Promise.race([done, new Promise((res) => setTimeout(() => res({ error: 'timeout', text }), 60000))]);
            if (unsub) unsub();
            return r;
          }

          // Two separate conversations: the second forces the setChatHistory
          // swap path (previously would exhaust context sequences).
          const r1 = await runTurn('smoke-conv-1', 'asst-1', 'Reply with exactly: Sibyl is online.');
          if (r1.error || !(r1.text || '').trim()) return { error: 'turn1: ' + (r1.error || 'empty') };
          const r2 = await runTurn('smoke-conv-2', 'asst-2', 'What is 2+2? Reply with just the number.');
          if (r2.error || !(r2.text || '').trim()) return { error: 'turn2: ' + (r2.error || 'empty') };
          return { text: r1.text, text2: r2.text, stats: r2.stats };
        })()`,
        true
      )) as { text?: string; text2?: string; error?: string; stats?: unknown }

      // Privacy invariant: never log message/response text — only status + lengths.
      console.log(
        '[smoke] in-app chat result:',
        JSON.stringify({
          ok: !result.error && Boolean(result.text?.trim()) && Boolean(result.text2?.trim()),
          error: result.error,
          text1Len: result.text?.length ?? 0,
          text2Len: result.text2?.length ?? 0
        })
      )
      await shot('sibyl-smoke-chat.png')
      if (result.error || !result.text?.trim() || !result.text2?.trim()) {
        console.error('[smoke] CHAT FAILED')
        setTimeout(() => app.exit(1), 300)
        return
      }
      console.log('[smoke] ✅ IN-APP CHAT PASSED (2 conversations)')
    } else {
      // Give the renderer time to finish init() (slower on a cold dev server).
      const delay = Number(process.env.SIBYL_SMOKE_DELAY || 0)
      if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      await shot('sibyl-smoke.png')
    }
  } catch (err) {
    console.error('[smoke] error', err)
    setTimeout(() => app.exit(1), 300)
    return
  }
  setTimeout(() => app.quit(), 400)
}

app.whenReady().then(() => {
  hardenSession()
  registerIpc()
  initUpdater()
  createWindow()

  // Check GitHub for a newer release shortly after launch (packaged builds only;
  // the Squirrel updater is inert when unpackaged). Squirrel auto-downloads if one
  // is found. Best-effort — failures surface as an `error` status in the Updates UI.
  if (app.isPackaged) {
    setTimeout(() => void checkForUpdates(), 4000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Tear the GPU context down fully before the process exits — disposing the
// native llama.cpp/CUDA backend out from under an exiting process otherwise
// crashes on Windows. We intercept the first quit, clean up, then exit.
//
// The auto-updater's install path (updater.ts) runs the *same* `teardownGpu()`
// before it spawns the NSIS installer, so by the time `quitAndInstall` triggers
// this handler the teardown is already done and we exit at once — otherwise the
// installer's "is Sibyl still running?" check trips while we're disposing and
// reports "Sibyl cannot be closed".
let cleanedUp = false
app.on('before-quit', (event) => {
  if (cleanedUp) return
  event.preventDefault()
  cleanedUp = true
  // Never hang the quit on teardown: a watchdog force-exits if it stalls. The
  // ceiling is generous because engine.unload() may first await an in-flight
  // generation to stop.
  const watchdog = setTimeout(() => app.exit(0), 10_000)
  void teardownGpu().finally(() => {
    clearTimeout(watchdog)
    app.exit(0)
  })
})
