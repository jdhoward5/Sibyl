import type { InstalledModel } from './types'
import { parseParamLabel } from './format'

const GIB = 1024 ** 3

export interface HardwareResources {
  systemMemoryTotalBytes: number
  systemMemoryFreeBytes: number
  vramTotalBytes: number | null
  vramUsedBytes: number | null
  unifiedMemory?: boolean
}

export interface ModelFitEstimate {
  severity: 'comfortable' | 'tight' | 'infeasible' | 'unknown'
  estimatedRamBytes: number
  estimatedVramBytes: number
  estimatedKvBytes: { low: number; high: number }
  availableRamBytes: number
  availableVramBytes: number | null
  offloadFraction: number
  summary: string
  details: string[]
}

function parameterBillions(label: string | undefined): number | null {
  if (!label) return null
  const match = label.match(/(\d+(?:\.\d+)?)\s*B/i)
  if (match) return Number(match[1])
  const millions = label.match(/(\d+(?:\.\d+)?)\s*M/i)
  return millions ? Number(millions[1]) / 1000 : null
}

function architectureEstimate(parametersB: number): { layers: number; embedding: number } {
  if (parametersB <= 1.5) return { layers: 24, embedding: 2_048 }
  if (parametersB <= 4) return { layers: 32, embedding: 3_072 }
  if (parametersB <= 9) return { layers: 32, embedding: 4_096 }
  if (parametersB <= 16) return { layers: 40, embedding: 5_120 }
  if (parametersB <= 40) return { layers: 64, embedding: 6_656 }
  if (parametersB <= 80) return { layers: 80, embedding: 8_192 }
  return { layers: 96, embedding: 10_240 }
}

function ratio(required: number, available: number | null): number | null {
  return available == null ? null : available > 0 ? required / available : required > 0 ? Infinity : 0
}

export function estimateModelFit(params: {
  model: Pick<InstalledModel, 'sizeBytes' | 'paramLabel'>
  contextSize: number
  gpuLayers: number
  gpuEnabled: boolean
  resources: HardwareResources
  /** Browsing plans against capacity with headroom, independent of a loaded model. */
  memoryMode?: 'available' | 'capacity'
}): ModelFitEstimate {
  const { model, resources } = params
  const parametersB = parameterBillions(model.paramLabel)
  const architecture = parametersB ? architectureEstimate(parametersB) : null
  const contextSize = Math.max(512, Math.floor(params.contextSize))

  // GGUF weights are close to their mapped runtime size. The extra 8% covers
  // tensors and allocator alignment while avoiding false precision.
  const runtimeWeights = model.sizeBytes * 1.08
  const kvLow = architecture
    ? contextSize * architecture.layers * architecture.embedding * 2 * 2 * 0.125
    : contextSize * 64 * 4_096 * 2 * 2 * 0.125
  const kvHigh = kvLow * 4
  const offloadFraction = !params.gpuEnabled
    ? 0
    : params.gpuLayers < 0
      ? 1
      : architecture
        ? Math.min(1, params.gpuLayers / architecture.layers)
        : Math.min(1, params.gpuLayers / 64)
  const estimatedVramBytes =
    offloadFraction > 0
      ? runtimeWeights * offloadFraction + kvHigh * offloadFraction + 512 * 1024 ** 2
      : 0
  const estimatedRamBytes = resources.unifiedMemory
    ? 1.25 * GIB + runtimeWeights + kvHigh
    : 1.25 * GIB + runtimeWeights * (1 - offloadFraction * 0.7) + kvHigh
  const capacity = params.memoryMode === 'capacity'
  const availableRamBytes = Math.max(0, capacity
    ? resources.systemMemoryTotalBytes - Math.max(4 * GIB, resources.systemMemoryTotalBytes * 0.2)
    : resources.systemMemoryFreeBytes)
  const availableVramBytes =
    resources.vramTotalBytes == null
      ? null
      : Math.max(0, resources.vramTotalBytes - (capacity
          ? Math.max(0.5 * GIB, resources.vramTotalBytes * 0.1)
          : (resources.vramUsedBytes ?? 0)))
  const ramRatio = ratio(estimatedRamBytes, availableRamBytes)
  const vramRatio = ratio(estimatedVramBytes, availableVramBytes)

  let severity: ModelFitEstimate['severity']
  if (!Number.isFinite(model.sizeBytes) || model.sizeBytes <= 0 || resources.systemMemoryTotalBytes <= 0) severity = 'unknown'
  else if (
    (ramRatio != null && ramRatio > 1.05) ||
    (vramRatio != null && offloadFraction > 0 && vramRatio > 1.05)
  ) {
    severity = 'infeasible'
  } else if (availableVramBytes == null && offloadFraction > 0) {
    severity = 'unknown'
  } else if (
    (ramRatio != null && ramRatio > 0.8) ||
    (vramRatio != null && offloadFraction > 0 && vramRatio > 0.8)
  ) {
    severity = 'tight'
  } else {
    severity = 'comfortable'
  }

  const summary =
    severity === 'infeasible'
      ? capacity ? 'Over the memory budget' : 'Likely exceeds available memory'
      : severity === 'tight'
        ? 'Likely fits with little headroom'
        : severity === 'comfortable'
          ? 'Likely fits with headroom'
          : 'Not enough information to estimate fit'
  const basis = capacity ? 'budgeted' : 'currently available'
  const details = [
    `Estimated ${resources.unifiedMemory ? 'shared memory' : 'peak RAM'} ${(estimatedRamBytes / GIB).toFixed(1)} GiB; ${(availableRamBytes / GIB).toFixed(1)} GiB ${basis}.`,
    offloadFraction > 0
      ? availableVramBytes == null
        ? `Estimated VRAM ${(estimatedVramBytes / GIB).toFixed(1)} GiB; GPU capacity is not measured yet.`
        : `Estimated GPU ${resources.unifiedMemory ? 'share' : 'VRAM'} ${(estimatedVramBytes / GIB).toFixed(1)} GiB; ${(availableVramBytes / GIB).toFixed(1)} GiB ${basis}.`
      : 'CPU mode keeps model weights and KV cache in system memory.',
    `Context KV estimate ${(kvLow / GIB).toFixed(1)}–${(kvHigh / GIB).toFixed(1)} GiB at ${contextSize.toLocaleString()} tokens.`,
    ...(!architecture ? ['Parameter count is unknown; context memory uses a generic architecture estimate.'] : []),
    ...(resources.unifiedMemory ? ['CPU and GPU share one memory pool; these figures must not be added together.'] : []),
    ...(capacity ? ['Budget reserves 20% of RAM (at least 4 GiB) and 10% of GPU capacity (at least 0.5 GiB). Close other memory-heavy apps before loading.'] : []),
    ...(params.gpuLayers < 0 && params.gpuEnabled ? ['Auto offload is estimated as full GPU offload. A larger model may still run with some layers on the CPU, more slowly.'] : []),
    'Estimate only: GGUF architecture, grouped-query attention, drivers, and runtime allocation can change actual use.'
  ]
  return {
    severity,
    estimatedRamBytes,
    estimatedVramBytes,
    estimatedKvBytes: { low: kvLow, high: kvHigh },
    availableRamBytes,
    availableVramBytes,
    offloadFraction,
    summary,
    details
  }
}

/** Name-only preview: account for all experts in common 8x7B-style MoE names. */
export function searchModelSize(name: string): { sizeBytes: number; paramLabel: string } | null {
  const experts = name.match(/\b(\d+)x(\d+(?:\.\d+)?)B\b/i)
  const paramLabel = experts
    ? `${Number(experts[1]) * Number(experts[2])}B`
    : parseParamLabel(name)
  const billions = parameterBillions(paramLabel)
  if (!paramLabel || !billions || !Number.isFinite(billions)) return null
  // A deliberately rounded Q4 estimate, including quantization metadata.
  return { sizeBytes: billions * 1e9 * 0.65, paramLabel }
}

export function recommendedModelSize(
  params: Omit<Parameters<typeof estimateModelFit>[0], 'model' | 'memoryMode'>
): number | null {
  const tiers = [0.5, 1, 3, 4, 7, 8, 12, 14, 20, 24, 27, 32, 70, 120]
  return tiers.filter((billions) => estimateModelFit({
    ...params,
    memoryMode: 'capacity',
    model: { sizeBytes: billions * 1e9 * 0.65, paramLabel: `${billions}B` }
  }).severity === 'comfortable').at(-1) ?? null
}
