# Sibyl — project notes for Claude

Desktop (Electron) app to download Hugging Face GGUF chat models and run them
locally via `node-llama-cpp`. Stack: electron-vite + React + TS + Tailwind.

## Layout
- `src/shared/` — types + IPC contract + pure helpers. **No node/electron imports**
  (loaded by the renderer). Unit-tested (`format.test.ts`, `tts.test.ts`,
  `scene.test.ts`). `tts.ts` = TTS types + Piper voice catalog + pure phoneme→id /
  markdown→speech. `scene.ts` = self-roleplay scene helpers (round-robin speaker
  pick + group-chat beat-prompt assembly).
- `src/main/` — Electron main. `engine.ts` (inference), `tts.ts` (Piper speech),
  `downloads.ts`, `hf.ts`, `store.ts` (persistence), `llama.ts` (backend),
  `ipc.ts` (router), `index.ts`.
- `src/preload/index.ts` — the only renderer capability: `window.sibyl` bridge.
- `src/renderer/src/` — React UI. State in `store.ts` (custom external store,
  `useSyncExternalStore`), components by feature, `lib/markdown.tsx` (safe),
  `lib/ttsPlayer.ts` (Web Audio playback queue for streamed speech).

## Conventions / invariants
- IPC handlers return `Result<T>` (`{ ok, data?, error? }`); they never throw
  across the boundary. Add channels in `src/shared/ipc.ts` (both sides import it).
- The engine keeps **one** loaded model and **one** persistent context sequence +
  `LlamaChatSession`. Switch conversations with `setChatHistory`, never by calling
  `context.getSequence()` again (the pool is tiny).
- Always dispose the GPU (engine.unload → disposeLlama) before the process exits,
  or Windows crashes with `0xC0000409`.
- Renderer must stay isolated: no new `ipcRenderer`/node surface; extend the
  typed bridge instead. Keep the CSP tight.
- **Privacy: never log message/conversation content.** Conversation text, persona
  briefs/greetings, the resolved system prompt and the user's character are
  private, on-device data. They may only reach two sinks: the local
  conversations store (`userData/conversations`) and a user-initiated export.
  They must **never** be written to stdout/stderr, a hidden log file, or any
  remote service. Don't pass a message's `content`, a persona `brief`/`greeting`,
  `systemPrompt`/`userText`, or `userCharacter` to `console.*` — log a length or a
  boolean instead. The renderer holds all of this in memory, so it must contain
  **no** `console.*` at all (renderer console is forwarded to main stdout in dev).
  `src/privacy.test.ts` enforces both rules statically; the renderer→main console
  forwarder is dev-only (`isDev`). The app sends no telemetry and starts no crash
  reporter.
  - **TTS is in-scope of this rule.** The text handed to `tts.speak` (the message
    `content`) and the synthesized audio are private. Synthesis runs on-device and
    the audio only ever flows main→renderer for local playback — never log the
    spoken text, the PCM, or anything derived from it.

## Self-roleplay scenes (AI converses with itself)
- A **scene** is a `Conversation` with a `cast: string[]` of **≥2** persona ids
  (`isScene` = cast length ≥ `MIN_SCENE_CAST`). The cast characters roleplay with
  each other; the human can **watch** (autoplay), **participate** (speak as their
  own `userCharacter`), or **direct** (out-of-character notes that steer the next
  beats). An ordinary single-persona thread is just a scene with no cast.
- **Messages carry their own attribution.** A scene beat is `role:'assistant'`
  with `speakerId`/`speakerName` (the AI character who spoke it). The human's lines
  are plain `role:'user'`; director notes are `role:'user'` + `director:true`
  (rendered as a stage direction, fed to characters as guidance — **not** as
  `role:'system'`, which would collide with `systemPromptFor`'s legacy-system-message
  lookup).
- **One beat at a time, group-chat prompting.** The active speaker (and thus the
  system prompt) changes every beat, so `engine.generateBeat()` always *rebuilds*
  the session from the transcript via the pure `buildBeatPrompt` (`scene.ts`) — it
  does **not** reuse the warm session like `generate()`. From the speaker's POV:
  their own prior beats → unprefixed `model` turns; everyone else's lines + director
  notes → name-prefixed `user` turns, with consecutive "other" lines **coalesced**
  into one user turn (the chat template never sees two user turns in a row). The
  trailing run becomes the prompt; other characters' names are `customStopTriggers`
  so a beat can't run on into someone else's turn. Honors compaction (live tail +
  summary in the system turn) like the normal path. Streams over the **same**
  `chat:event` channel; IPC entry point is `chat:advance` (`ChatAdvanceRequest`).
- **The renderer owns turn-taking + autoplay**, not main. `store.ts`: `newScene`,
  `advanceScene(speakerId?)` (round-robin via `nextSpeakerId`, or click a cast chip
  to override), `sceneSpeak`/`sceneDirect`, and a single self-rescheduling timer
  (`startScenePlay`/`tickScenePlay`/`scheduleNextBeat`) that advances beat-after-beat,
  pausing while a beat is **narrated** (autoSpeak) so speech never queues up. Autoplay
  is pinned to one `scenePlay.convId` and stops on switch-away/abort/error. UI:
  `SceneStrip` (cast chips + play/pause/step) in `ChatView`, the Composer's
  speak/direct toggle, scene multi-select in `PersonaPicker`.

## Text-to-speech (Piper, on-device)
- Speaks AI replies with **local neural voices** (Piper / VITS). A voice is an
  ONNX model + a tiny `.onnx.json` config downloaded from Hugging Face's
  `rhasspy/piper-voices` repo into `userData/tts/voices` (registry: `voices.json`).
  A curated catalog lives in `src/shared/tts.ts` (`TTS_VOICE_CATALOG`).
- **Pipeline** (`src/main/tts.ts`): text → `plainTextForSpeech` (strip markdown) →
  `phonemize` (the `phonemizer` package = espeak-ng WASM → IPA, per sentence) →
  `phonemesToIds` (Piper convention: BOS, PAD-interleaved, EOS) → **onnxruntime-node**
  (`input`/`input_lengths`/`scales` [+`sid` if multi-speaker] → `output`) → mono
  Float32 PCM. Synthesized **sentence-by-sentence** and streamed to the renderer as
  `tts:event` chunks; `lib/ttsPlayer.ts` decodes each into an AudioBuffer and
  schedules them gaplessly. The player (not main) is the source of truth for what's
  *audibly* speaking — synthesis finishes before playback does.
- `length_scale = config.length_scale / rate`; each voice carries its own
  `sample_rate` (16 k or 22.05 k) — the renderer builds the AudioBuffer at that rate
  and Web Audio resamples. One ONNX session is cached + reused; speak requests are
  **serialized** through a promise chain so the model is never run (or a session
  disposed) by two requests at once. `tts.dispose()` runs first in `teardownGpu()`.
- **Native dep**: `onnxruntime-node` (lazy `import()`, externalized like
  node-llama-cpp; graceful `available:false` if it can't load). `phonemizer` is
  pure JS with the espeak-ng WASM embedded as base64 (no asset to unpack). Probe
  availability via `tts.status()`; the renderer hides speech controls when
  unavailable. **Cross-platform** (Windows + macOS), CPU execution provider.
- **Packaging**: `electron-builder.yml` `asarUnpack`s `onnxruntime-node` (native
  `.node` + `libonnxruntime`) and trims its bundled binaries for platforms this
  build can't load (Linux + win-arm64 always; darwin on the Windows build, win32 on
  the mac build) — the package ships all platforms in one (~260 MB).

## CUDA / GPU
- The prebuilt CUDA backend (`@node-llama-cpp/win-x64-cuda`, llama.cpp **b8390**)
  runs on all modern NVIDIA GPUs **including Blackwell / RTX 50-series** (verified
  on an RTX 5090). `llama.ts` always passes `build: 'never'` so nothing compiles
  at runtime, and degrades requested → auto → CPU.
- **Custom from-source build (gemma4 + newer archs).** The prebuilt b8390 predates
  several model architectures (e.g. `gemma4`, added to llama.cpp ~Apr 2026) and
  fails to load them with `unknown model architecture`. We ship a from-source
  **llama.cpp b9616 CUDA** build under `llama/localBuilds/win-x64-cuda-release-b9616`
  that adds them. `llama.ts` prefers it for cuda/auto via `getLlama('lastBuild')`
  (see below); it falls back to the prebuilt for cpu/vulkan or if the build is
  absent. Build it with `npm run rebuild:llama` (needs the CUDA Toolkit + VS Build
  Tools — see "Rebuilding the llama backend").
- **`getLlama('lastBuild')`, not option-based resolution.** Inside a packaged
  (asar) app, node-llama-cpp's option-based local-build lookup computes a
  build-folder name that doesn't match on disk, so it silently falls back to the
  prebuilt (→ `unknown model architecture`). `lastBuild` reads the exact folder
  name from `llama/lastBuild.json` and resolves correctly. Both are shipped.
- **`UV_THREADPOOL_SIZE=1` (set in `index.ts`).** b9616's CUDA backend aborts with
  `CUDA error: invalid resource handle` if a context's CUDA streams are created on
  one libuv worker thread and freed on another (node-llama-cpp's load/unload are
  separate async workers). Pinning the pool to one worker keeps create+free on the
  same thread. Must stay set before libuv inits its pool. The engine also enables
  `flashAttention` (gemma4 has per-layer KV; avoids a padded-V CUDA path).
- Packaging (`electron-builder.yml`) drops `win-x64-cuda-ext` (~440 MB, very-old
  archs), `win-arm64`, and the top-level `node-llama-cpp/llama/llama.cpp` **source**
  checkout (~153 MB — runtime needs only the compiled output; its deep `tools/ui`
  paths also overflow NuGet's MAX_PATH). **Ships** the custom build's runtime output
  only (`localBuilds/*/Release` + `buildDone.status`), dropping its ~400 MB
  from-source tree (CMake/MSBuild scratch, the duplicate `bin/`). Kept prebuilts:
  `win-x64-cuda` + `win-x64` (CPU) + `win-x64-vulkan`.

## Packaging & auto-update (Squirrel.Windows)
- We **do not** use NSIS or electron-updater (NSIS overwrites the running app in
  place → deadlocks on our GPU/CUDA file handles, the "Sibyl cannot be closed"
  bug). Instead: **Squirrel.Windows** (the Slack/Discord model) installs each
  version side-by-side and applies on restart — never overwriting the running
  binary, so updates never lock or need to kill the app.
- Build: `npm run dist` = `electron-builder --win --dir` (packaging/trimming only)
  → `scripts/squirrel.mjs` (electron-winstaller) wraps `release/<v>/win-unpacked`
  into `release/<v>/squirrel/`: `SibylSetup.exe` + `Sibyl-<v>-full.nupkg` +
  `RELEASES`. squirrel.mjs copies the repo `LICENSE` into the dir (nuspec needs it)
  and pins a short `%TEMP%` (`C:\sqtmp`) to stay under MAX_PATH.
- Updater: `src/main/updater.ts` uses Electron's **native `autoUpdater`** (which is
  Squirrel) with `setFeedURL` → `github.com/jdhoward5/Sibyl/releases/latest/download`
  (the public releases serve as the feed — no server). Squirrel auto-downloads on
  `checkForUpdates()`; there's no manual download/progress. `electron-squirrel-startup`
  (top of `index.ts`) handles the install/uninstall shortcut events.
- The app is **unsigned** (so the SmartScreen "unknown publisher" warning stays;
  `update.electronjs.org` — which needs signing — is therefore not used). Releases
  must publish `--latest` (the feed resolves to GitHub's "Latest" release).
- Installs per-user to `%LOCALAPPDATA%\Sibyl` (silent, no folder picker). userData
  stays at `%APPDATA%\sibyl` (`app.getName()` = `Sibyl`), so models/conversations
  carry across updates.
- NOTE: in a sandboxed *node* CLI the binding self-test can fail (child-process
  restriction) and fall back to CPU; it works fine in real Electron. Verify GPU via
  the packaged app, not a bare `node` invocation.

## macOS build (Metal, unsigned, arm64)
- The app is **cross-platform**; platform-specific code branches on
  `process.platform` (`'win32'` vs `'darwin'`). Things gated to Windows: the
  `UV_THREADPOOL_SIZE=1` libuv pin and `titleBarOverlay` (`index.ts`), and the
  Squirrel `autoUpdater` (`updater.ts`). macOS gets: the custom **Metal** backend,
  native traffic lights (`trafficLightPosition`, the renderer `TitleBar` pads the
  **left**), and an `'unsupported'` update state. The renderer reads
  `appInfo.platform` to pick GPU options (Auto/Metal/CPU) and the updates UI.
- Backend: like Windows (CUDA), macOS ships a **custom from-source llama.cpp
  b9616 Metal build** under `llama/localBuilds/mac-arm64-metal-release-b9616`,
  which adds newer architectures (e.g. **gemma4**) the prebuilt b8390 lacks.
  `llama.ts` prefers it via `getLlama('lastBuild')` for metal/auto (the
  `preferLocalBuild` branch now covers `win32`+cuda **and** `darwin`+metal); it
  falls back to the prebuilt **`@node-llama-cpp/mac-arm64-metal`** (Metal) / CPU
  if the local build is absent. Build it with `npm run rebuild:llama:mac` (see
  "Rebuilding the llama backend"). The same C++17/`llama-common`/
  `common_cpu_get_num_math` patch the CUDA build needs applies to Metal.
- Build: `npm run make-icon:mac` (one-time — generates `build/icon.icns` from the
  brand mark via an offscreen Electron render); `npm run rebuild:llama:mac` (the
  custom b9616 Metal build — **not** in git, regenerate after `npm install`); then
  `npm run dist:mac` = `electron-vite build && electron-builder --mac --arm64`.
  Output: `release/<v>/Sibyl-<v>-arm64.dmg` + `.zip` (Apple Silicon only). Packaging
  ships only the build's `Release/` output (the `.node` + colocated `.dylib`s incl.
  `lib{ggml,llama}.metal.b9616.dylib`) + `buildDone.status`, dropping the ~hundreds
  of MB from-source tree — same `localBuilds/*` trims as Windows.
- **Unsigned** (`mac.identity: null`), matching the unsigned Windows build. No
  Apple Developer ID → no signing/notarization → Gatekeeper quarantines the
  download: first launch needs **right-click → Open** (or
  `xattr -dr com.apple.quarantine /Applications/Sibyl.app`). Because Squirrel.Mac
  requires signing, there is **no in-app updater** on mac (`updater.ts` reports
  `'unsupported'`); users re-download the `.dmg`. Installs to `/Applications`;
  userData stays at `~/Library/Application Support/Sibyl`.
- Release: `npm run release:mac` (`scripts/release-mac.mjs`) — verify + build +
  publish the dmg/zip to the `v<version>` GitHub release (`--dry-run` to skip
  publish). Can share the same tag as a Windows release (uploads onto it).
- The Windows-specific trimming in `electron-builder.yml` (`win-x64-cuda-ext`,
  vcxproj/.lib/.exp) is a no-op on mac, and the mac-specific trims (Makefile,
  compile_commands.json) are a no-op on Windows, so the `files` filters are shared.

## Rebuilding the llama backend (custom b9616)
- The compiled build under `localBuilds/` is **not** in git; only the source
  patches are (`patches/node-llama-cpp+3.18.1.patch`, applied by the `postinstall`
  hook). After `npm install`, regenerate the binaries: `npm run rebuild:llama`
  (Windows, CUDA) or `npm run rebuild:llama:mac` (macOS, Metal). Both run
  `patch-package` then `node-llama-cpp source download --release b9616 --gpu
  {cuda,metal}`; the `--gpu metal` run rewrites `lastBuild.json` to
  `mac-arm64-metal-release-b9616`.
- Prereqs (Windows): **CUDA Toolkit** (13.x ok) + **VS Build Tools 2022** + CMake.
  If cmake errors `No CUDA toolset found`, copy CUDA's MSBuild integration into VS:
  `CUDA\vX.Y\extras\visual_studio_integration\MSBuildExtensions\*` →
  `…\BuildTools\MSBuild\Microsoft\VC\v170\BuildCustomizations\` (needs admin).
- Prereqs (macOS): **Xcode Command Line Tools** only (`xcode-select --install`) —
  clang + the Metal SDK. CMake/ninja are **not** needed system-wide; node-llama-cpp
  downloads its own (xpack) cmake during the build, and uses the Unix Makefiles
  generator. The Metal shaders compile into `libggml.metal.b9616.dylib`. Verified
  on Apple Silicon (M-series).
- The patch carries three source fixes the addon needs against b9616 (both GPUs):
  addon C++ standard → C++17, link `llama-common` (renamed from `common`), and
  `cpu_get_num_math` → `common_cpu_get_num_math`. To target a newer llama.cpp tag,
  bump the release in `rebuild:llama`/`rebuild:llama:mac` + `llama.cpp.info.json` +
  the `localBuilds` folder name in `lastBuild.json`, and expect to re-derive these.

## Verify
- `npm run typecheck && npm test && npm run build`
- `npm run smoke` — real download + GPU generation (outside Electron).
- Headless in-app E2E: build, then run electron with `SIBYL_SMOKE=1` and
  `SIBYL_SMOKE_MODEL=<path to a .gguf>` (drives load + 2 conversations through
  the real IPC stack, screenshots to `SIBYL_SMOKE_OUT`). Add `SIBYL_SMOKE_SCENE=1`
  to instead drive a **self-roleplay scene**: 3 round-robin beats via
  `engine.generateBeat`, then two simultaneous `chat.advance` calls to assert the
  engine serializes them (one beat done, one rejected — no concurrent-prompt crash).
  Pass `--user-data-dir=<tmp>` to keep it off your real personas/conversations.

## npm audit / security
- **Never run `npm audit fix --force`** here — it blindly bumps Electron/Vite/
  electron-vite across breaking majors and still doesn't resolve the findings.
- The shipping tree is what matters: `npm audit --omit=dev` must be **0**.
- Residual `npm audit` (full) findings are all **dev/build-time only** (vite,
  electron-vite, @vitejs/plugin-react, esbuild) and don't ship. The root is
  **esbuild**, whose advisory range currently covers every released version, so
  there is *no* version to upgrade to — it can't be driven to 0 without removing
  the Vite toolchain. They're also not triggered by our usage (`vitest run`, not
  `--ui`; no exposed dev server). Leave them; re-check when esbuild ships a fix.
- Keep **Electron on a supported major** (latest 3) — that's the only finding
  that affects the shipped runtime. After an in-place Electron major bump, if
  dev fails with "Electron uninstall", run `node node_modules/electron/install.js`
  to fetch the binary.
