# Sibyl — project notes for Codex

Desktop (Electron) app to download Hugging Face GGUF chat models and run them
locally via `node-llama-cpp`. Stack: electron-vite + React + TS + Tailwind.

## Layout
- `src/shared/` — types + IPC contract + pure helpers. **No node/electron imports**
  (loaded by the renderer). Unit-tested (`format.test.ts`, `tts.test.ts`,
  `scene.test.ts`). `tts.ts` = TTS types + Piper voice catalog + pure phoneme→id /
  markdown→speech. `scene.ts` = self-roleplay scene helpers (round-robin speaker
  pick + group-chat beat-prompt assembly).
- `src/main/` — Electron main. `engine.ts` (inference), `tts.ts` (Piper speech),
  `downloads.ts`, `hf.ts`, `store.ts` (persistence), `vault.ts`/`vaultStore.ts`
  (encrypted private persistence), `portable.ts`, `llama.ts` (backend),
  `ipc.ts` (router), `index.ts` (entry dispatcher), and `appMain.ts` (normal app).
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
  private, on-device data. Their durable sinks are authenticated ciphertext
  records in the local vault, encrypted backups, and encrypted user-initiated
  `.sibyl` bundles. They must **never** be written to stdout/stderr, plaintext
  files, a hidden log file, or any remote service. Don't pass a message's
  `content`, a persona `brief`/`greeting`, `systemPrompt`/`userText`, or
  `userCharacter` to `console.*` — log only non-semantic operational outcomes.
  The renderer holds private data in memory, so it must contain **no** `console.*`
  at all (renderer console is forwarded to main stdout in dev).
  `src/privacy.test.ts` enforces these rules statically; the renderer→main console
  forwarder is dev-only (`isDev`). The app sends no telemetry and starts no crash
  reporter.
  - **TTS is in-scope of this rule.** The text handed to `tts.speak` (the message
    `content`) and the synthesized audio are private. Synthesis runs on-device and
    the audio only ever flows main→renderer for local playback — never log the
    spoken text, the PCM, or anything derived from it.

## Encrypted private-data vault and passkeys
- Fresh installs persist private settings, personas, conversations, semantic
  metadata, memories, and backups only as AES-256-GCM ciphertext under
  `userData/vault`. Opaque record IDs and coarse padding avoid plaintext names,
  ordering, and exact sizes. `docs/VAULT_FORMAT.md` is the format/threat-model
  authority.
- Every vault has an Argon2id recovery-passphrase slot. The optional device slot
  wraps the same random master key with Electron `safeStorage` (DPAPI on Windows,
  Keychain on macOS); it is seamless on the same OS user/device but is not
  claimed to be guaranteed TPM/Secure-Enclave storage. “Require unlock when
  Sibyl opens” bypasses automatic device unlock. Locking stops inference/TTS,
  wipes key buffers/caches where the runtime permits, and recreates the private
  renderer document.
- Optional passkey unlock uses WebAuthn PRF, not a signature-only WebAuthn
  credential. The main process launches a dedicated helper entry that owns a
  hidden sandboxed window in a nonpersistent session and intercepts only
  `https://vault.sibyl.invalid/`; no network listener or relaxed main-renderer
  navigation is involved. Enrollment is hidden unless a real user-verifying
  platform authenticator returns stable 32-byte PRF output. Recovery passphrase
  remains mandatory.
- Never put keys, passphrases, PRF output, private records, or portable-bundle
  plaintext in renderer-visible settings, command-line arguments, environment
  variables, temp files, or logs. Passkey helper transport uses a dedicated,
  bounded in-memory Node IPC channel; stdout is never used for key material.
  `npm run test:passkey` uses a CDP virtual
  authenticator to exercise exact credential creation and assertion.
- Legacy migration validates and encrypts alongside the old store, reads every
  encrypted record back, then removes plaintext only after the store-version
  switch is durable. Secure erasure from SSD history/snapshots cannot be
  guaranteed.

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
- **The renderer owns turn-taking + autoplay**, not main. Runs default to six
  beats and are bounded by beat, elapsed-time, and token budgets. Advancement
  pauses during narration, stops after consecutive empty/failed/near-duplicate
  beats, and exposes retry/continue-without-speech on narration failure. The
  optional hybrid local director can choose a cast speaker or pause/end, with
  deterministic round-robin fallback on invalid output. Autoplay is pinned to
  one conversation and stops on switch-away/abort/error. UI:
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
- Packaging always starts from `scripts/package-runtime.mjs`, which generates a
  temporary production-only staging root containing `out`, a minimal manifest,
  production dependencies, licenses/icons, the embedded release-manifest public
  key, and only the native runtimes needed by the target. `electron-builder`
  packages that root, and `scripts/inspect-package.mjs` rejects source, tests,
  maps, scripts, patches, docs, dot-directories, credentials, old releases,
  smoke models, and missing/oversized native output.
- Build: `npm run dist` stages/packages Windows, then `scripts/squirrel.mjs`
  wraps `release/<v>/win-unpacked` into `release/<v>/squirrel/`:
  `SibylSetup.exe` + `Sibyl-<v>-full.nupkg` + `RELEASES`. The Squirrel stage and
  clean release worktree use short paths under `C:\sqtmp` for NuGet MAX_PATH.
- Updater: before giving a feed to Electron's native Squirrel `autoUpdater`,
  `src/main/updater.ts` downloads the release manifest, its detached Ed25519
  signature, and `RELEASES`; it verifies the embedded public key, manifest
  platform/version, and the exact feed SHA-256. Failure is closed and visible.
  The public GitHub latest-release assets remain the feed—there is no server.
  Squirrel auto-downloads after verification. `electron-squirrel-startup`
  (normal `appMain.ts` path) handles install/uninstall shortcut events.
- The app is **unsigned** (so the SmartScreen "unknown publisher" warning stays;
  `update.electronjs.org` — which needs signing — is therefore not used). Releases
  must publish `--latest` (the feed resolves to GitHub's "Latest" release).
- `npm run release` builds from a disposable detached worktree after `npm ci`;
  validates the clean commit, exact dependency/lockfile versions, applied
  patches, b9616 metadata and native hashes, and local/remote tag state; runs all
  static/unit/Electron/passkey/smoke gates; packages and smokes the actual app;
  then emits a signed release manifest, SHA256SUMS, CycloneDX SBOM, and package
  inventory. Publishing compares existing same-name assets by SHA-256, skips
  exact matches, and aborts on collisions. See `docs/RELEASE_PROVENANCE.md`.
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
  `npm run dist:mac` stages a production-only runtime and invokes
  `electron-builder --mac --arm64`.
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
- Release: `npm run release:mac` uses the same clean/preflight/test/manifest
  pipeline, publishes the dmg/zip plus provenance assets, and can safely add the
  second platform to an existing tag because equal names must hash-match and
  conflicting assets are never overwritten (`--dry-run` skips publishing).
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
- `npm run lint && npm run typecheck && npm test && npm run audit:production &&
  npm run build`
- `npm run test:e2e` — real Electron renderer/preload/main flows, including vault
  setup/lock/recovery, encrypted portability, private-file checks, scene
  controls, and automated accessibility checks.
- `npm run test:passkey` — isolated HTTPS WebAuthn PRF create/assert with a
  virtual authenticator.
- `npm run smoke` — real download + GPU generation (outside Electron).
- Headless in-app E2E: build, then run electron with `SIBYL_SMOKE=1` and
  `SIBYL_SMOKE_MODEL=<path to a .gguf>` (drives load + 2 conversations through
  the real IPC stack, screenshots to `SIBYL_SMOKE_OUT`). Add `SIBYL_SMOKE_SCENE=1`
  to instead drive a **self-roleplay scene**: 3 round-robin beats via
  `engine.generateBeat`, then two simultaneous `chat.advance` calls to assert the
  engine serializes them (one beat done, one rejected — no concurrent-prompt crash).
  Pass `--user-data-dir=<tmp>` to keep it off your real personas/conversations.

## Packaging size (don't ship build junk)
- Never bypass `scripts/package-runtime.mjs` for a distributable artifact. The
  staging directory—not the repository—is the electron-builder app root, which
  makes the runtime contents an allowlist rather than a fragile exclusion list.
- `scripts/inspect-package.mjs` is mandatory and asserts both forbidden entries
  and expected size bands. A current healthy Windows build has about 9.3 MB in
  `app.asar` and about 770 MB of unpacked app/runtime files; investigate material
  drift instead of simply widening the bounds.
- Custom llama builds are imported through `SIBYL_NATIVE_SOURCE_ROOT` during
  clean builds because compiled `localBuilds` output is intentionally not in
  git. The preflight and final manifest both hash it, and the package inventory
  proves the staged native files match.

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
