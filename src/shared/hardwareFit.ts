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
  usesCpuOffload: boolean
  summary: string
  details: string[]
}

/** Memory placement supplied by the GGUF reader; no native objects cross IPC. */
export interface ModelMemoryRequirements {
  ramBytes: number
  vramBytes: number
  contextBytes: number
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
  model: Pick<InstalledModel, 'sizeBytes' | 'paramLabel' | 'trainContextLength'>
  contextSize: number
  gpuLayers: number
  gpuEnabled: boolean
  resources: HardwareResources
  /** Browsing plans against capacity with headroom, independent of a loaded model. */
  memoryMode?: 'available' | 'capacity'
  /** Main-process GGUF estimates replace the name-only architecture heuristic. */
  modelLayers?: number
  estimateResources?: (gpuLayers: number, contextSize: number) => ModelMemoryRequirements
}): ModelFitEstimate {
  const { model, resources } = params
  const parametersB = parameterBillions(model.paramLabel)
  const architecture = parametersB ? architectureEstimate(parametersB) : null
  const contextSize = Math.max(512, Math.floor(Math.min(
    params.contextSize,
    model.trainContextLength && model.trainContextLength > 0 ? model.trainContextLength : params.contextSize
  )))
  const layers = params.modelLayers ?? (architecture?.layers ?? 64) + 1

  // GGUF weights are close to their mapped runtime size. The extra 8% covers
  // tensors and allocator alignment while avoiding false precision.
  const runtimeWeights = model.sizeBytes * 1.08
  const kvLow = architecture
    ? contextSize * architecture.layers * architecture.embedding * 2 * 2 * 0.125
    : contextSize * 64 * 4_096 * 2 * 2 * 0.125
  // Without a header, allow the full multi-head FP16 cache as the upper bound.
  // Parameter count alone cannot tell us the model's grouped-query head count.
  const kvHigh = kvLow * 8
  // A name-only preview needs an explicit attention assumption for its central
  // estimate. Keep the wider GQA-to-MHA range visible instead of budgeting every
  // modern model as a full multi-head cache.
  const kvExpected = kvLow * 2
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
  const requirements = (gpuLayers: number): ModelMemoryRequirements => {
    const fraction = gpuLayers / layers
    const memory = params.estimateResources?.(gpuLayers, contextSize) ?? {
      ramBytes: (runtimeWeights + kvExpected) * (1 - fraction),
      vramBytes: (runtimeWeights + kvExpected) * fraction,
      contextBytes: kvExpected
    }
    return {
      ramBytes: 1.25 * GIB + memory.ramBytes + (resources.unifiedMemory ? memory.vramBytes : 0)
        + (resources.unifiedMemory && gpuLayers > 0 ? 0.5 * GIB : 0),
      vramBytes: gpuLayers > 0 ? memory.vramBytes + 0.5 * GIB : 0,
      contextBytes: memory.contextBytes
    }
  }
  const auto = params.gpuEnabled && params.gpuLayers < 0
  let gpuLayers = params.gpuEnabled
    ? params.gpuLayers < 0 ? layers : Math.min(layers, Math.max(0, Math.floor(params.gpuLayers)))
    : 0
  let memory = requirements(gpuLayers)
  // Auto in the engine chooses how many layers fit. A VRAM shortfall is a
  // CPU-offload warning, not proof that the model cannot run on this machine.
  if (auto && availableVramBytes != null) {
    if (memory.vramBytes > availableVramBytes) {
      let low = 0
      let high = gpuLayers - 1
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (requirements(middle).vramBytes <= availableVramBytes) low = middle
        else high = middle - 1
      }
      gpuLayers = low
      memory = requirements(gpuLayers)
    }
  }
  const offloadFraction = gpuLayers / layers
  const partialOffload = auto && gpuLayers < layers
  const estimatedRamBytes = memory.ramBytes
  const estimatedVramBytes = memory.vramBytes
  const ramRatio = ratio(estimatedRamBytes, availableRamBytes)
  const vramRatio = ratio(estimatedVramBytes, availableVramBytes)

  let severity: ModelFitEstimate['severity']
  if (!Number.isFinite(model.sizeBytes) || model.sizeBytes <= 0 || resources.systemMemoryTotalBytes <= 0) severity = 'unknown'
  else if (
    (ramRatio != null && ramRatio > 1.05) ||
    (vramRatio != null && offloadFraction > 0 && vramRatio > 1.05)
  ) {
    severity = 'infeasible'
  } else if (availableVramBytes == null && params.gpuEnabled && params.gpuLayers !== 0) {
    severity = 'unknown'
  } else if (
    partialOffload || (ramRatio != null && ramRatio > 0.8) ||
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
        ? partialOffload ? 'Likely fits with CPU offload; expect slower replies' : 'Likely fits with little headroom'
        : severity === 'comfortable'
          ? 'Likely fits with headroom'
          : 'Not enough information to estimate fit'
  const basis = capacity ? 'budgeted' : 'currently available'
  const details = [
    `Estimated ${resources.unifiedMemory ? 'shared memory' : 'RAM'} ${(estimatedRamBytes / GIB).toFixed(1)} GiB; ${(availableRamBytes / GIB).toFixed(1)} GiB ${basis}.`,
    offloadFraction > 0
      ? availableVramBytes == null
        ? `Estimated VRAM ${(estimatedVramBytes / GIB).toFixed(1)} GiB; GPU capacity is not measured yet.`
        : `Estimated GPU ${resources.unifiedMemory ? 'share' : 'VRAM'} ${(estimatedVramBytes / GIB).toFixed(1)} GiB; ${(availableVramBytes / GIB).toFixed(1)} GiB ${basis}.`
      : 'CPU mode keeps model weights and KV cache in system memory.',
    params.estimateResources
      ? `GGUF context memory estimate ${(memory.contextBytes / GIB).toFixed(1)} GiB at ${contextSize.toLocaleString()} tokens (FP16 cache, flash attention, one sequence).`
      : `Context KV range ${(kvLow / GIB).toFixed(1)}–${(kvHigh / GIB).toFixed(1)} GiB at ${contextSize.toLocaleString()} tokens; preview uses ${(kvExpected / GIB).toFixed(1)} GiB, assuming grouped-query attention with a quarter-size cache. Architecture is inferred from parameter count; file size alone cannot determine cache memory.`,
    ...(resources.unifiedMemory ? ['CPU and GPU share one memory pool; these figures must not be added together.'] : []),
    ...(capacity ? ['Budget reserves 20% of RAM (at least 4 GiB) and 10% of GPU capacity (at least 0.5 GiB). Close other memory-heavy apps before loading.'] : []),
    ...(auto ? [`Auto offload estimates ${gpuLayers} of ${layers} layers on the GPU.${partialOffload ? ' The remaining layers use system RAM and can substantially reduce speed.' : ''}`] : []),
    'Estimate only: GGUF architecture, grouped-query attention, drivers, and runtime allocation can change actual use.'
  ]
  return {
    severity,
    estimatedRamBytes,
    estimatedVramBytes,
    estimatedKvBytes: params.estimateResources
      ? { low: memory.contextBytes, high: memory.contextBytes }
      : { low: kvLow, high: kvHigh },
    availableRamBytes,
    availableVramBytes,
    offloadFraction,
    usesCpuOffload: partialOffload,
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
  params: Omit<Parameters<typeof estimateModelFit>[0], 'model' | 'memoryMode' | 'modelLayers' | 'estimateResources'>
): number | null {
  const tiers = [0.5, 1, 3, 4, 7, 8, 12, 14, 20, 24, 27, 32, 70, 120]
  return tiers.filter((billions) => {
    const fit = estimateModelFit({
      ...params,
      memoryMode: 'capacity',
      model: { sizeBytes: billions * 1e9 * 0.65, paramLabel: `${billions}B` }
    })
    // The capacity budget already reserves OS/driver headroom. Requiring an
    // additional 20% here needlessly drops an entire parameter tier.
    return fit.severity !== 'unknown' && !fit.usesCpuOffload
      && fit.estimatedRamBytes <= fit.availableRamBytes
      && (fit.offloadFraction === 0 || (fit.availableVramBytes != null && fit.estimatedVramBytes <= fit.availableVramBytes))
  }).at(-1) ?? null
}
