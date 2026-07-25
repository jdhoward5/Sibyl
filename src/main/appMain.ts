import { app, BrowserWindow, session, shell } from 'electron'
import squirrelStartup from 'electron-squirrel-startup'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { registerIpc } from './ipc'
import {
  initializePrivateVault,
  privateVaultStatus,
  setupPrivateVault,
  upsertInstalledModel
} from './store'
import { teardownGpu } from './shutdown'
import { initUpdater, checkForUpdates } from './updater'
import { modelIdFor, parseParamLabel, parseQuant } from '@shared/format'
import {
  developmentRendererPolicy,
  isAllowedRendererUrl,
  isExternalWebUrl,
  type RendererUrlPolicy
} from '@shared/security'

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
const rendererFile = path.join(__dirname, '../renderer/index.html')

function rendererUrlPolicy(): RendererUrlPolicy {
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    return developmentRendererPolicy(process.env.ELECTRON_RENDERER_URL)
  }
  return { kind: 'file', exactUrl: pathToFileURL(rendererFile).href }
}

// Lock to a single instance so model/download state isn't corrupted by two copies.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// Content-Security-Policy: no remote code, no inline scripts in production.
// The renderer itself has no network role: Hugging Face search/downloads stay
// in main, behind validated IPC. Keeping connect/img local prevents rendered
// private text from becoming an exfiltration primitive after a renderer bug.
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
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
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

// Register before creating the main window so the protection applies to that
// webContents as well as anything created later.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

function createWindow(policy: RendererUrlPolicy): void {
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
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload uses only contextBridge/ipcRenderer plus bundled shared code,
      // all of which are supported by Electron's restricted sandboxed preload.
      sandbox: true,
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
    if (isAllowedRendererUrl(url, policy)) return
    event.preventDefault()
    if (isExternalWebUrl(url)) void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(rendererFile)
  }
}

// Drives a real generation through the renderer's IPC bridge to validate the
// full chat path end-to-end inside Electron. Guarded entirely by env vars.
async function runSmoke(win: BrowserWindow): Promise<void> {
  const outDir = process.env.SIBYL_SMOKE_OUT || app.getPath('temp')
  const fs = await import('node:fs')
  const shot = async (name: string): Promise<void> => {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500))
        const img = await win.webContents.capturePage()
        await fs.promises.writeFile(path.join(outDir, name), img.toPNG())
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  try {
    const modelFile = process.env.SIBYL_SMOKE_MODEL
    if (modelFile) {
      const smokeUserData = path.resolve(app.getPath('userData'))
      const smokeTempRoot = path.resolve(app.getPath('temp'))
      const smokeRelative = path.relative(smokeTempRoot, smokeUserData)
      if (
        process.env.SIBYL_SMOKE_ISOLATED !== '1' ||
        !smokeRelative ||
        smokeRelative.startsWith('..') ||
        path.isAbsolute(smokeRelative)
      ) {
        throw new Error(
          'Model smoke tests require SIBYL_SMOKE_ISOLATED=1 and a throwaway --user-data-dir under the OS temp directory.'
        )
      }
      let vault = await privateVaultStatus()
      let createdIsolatedVault = false
      if (vault.state === 'uninitialized') {
        vault = await setupPrivateVault('isolated smoke recovery passphrase', false)
        createdIsolatedVault = true
      }
      if (vault.state !== 'unlocked') {
        throw new Error('The private vault must be unlocked before running a model smoke test.')
      }
      if (createdIsolatedVault) {
        // Recreate the renderer so it hydrates private state from the newly
        // unlocked vault instead of leaving the first-run gate in the screenshot.
        await new Promise<void>((resolve) => {
          win.webContents.once('did-finish-load', () => resolve())
          win.webContents.reload()
        })
      }
      // Register the pre-downloaded model through the real persistence layer.
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

      const modelId = modelIdFor(repoId, filename)

      // Scene path (SIBYL_SMOKE_SCENE): drive multi-persona self-roleplay through
      // the real bridge — 3 round-robin beats via engine.generateBeat, then fire
      // two advances at once to prove the engine serializes them (one beat
      // completes, the other is cleanly rejected; no concurrent-prompt crash).
      if (process.env.SIBYL_SMOKE_SCENE) {
        const sc = (await win.webContents.executeJavaScript(
          `(async () => {
            const id = ${JSON.stringify(modelId)};
            const o = window.sibyl;
            const load = await o.engine.load(id);
            if (!load.ok) return { error: 'load failed: ' + load.error };
            const personas = [
              { id:'sc-ada', name:'Ada', role:'engineer', brief:'You are Ada, a blunt starship engineer. Reply with one short sentence, in character.', avatar:{monogram:'AD',gradient:['#5ee7ff','#3c93a4']}, voiceTags:[] },
              { id:'sc-bo', name:'Bo', role:'pilot', brief:'You are Bo, a cocky pilot. Reply with one short sentence, in character.', avatar:{monogram:'BO',gradient:['#ffa3b8','#a66878']}, voiceTags:[] }
            ];
            const sset = await o.settings.set({ personas });
            if (!sset.ok) return { error: 'settings.set failed: ' + sset.error };
            const convId = 'smoke-scene-1';
            const t0 = new Date().toISOString();
            await o.conversations.save({ id: convId, title:'Smoke scene', modelId:id, messages:[], cast:['sc-ada','sc-bo'], scenePremise:'Two crew aboard a failing ship argue about what to do.', director:{enabled:true,useModel:true,pacing:'balanced',initiative:'balanced',interruption:'natural-pauses',inspectIntent:false}, createdAt:t0, updatedAt:t0 });
            const directed = await o.chat.direct(convId);
            if(!directed.ok || !directed.data) return { error:'director failed: '+(directed.error||'empty') };
            const dd = directed.data;
            if(!['continue','pause','end'].includes(dd.action)) return { error:'director action invalid' };
            if(dd.action==='continue' && !['sc-ada','sc-bo'].includes(dd.speakerId)) return { error:'director speaker invalid' };
            const nameOf = (sid) => sid === 'sc-ada' ? 'Ada' : 'Bo';
            async function beat(speakerId, asstId) {
              const conv = (await o.conversations.get(convId)).data;
              conv.messages.push({ id:asstId, role:'assistant', content:'', createdAt:new Date().toISOString(), speakerId, speakerName: nameOf(speakerId) });
              await o.conversations.save(conv);
              await o.chat.invalidateSession(convId);
              let text=''; let unsub;
              const done = new Promise((resolve)=>{ unsub = o.chat.onEvent((e)=>{ if(e.messageId!==asstId) return; if(e.type==='token') text+=e.text; else if(e.type==='done') resolve({text}); else if(e.type==='error') resolve({error:e.error}); }); });
              const adv = await o.chat.advance({ conversationId: convId, speakerId, assistantMessageId: asstId, options:{ maxTokens: 64 } });
              if(!adv.ok){ if(unsub) unsub(); return { error:'advance failed: '+adv.error }; }
              const r = await Promise.race([done, new Promise((res)=>setTimeout(()=>res({error:'timeout',text}),60000))]);
              if(unsub) unsub();
              const c2 = (await o.conversations.get(convId)).data;
              const m = c2.messages.find((x)=>x.id===asstId);
              if(m){ m.content = r.text||''; await o.conversations.save(c2); }
              return r;
            }
            const b1 = await beat('sc-ada','beat-1'); if(b1.error||!(b1.text||'').trim()) return { error:'beat1: '+(b1.error||'empty') };
            const b2 = await beat('sc-bo','beat-2');  if(b2.error||!(b2.text||'').trim()) return { error:'beat2: '+(b2.error||'empty') };
            const b3 = await beat('sc-ada','beat-3'); if(b3.error||!(b3.text||'').trim()) return { error:'beat3: '+(b3.error||'empty') };
            // Concurrency latch: append two beats, fire both advances without awaiting.
            const conv = (await o.conversations.get(convId)).data;
            conv.messages.push({ id:'race-1', role:'assistant', content:'', createdAt:new Date().toISOString(), speakerId:'sc-bo', speakerName:'Bo' });
            conv.messages.push({ id:'race-2', role:'assistant', content:'', createdAt:new Date().toISOString(), speakerId:'sc-ada', speakerName:'Ada' });
            await o.conversations.save(conv);
            await o.chat.invalidateSession(convId);
            const outcomes = {}; let count=0; let settle; const both = new Promise((res)=>{ settle=res; });
            const unsub2 = o.chat.onEvent((e)=>{ if(e.messageId!=='race-1'&&e.messageId!=='race-2') return; if(e.type==='done'){ outcomes[e.messageId]='done'; if(++count===2) settle(); } else if(e.type==='error'){ outcomes[e.messageId]='error'; if(++count===2) settle(); } });
            const r1p = o.chat.advance({ conversationId: convId, speakerId:'sc-bo', assistantMessageId:'race-1', options:{ maxTokens: 64 } });
            const r2p = o.chat.advance({ conversationId: convId, speakerId:'sc-ada', assistantMessageId:'race-2', options:{ maxTokens: 64 } });
            await Promise.all([r1p, r2p]);
            await Promise.race([both, new Promise((res)=>setTimeout(res, 60000))]);
            unsub2();
            const vals = Object.values(outcomes);
            return { beat1Len:b1.text.length, beat2Len:b2.text.length, beat3Len:b3.text.length, directorUsedModel:dd.usedModel, directorTokens:(dd.promptTokens||0)+(dd.completionTokens||0), directorFallback:dd.fallbackReason||null, raceOutcomes:outcomes, doneCount:vals.filter((x)=>x==='done').length, errCount:vals.filter((x)=>x==='error').length };
          })()`,
          true
        )) as {
          error?: string
          beat1Len?: number
          beat2Len?: number
          beat3Len?: number
          doneCount?: number
          errCount?: number
          directorUsedModel?: boolean
          directorTokens?: number
          directorFallback?: string | null
          raceOutcomes?: Record<string, string>
        }
        const beats = [sc.beat1Len ?? 0, sc.beat2Len ?? 0, sc.beat3Len ?? 0]
        const pass = !sc.error && beats.every((n) => n > 0) && sc.doneCount === 1 && sc.errCount === 1
        // Privacy: log only lengths + outcome labels, never the beat text.
        console.log(
          '[smoke] scene result:',
          JSON.stringify({ ok: pass, error: sc.error, beats, directorUsedModel: sc.directorUsedModel, directorTokens: sc.directorTokens, directorFallback: sc.directorFallback, raceDone: sc.doneCount, raceErr: sc.errCount, race: sc.raceOutcomes })
        )
        await shot('sibyl-smoke-scene.png')
        if (!pass) {
          console.error('[smoke] SCENE FAILED')
          setTimeout(() => app.exit(1), 300)
          return
        }
        console.log('[smoke] ✅ IN-APP SCENE PASSED (director + 3 beats + concurrency latch)')
        setTimeout(() => app.quit(), 400)
        return
      }

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
      // `did-finish-load` can precede the first compositor frame in a packaged
      // app; capturing immediately then fails with `UnknownVizError`.
      const delay = Number(process.env.SIBYL_SMOKE_DELAY || 500)
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

app.whenReady().then(async () => {
  const policy = rendererUrlPolicy()
  hardenSession()
  await initializePrivateVault()
  registerIpc(policy)
  initUpdater()
  createWindow(policy)

  // Check GitHub for a newer release shortly after launch (packaged builds only;
  // the Squirrel updater is inert when unpackaged). Squirrel auto-downloads if one
  // is found. Best-effort — failures surface as an `error` status in the Updates UI.
  if (app.isPackaged) {
    setTimeout(() => void checkForUpdates(), 4000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(policy)
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
// The Squirrel updater's install path (updater.ts) runs the *same*
// `teardownGpu()` before `quitAndInstall`, so this second pass is normally a
// no-op. Keeping the global quit guard ensures every other exit path is safe too.
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
