# Sibyl

A beautiful, secure **desktop app** (Windows & macOS) for downloading chat/text
models from **Hugging Face** and talking to them — entirely **on your own
machine**. No cloud, no telemetry, no data leaving your computer.

![Sibyl](docs/screenshot.png)

## Features

- 🔮 **Discover & download** GGUF chat models straight from Hugging Face, with a
  curated view of quantizations (size vs. quality) and resumable downloads.
- ⚡ **GPU-accelerated local inference** via [`node-llama-cpp`](https://node-llama-cpp.withcat.ai)
  (llama.cpp). Streams tokens in real time. NVIDIA **CUDA** (incl. **Blackwell /
  RTX 50-series**) on Windows, Apple **Metal** on Apple-Silicon Macs.
- 💬 **Polished chat** — markdown + code blocks with copy, multi-conversation
  history, per-message token/throughput stats, stop-generation, system prompts.
- 🎛️ **Full control** — temperature, top-p/k, min-p, repeat penalty, context
  window, GPU layers, and inference backend (Auto/CUDA/Vulkan/CPU on Windows;
  Auto/Metal/CPU on macOS).
- 🔒 **Secure by construction** — context isolation, no node integration in the
  renderer, a narrow typed preload bridge, strict CSP, navigation guards, and
  the optional Hugging Face token encrypted at rest via the OS keychain.

## Architecture

```
┌─────────────────────────────────────────────────── Electron main (Node) ───┐
│  index.ts       hardened window, CSP, nav guards, lifecycle                │
│  ipc.ts         typed IPC router                             ┐             │
│  engine.ts      node-llama-cpp: load, GPU, stream            │             │
│  downloads.ts   resumable HF GGUF downloader                 ├─ events     │
│  hf.ts          Hugging Face search + model detail           ├─ broadcast  │
│  store.ts       encrypted settings, models, conversations    │             │
│  llama.ts       lazy CUDA backend (local source build)       ┘             │
└──────────────────────────────────────┬─────────────────────────────────────┘
                                       │ contextBridge (preload/index.ts)
┌──────────────────────────────────────▼────── Renderer (React, isolated) ───┐
│  store.ts       external store (useSyncExternalStore)                      │
│  components/    Chat · Discover · Models · Settings                        │
│  lib/markdown   safe (no innerHTML) markdown → React elements              │
└────────────────────────────────────────────────────────────────────────────┘
```

Shared types and the IPC contract live in `src/shared`, imported by both sides so
the bridge can never drift.

## Requirements

- Windows 10/11 (x64) **or** macOS on Apple Silicon (arm64 — M1 or newer)
- Node.js 20+
- For **GPU acceleration**: nothing extra to install. node-llama-cpp ships
  prebuilt binaries — no CUDA Toolkit, Xcode, Visual Studio or CMake required.
  - **Windows**: an up-to-date NVIDIA driver (CUDA) or any Vulkan-capable GPU.
    The bundled CUDA backend runs on all modern NVIDIA GPUs including **Blackwell
    / RTX 50-series** (verified on an RTX 5090). Falls back to Vulkan, then CPU.
  - **macOS**: the GPU is used via **Metal** out of the box on Apple Silicon.
    Falls back to CPU. (Intel Macs aren't shipped — see the build notes below.)

## Getting started

```bash
npm install

# Run in development
npm run dev
```

### Verifying it works

```bash
npm test          # unit tests for the pure logic
npm run smoke     # downloads a tiny model + runs a real GPU generation
```

`npm run smoke` exercises the full pipeline outside Electron: it initializes the
CUDA backend, downloads `Qwen2.5-0.5B-Instruct` from Hugging Face, loads it on the
GPU and streams a response — printing the active backend and tokens/sec.

## Building an installer

```bash
# Windows: Squirrel.Windows installer + update package in release/<version>/squirrel/
npm run dist

# macOS: unsigned .dmg + .zip (Apple Silicon) in release/<version>/
npm run make-icon:mac   # one-time: (re)generate build/icon.icns
npm run dist:mac
```

`node-llama-cpp`'s native bindings and the compiled llama.cpp binaries are kept
outside the asar archive (see `electron-builder.yml`) so they load at runtime.

The Windows build uses **Squirrel.Windows** (side-by-side installs, applied on
restart — never overwriting the running binary). The macOS build is an **unsigned**
`.dmg`: without an Apple Developer ID we can't sign or notarize, so on first launch
macOS Gatekeeper will block it — **right-click → Open** (or
`xattr -dr com.apple.quarantine /Applications/Sibyl.app`) once to allow it.
Because Squirrel.Mac requires signing, the macOS build has **no in-app updater** —
update by re-downloading the `.dmg`. Windows updates automatically in-app.

### Cutting a release

Releases are cut **locally**, by hand — we don't run a self-hosted CI runner (that
would leave a GitHub-triggered build daemon on a machine holding your
credentials). [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs
typecheck/test/build on every push/PR via hosted Windows + macOS runners.

```bash
# Windows (on a CUDA-capable dev box):
npm run release         # verify + GPU smoke + build Squirrel artifacts + publish

# macOS (on an Apple-Silicon Mac):
npm run release:mac     # verify + build .dmg/.zip + publish (--dry-run to skip publish)
```

`scripts/release.ps1` (Windows) and `scripts/release-mac.mjs` (macOS) each refuse a
dirty tree, run the tests, build the platform artifacts, tag the commit
`v<version>`, and publish them to that GitHub release (needs an authenticated `gh`
CLI). The two can target the **same** `v<version>` tag — whichever runs second
uploads its assets onto the existing release.

## Security notes

- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`.
  Its only capability is the typed `window.sibyl` bridge — every call is an
  `ipcRenderer.invoke` to an allow-listed channel; raw `ipcRenderer`/`fs`/`net`
  are never exposed.
- A strict Content-Security-Policy is applied both via response headers (main)
  and a `<meta>` tag. `connect-src` is limited to Hugging Face over TLS.
- External links open in the system browser; in-app navigation is blocked.
- Conversations and models are stored under Electron's `userData`. The optional
  Hugging Face token is encrypted with `safeStorage` (OS keychain) and never
  written in plaintext.
- Sibyl sends **no telemetry**. Inference is fully local.

## License

MIT
