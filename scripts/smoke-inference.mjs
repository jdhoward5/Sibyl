// End-to-end smoke test for Sibyl's core pipeline, run OUTSIDE Electron:
//   1. Initialize the locally-built CUDA llama backend
//   2. Download a small GGUF chat model from Hugging Face (resumable)
//   3. Load it onto the GPU, open a chat session, stream a response
//
// This mirrors the logic in src/main/{llama,downloads,engine}.ts to validate
// the download + GPU inference path on this exact machine.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getLlama, createModelDownloader, LlamaChatSession } from 'node-llama-cpp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODELS_DIR = path.join(__dirname, '..', '.smoke-models')
const REPO = 'bartowski/Qwen2.5-0.5B-Instruct-GGUF'
const FILE = 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf'

function log(...a) {
  console.log('[smoke]', ...a)
}

async function main() {
  log('Initializing llama (prebuilt, auto GPU)…')
  const llama = await getLlama({ gpu: 'auto', build: 'never' })
  log('GPU backend:', llama.gpu)
  if (!llama.gpu) log('WARNING: no GPU backend detected — running on CPU')

  log(`Downloading ${REPO}/${FILE} …`)
  let lastPct = -1
  const downloader = await createModelDownloader({
    modelUri: `hf:${REPO}/${FILE}`,
    dirPath: MODELS_DIR,
    showCliProgress: false,
    onProgress: ({ totalSize, downloadedSize }) => {
      const pct = totalSize ? Math.floor((downloadedSize / totalSize) * 100) : 0
      if (pct !== lastPct && pct % 10 === 0) {
        log(`  download ${pct}%`)
        lastPct = pct
      }
    }
  })
  const modelPath = await downloader.download()
  log('Downloaded to:', modelPath)

  log('Loading model onto GPU…')
  const model = await llama.loadModel({ modelPath })
  log('trainContextSize:', model.trainContextSize)

  const context = await model.createContext({ contextSize: Math.min(4096, model.trainContextSize) })
  const session = new LlamaChatSession({ contextSequence: context.getSequence() })

  const prompt = 'In one short sentence, introduce yourself as Sibyl, a local AI assistant.'

  const start = Date.now()
  let tokenChunks = 0
  const response = await session.prompt(prompt, {
    temperature: 0.7,
    maxTokens: 120,
    onTextChunk: () => {
      tokenChunks++
    }
  })
  const seconds = (Date.now() - start) / 1000
  const tokenCount = model.tokenize(response).length

  log('--- RESULT ---')
  log('GPU:', llama.gpu)
  log('chunks streamed:', tokenChunks)
  log('completion tokens:', tokenCount)
  log('tokens/sec:', (tokenCount / seconds).toFixed(1))
  const vram = await llama.getVramState()
  log('VRAM used/total (GB):', (vram.used / 1e9).toFixed(1), '/', (vram.total / 1e9).toFixed(1))

  await context.dispose()
  await model.dispose()
  await llama.dispose()

  if (!response.trim()) throw new Error('Empty response from model')
  log('✅ SMOKE TEST PASSED')
}

main().catch((err) => {
  console.error('[smoke] ❌ FAILED:', err)
  process.exit(1)
})
