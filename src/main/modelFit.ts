import { stat } from 'node:fs/promises'
import type { GgufFileInfo, GgufInsights, Llama } from 'node-llama-cpp'
import type { AppSettings, InstalledModel } from '@shared/types'
import { estimateModelFit, type HardwareResources, type ModelFitEstimate } from '@shared/hardwareFit'
import { nlc } from './llama'

// Cache headers only, never loaded models or backend instances. Replacing a file
// invalidates its entry; keeping this bounded also limits tokenizer metadata.
const headers = new Map<string, { size: number; modified: number; info: GgufFileInfo }>()

async function readInsights(filePath: string, llama: Llama): Promise<GgufInsights> {
  const file = await stat(filePath)
  const { readGgufFileInfo, GgufInsights } = await nlc()
  let cached = headers.get(filePath)
  if (!cached || cached.size !== file.size || cached.modified !== file.mtimeMs) {
    const info = await readGgufFileInfo(filePath, {
      sourceType: 'filesystem',
      logWarnings: false,
      signal: AbortSignal.timeout(15_000)
    })
    cached = { size: file.size, modified: file.mtimeMs, info }
  }
  headers.delete(filePath)
  headers.set(filePath, cached)
  if (headers.size > 4) headers.delete(headers.keys().next().value!)
  return GgufInsights.from(cached.info, llama)
}

export async function modelFitContextSize(model: InstalledModel, requested: number, llama: Llama): Promise<number> {
  let trained = model.trainContextLength
  try {
    trained = (await readInsights(model.path, llama)).trainContextSize ?? trained
  } catch {
    // The loader remains responsible for reporting unreadable/invalid GGUFs.
  }
  return Math.max(512, Math.min(requested, trained != null && Number.isFinite(trained) && trained > 0 ? trained : requested))
}

export async function estimateInstalledModelFit(
  model: InstalledModel,
  settings: AppSettings,
  resources: HardwareResources,
  llama: Llama
): Promise<ModelFitEstimate> {
  const options = {
    model,
    contextSize: settings.load.contextSize,
    gpuLayers: settings.load.gpuLayers,
    gpuEnabled: settings.gpu !== 'cpu' && llama.gpu !== false && settings.load.gpuLayers !== 0,
    resources,
    // The engine releases its current model before loading a replacement.
    memoryMode: 'capacity' as const
  }
  try {
    const insights = await readInsights(model.path, llama)
    if (!Number.isInteger(insights.totalLayers) || insights.totalLayers < 1 || insights.totalLayers > 10_001) {
      throw new Error('Invalid layer count')
    }
    return estimateModelFit({
      ...options,
      model: { ...model, trainContextLength: insights.trainContextSize ?? model.trainContextLength },
      modelLayers: insights.totalLayers,
      estimateResources: (gpuLayers, contextSize) => {
        const weights = insights.estimateModelResourceRequirements({ gpuLayers })
        const context = insights.estimateContextResourceRequirements({
          contextSize,
          modelGpuLayers: gpuLayers,
          sequences: 1,
          flashAttention: true
        })
        const memory = {
          ramBytes: weights.cpuRam + context.cpuRam,
          vramBytes: weights.gpuVram + context.gpuVram,
          contextBytes: context.cpuRam + context.gpuVram
        }
        if (Object.values(memory).some((bytes) => !Number.isFinite(bytes) || bytes < 0)) {
          throw new Error('Invalid memory estimate')
        }
        return memory
      }
    })
  } catch {
    const fit = estimateModelFit(options)
    fit.details.splice(-1, 0, 'GGUF memory metadata could not be read; using the less precise parameter-count estimate.')
    return fit
  }
}
