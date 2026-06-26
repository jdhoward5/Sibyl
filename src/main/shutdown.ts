import { engine } from './engine'
import { disposeLlama } from './llama'
import { tts } from './tts'

let teardown: Promise<void> | null = null

/**
 * Idempotent GPU teardown: stop any in-flight work, unload the model, and dispose
 * the native llama.cpp/CUDA backend. Disposing the CUDA backend out from under an
 * exiting process crashes Windows (0xC0000409), so every exit path funnels through
 * this exactly once.
 *
 * Returning the memoized promise lets callers race it safely: the `before-quit`
 * handler and the auto-updater's install path both await the *same* teardown, so
 * whichever runs second resolves immediately instead of disposing twice.
 */
export function teardownGpu(): Promise<void> {
  if (!teardown) {
    teardown = (async () => {
      try {
        await tts.dispose()
      } catch {
        /* ignore */
      }
      try {
        await engine.unload()
      } catch {
        /* ignore */
      }
      try {
        await disposeLlama()
      } catch {
        /* ignore */
      }
    })()
  }
  return teardown
}
