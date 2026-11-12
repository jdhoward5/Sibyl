import { describe, expect, it } from 'vitest'
import { GgufInsights, type GgufFileInfo, type Llama } from 'node-llama-cpp'

// Exercise the installed compatibility patch, including the estimator used by
// native load/context safety checks. No model file or GPU is required.
async function insights(architecture = 'gemma4', pattern?: boolean[]) {
  const sliding = pattern ?? Array.from({ length: 60 }, (_, i) => i % 6 !== 5)
  const info = {
    metadata: { general: { architecture } },
    architectureMetadata: {
      block_count: 60,
      context_length: 262144,
      embedding_length: 5376,
      vocab_size: 0,
      attention: {
        head_count: 32,
        head_count_kv: Array.from({ length: 60 }, (_, i) => i % 6 === 5 ? 4 : 16),
        key_length: 512,
        value_length: 512,
        key_length_swa: 256,
        value_length_swa: 256,
        sliding_window: 1024,
        sliding_window_pattern: sliding
      }
    },
    fullTensorInfo: []
  } as unknown as GgufFileInfo
  const llama = {
    _consts: { ggmlTensorOverhead: 0, ggmlTypeF16Size: 2, ggmlTypeF32Size: 4 },
    _bindings: {
      getGgmlGraphOverheadCustom: () => 0,
      getTypeSizeForGgmlType: () => 2
    }
  } as unknown as Llama
  return GgufInsights.from(info, llama)
}

const options = { contextSize: 12288, modelGpuLayers: 61, sequences: 1, batchSize: 512, flashAttention: true }
const globalCache = 10 * 4 * 512 * 4 * 12288
// The addon receives a 513-token batch; b9616 rounds 1024 + 513 to 1792 cells.
const slidingCache = 50 * 16 * 256 * 4 * 1792
const outputIds = 4 * 512

describe('Gemma 4 memory compatibility patch', () => {
  it('budgets Artemis 12K per layer instead of allocating a full cache for every layer', async () => {
    const model = await insights()
    const memory = model.estimateContextResourceRequirements(options)
    expect(memory.gpuVram).toBe(globalCache + slidingCache + outputIds)
    expect(memory.cpuRam).toBe(outputIds)
    expect(memory.gpuVram).toBeLessThan(3 * 1024 ** 3)
  })

  it('preserves the full global cache as context grows while bounding sliding layers', async () => {
    const model = await insights()
    const small = model.estimateContextResourceRequirements(options)
    const large = model.estimateContextResourceRequirements({ ...options, contextSize: 24576 })
    expect(large.gpuVram - small.gpuVram).toBe(globalCache)
  })

  it('places each layer cache on the same device as its model layer', async () => {
    const model = await insights()
    // GPU layers include the output layer: 31 means the last 30 repeating layers.
    const split = model.estimateContextResourceRequirements({ ...options, modelGpuLayers: 31 })
    expect(split.gpuVram).toBe((globalCache + slidingCache) / 2 + outputIds)
    expect(split.cpuRam).toBe(split.gpuVram)
    const cpu = model.estimateContextResourceRequirements({ ...options, modelGpuLayers: 0 })
    expect(cpu.gpuVram).toBe(0)
    expect(cpu.cpuRam).toBe(globalCache + slidingCache + outputIds)
  })

  it('honors full SWA cache and short contexts with the smaller sliding head dimensions', async () => {
    const model = await insights()
    const full = model.estimateContextResourceRequirements({ ...options, swaFullCache: true })
    expect(full.gpuVram).toBe(globalCache + 50 * 16 * 256 * 4 * 12288 + outputIds)
    const short = model.estimateContextResourceRequirements({ ...options, contextSize: 512 })
    expect(short.gpuVram).toBe((10 * 4 * 512 + 50 * 16 * 256) * 4 * 512 + outputIds)
  })

  it('scales both kinds of cache for multiple sequences', async () => {
    const model = await insights()
    const memory = model.estimateContextResourceRequirements({ ...options, sequences: 2 })
    expect(memory.gpuVram).toBe(2 * (globalCache + slidingCache) + outputIds)
  })

  it('rounds each native sliding cache to 256 cells including the SWA edge token', async () => {
    const model = await insights()
    const memory = model.estimateContextResourceRequirements({ ...options, batchSize: 256 })
    expect(memory.gpuVram).toBe(globalCache + 50 * 16 * 256 * 4 * 1536 + 4 * 256)
  })

  it('keeps the existing conservative estimate for incomplete or unrelated metadata', async () => {
    const incomplete = await insights('gemma4', [true, false])
    const unrelated = await insights('unknown')
    const expected = (10 * 4 + 50 * 16) * 512 * 4 * 12288 + outputIds
    expect(incomplete.estimateContextResourceRequirements(options).gpuVram).toBe(expected)
    expect(unrelated.estimateContextResourceRequirements(options).gpuVram).toBe(expected)
  })
})
