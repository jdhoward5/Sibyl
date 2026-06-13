# Oracle

A beautiful, secure **Windows desktop app** for downloading chat/text models from
**Hugging Face** and talking to them — entirely **on your own machine**. No cloud,
no telemetry, no data leaving your computer.

![Oracle](docs/screenshot.png)

## Features

- 🔮 **Discover & download** GGUF chat models straight from Hugging Face, with a
  curated view of quantizations (size vs. quality) and resumable downloads.
- ⚡ **GPU-accelerated local inference** via [`node-llama-cpp`](https://node-llama-cpp.withcat.ai)
  (llama.cpp). Streams tokens in real time. Built for NVIDIA CUDA, incl.
  **Blackwell / RTX 50-series**.
- 💬 **Polished chat** — markdown + code blocks with copy, multi-conversation
  history, per-message token/throughput stats, stop-generation, system prompts.
- 🎛️ **Full control** — temperature, top-p/k, min-p, repeat penalty, context
  window, GPU layers, and inference backend (Auto/CUDA/Vulkan/CPU).
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

- Windows 10/11 (x64)
- Node.js 20+
- For **GPU acceleration**: just an up-to-date NVIDIA driver (CUDA) or a
  Vulkan-capable GPU. node-llama-cpp ships prebuilt CUDA/Vulkan binaries — no
  CUDA Toolkit, Visual Studio or CMake required. The bundled CUDA backend runs
  on all modern NVIDIA GPUs including **Blackwell / RTX 50-series** (verified on
  an RTX 5090). Oracle falls back to Vulkan, then CPU, automatically.

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
npm run dist      # electron-builder → NSIS installer in release/
```

`node-llama-cpp`'s native bindings and the compiled llama.cpp binaries are kept
outside the asar archive (see `electron-builder.yml`) so they load at runtime.

### Cutting a release

Releases are cut **locally**, by hand, on a CUDA-capable dev box — we don't run a
self-hosted CI runner (that would leave a GitHub-triggered build daemon on a
machine holding your credentials). [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
still runs typecheck/test/build on every push/PR via a hosted runner.

```bash
npm run release   # verify + GPU smoke + build installer + publish GitHub pre-release
```

`scripts/release.ps1` refuses a dirty tree, runs the tests and a real-GPU smoke,
builds the NSIS installer, tags the commit `v<version>`, and publishes a GitHub
pre-release with the `.exe` attached (needs an authenticated `gh` CLI). Pass
`-DryRun` to build without publishing, or `-SkipSmoke` to skip the GPU gate.

## Security notes

- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`.
  Its only capability is the typed `window.oracle` bridge — every call is an
  `ipcRenderer.invoke` to an allow-listed channel; raw `ipcRenderer`/`fs`/`net`
  are never exposed.
- A strict Content-Security-Policy is applied both via response headers (main)
  and a `<meta>` tag. `connect-src` is limited to Hugging Face over TLS.
- External links open in the system browser; in-app navigation is blocked.
- Conversations and models are stored under Electron's `userData`. The optional
  Hugging Face token is encrypted with `safeStorage` (OS keychain) and never
  written in plaintext.
- Oracle sends **no telemetry**. Inference is fully local.

## License

MIT
