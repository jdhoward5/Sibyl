// Lazy, cached access to the heavy node-llama-cpp native module.
// Importing it eagerly would block app startup while the native binding loads,
// so everything here is deferred until the first model action.

import type * as NLC from 'node-llama-cpp'
import type { AppSettings } from '@shared/types'

type NLCModule = typeof import('node-llama-cpp')

let modPromise: Promise<NLCModule> | null = null

export function nlc(): Promise<NLCModule> {
  if (!modPromise) {
    modPromise = import('node-llama-cpp')
  }
  return modPromise
}

let llamaPromise: Promise<NLC.Llama> | null = null
let llamaGpu: AppSettings['gpu'] | null = null

/**
 * Build the prioritized list of strategies for obtaining a Llama instance.
 *
 * We ship node-llama-cpp's prebuilt binaries: on Windows CUDA (which supports
 * modern NVIDIA GPUs incl. Blackwell/RTX 50-series) + Vulkan + CPU; on macOS
 * Metal (Apple Silicon GPU) + CPU. Every strategy uses `build: 'never'` so the
 * app never tries to invoke a C++ compiler at runtime (which would fail inside a
 * packaged app). We degrade gracefully: requested backend → auto-detect → CPU.
 */
async function createLlama(gpu: AppSettings['gpu']): Promise<NLC.Llama> {
  const { getLlama } = await nlc()
  const requested = gpu === 'cpu' ? false : gpu === 'auto' ? 'auto' : gpu

  const attempts: Array<() => Promise<NLC.Llama>> = []

  // Prefer our bundled from-source build (llama.cpp b9616) — CUDA on Windows,
  // Metal on macOS — which adds support for newer architectures (e.g. gemma4)
  // that the prebuilt binaries (b8390) lack. It's recorded as the "last build".
  // node-llama-cpp's option-based resolution fails to locate a local build inside
  // a packaged (asar) app — the computed build-folder name doesn't match — so we
  // resolve it explicitly via "lastBuild", which reads the folder name from
  // lastBuild.json. Only when the user wants GPU/auto; `usePrebuiltBinaries`
  // keeps the normal fallback if no local build is present (a prebuilt-only
  // install, or a platform/backend we don't ship a localBuild for).
  const preferLocalBuild =
    (process.platform === 'win32' && (gpu === 'auto' || gpu === 'cuda')) ||
    (process.platform === 'darwin' && (gpu === 'auto' || gpu === 'metal'))
  if (preferLocalBuild) {
    attempts.push(() =>
      getLlama('lastBuild', {
        usePrebuiltBinaries: true,
        logLevel: 'warn' as NLC.LlamaLogLevel
      })
    )
  }

  attempts.push(
    () =>
      getLlama({
        gpu: requested as NLC.LlamaOptions['gpu'],
        build: 'never',
        logLevel: 'warn' as NLC.LlamaLogLevel
      }),
    // Auto-detect any available accelerator if the requested one is unavailable.
    () => getLlama({ gpu: 'auto', build: 'never', logLevel: 'warn' as NLC.LlamaLogLevel }),
    // Final fallback: CPU, which always has a usable binary.
    () => getLlama({ gpu: false, build: 'never', logLevel: 'warn' as NLC.LlamaLogLevel })
  )

  let lastErr: unknown
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Failed to initialize llama backend')
}

/**
 * Get the shared Llama instance, creating it with the configured GPU backend.
 * If the backend changes we tear down and recreate.
 */
export async function getLlamaInstance(gpu: AppSettings['gpu']): Promise<NLC.Llama> {
  if (llamaPromise && llamaGpu === gpu) return llamaPromise
  if (llamaPromise) {
    try {
      const prev = await llamaPromise
      await prev.dispose()
    } catch {
      /* ignore */
    }
    llamaPromise = null
  }
  llamaGpu = gpu
  llamaPromise = createLlama(gpu)
  return llamaPromise
}

export async function disposeLlama(): Promise<void> {
  if (llamaPromise) {
    try {
      const inst = await llamaPromise
      await inst.dispose()
    } catch {
      /* ignore */
    }
    llamaPromise = null
    llamaGpu = null
  }
}
