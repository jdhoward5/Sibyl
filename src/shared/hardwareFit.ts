import type { InstalledModel } from './types'

const GIB = 1024 ** 3

export interface HardwareResources {
  systemMemoryTotalBytes: number
  systemMemoryFreeBytes: number
  vramTotalBytes: number | null
  vramUsedBytes: number | null
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
  return available && available > 0 ? required / available : null
}

export function estimateModelFit(params: {
  model: InstalledModel
  contextSize: number
  gpuLayers: number
  gpuEnabled: boolean
  resources: HardwareResources
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
  const estimatedRamBytes =
    1.25 * GIB + runtimeWeights * (1 - offloadFraction * 0.7) + kvHigh
  const availableRamBytes = Math.max(0, resources.systemMemoryFreeBytes)
  const availableVramBytes =
    resources.vramTotalBytes == null
      ? null
      : Math.max(0, resources.vramTotalBytes - (resources.vramUsedBytes ?? 0))
  const ramRatio = ratio(estimatedRamBytes, availableRamBytes)
  const vramRatio = ratio(estimatedVramBytes, availableVramBytes)

  let severity: ModelFitEstimate['severity']
  if (!model.sizeBytes || availableRamBytes <= 0) severity = 'unknown'
  else if (
    (ramRatio != null && ramRatio > 1.05) ||
    (vramRatio != null && offloadFraction > 0 && vramRatio > 1.05)
  ) {
    severity = 'infeasible'
  } else if (
    (ramRatio != null && ramRatio > 0.8) ||
    (vramRatio != null && offloadFraction > 0 && vramRatio > 0.8)
  ) {
    severity = 'tight'
  } else {
    severity = availableVramBytes == null && offloadFraction > 0 ? 'unknown' : 'comfortable'
  }

  const summary =
    severity === 'infeasible'
      ? 'Likely exceeds available memory'
      : severity === 'tight'
        ? 'Likely fits with little headroom'
        : severity === 'comfortable'
          ? 'Likely fits with headroom'
          : 'Fit is uncertain until the GPU is initialized'
  const details = [
    `Estimated peak RAM ${(estimatedRamBytes / GIB).toFixed(1)} GiB; ${(availableRamBytes / GIB).toFixed(1)} GiB currently available.`,
    offloadFraction > 0
      ? availableVramBytes == null
        ? `Estimated VRAM ${(estimatedVramBytes / GIB).toFixed(1)} GiB; GPU capacity is not measured yet.`
        : `Estimated VRAM ${(estimatedVramBytes / GIB).toFixed(1)} GiB; ${(availableVramBytes / GIB).toFixed(1)} GiB currently available.`
      : 'CPU mode keeps model weights and KV cache in system memory.',
    `Context KV estimate ${(kvLow / GIB).toFixed(1)}–${(kvHigh / GIB).toFixed(1)} GiB at ${contextSize.toLocaleString()} tokens.`,
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
