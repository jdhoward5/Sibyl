import { describe, expect, it } from 'vitest'
import type { InstalledModel } from './types'
import { estimateModelFit, recommendedModelSize, searchModelSize } from './hardwareFit'

const model: InstalledModel = {
  id: 'model-1',
  repoId: 'example/model',
  filename: 'model-8B-Q4_K_M.gguf',
  path: 'C:/models/model.gguf',
  sizeBytes: 5 * 1024 ** 3,
  paramLabel: '8B',
  installedAt: '2026-01-01T00:00:00.000Z'
}

describe('estimateModelFit', () => {
  const gib = 1024 ** 3
  const hardware = {
    systemMemoryTotalBytes: 32 * gib,
    systemMemoryFreeBytes: 24 * gib,
    vramTotalBytes: 16 * gib,
    vramUsedBytes: 0
  }
  const options = { model, contextSize: 4096, gpuLayers: -1, gpuEnabled: true, resources: hardware }

  it('does not treat an exhausted GPU as having unknown or unlimited memory', () => {
    expect(estimateModelFit({ ...options, resources: { ...hardware, vramUsedBytes: 16 * gib } }).severity).toBe('infeasible')
    expect(estimateModelFit({ ...options, resources: { ...hardware, systemMemoryFreeBytes: 0 } }).severity).toBe('infeasible')
  })

  it('does not recommend a file with an unknown size or an unmeasured GPU', () => {
    expect(estimateModelFit({ ...options, model: { sizeBytes: 0 } }).severity).toBe('unknown')
    expect(estimateModelFit({ ...options, resources: { ...hardware, vramTotalBytes: null } }).severity).toBe('unknown')
  })

  it('keeps browsing guidance stable when another model occupies memory', () => {
    const normal = estimateModelFit({ ...options, memoryMode: 'capacity' })
    const busy = estimateModelFit({ ...options, memoryMode: 'capacity', resources: {
      ...hardware, vramUsedBytes: 15 * gib, systemMemoryFreeBytes: gib
    } })
    expect(busy.severity).toBe('comfortable')
    expect(busy.availableRamBytes).toBe(normal.availableRamBytes)
    expect(busy.availableVramBytes).toBe(normal.availableVramBytes)
    expect(estimateModelFit({ ...options, resources: {
      ...hardware, vramUsedBytes: 15 * gib, systemMemoryFreeBytes: gib
    } }).severity).toBe('infeasible')
  })

  it('charges all weights to shared RAM on unified-memory devices without adding VRAM again', () => {
    const fit = estimateModelFit({ ...options, resources: { ...hardware, unifiedMemory: true } })
    expect(fit.estimatedRamBytes).toBeCloseTo(1.25 * gib + model.sizeBytes * 1.08 + fit.estimatedKvBytes.high)
    expect(fit.details.join(' ')).toContain('must not be added together')
  })

  it('makes longer contexts and larger files more demanding', () => {
    const normal = estimateModelFit(options)
    const longer = estimateModelFit({ ...options, contextSize: 65536 })
    expect(longer.estimatedVramBytes).toBeGreaterThan(normal.estimatedVramBytes)
    expect(longer.severity).toBe('infeasible')
    expect(estimateModelFit({ ...options, model: { ...model, sizeBytes: 80 * gib } }).severity).toBe('infeasible')
  })

  it('warns about a tight fit before the GPU budget is exceeded', () => {
    const fit = estimateModelFit({ ...options, model: { ...model, sizeBytes: 11 * gib } })
    expect(fit.severity).toBe('tight')
    expect(fit.estimatedVramBytes).toBeLessThan(fit.availableVramBytes!)
  })

  it('recommends smaller Q4 models for smaller GPU budgets and no tier without GPU capacity', () => {
    const large = recommendedModelSize(options)!
    const small = recommendedModelSize({ ...options, resources: { ...hardware, vramTotalBytes: 6 * gib } })!
    expect(large).toBeGreaterThan(small)
    expect(recommendedModelSize({ ...options, resources: { ...hardware, vramTotalBytes: null } })).toBeNull()
    expect(recommendedModelSize({ ...options, gpuEnabled: false, resources: { ...hardware, vramTotalBytes: null } })).toBeGreaterThan(0)
  })

  it('uses all experts for name-only MoE estimates and leaves unnamed sizes unknown', () => {
    expect(searchModelSize('Mixtral-8x7B-GGUF')?.paramLabel).toBe('56B')
    expect(searchModelSize('Qwen-30B-A3B-GGUF')?.paramLabel).toBe('30B')
    expect(searchModelSize('Model-500M')?.sizeBytes).toBe(0.5 * 1e9 * 0.65)
    expect(searchModelSize('Mystery-Model')).toBeNull()
  })

  it('flags a clearly infeasible full offload and always supplies uncertainty details', () => {
    const fit = estimateModelFit({
      model,
      contextSize: 32_768,
      gpuLayers: -1,
      gpuEnabled: true,
      resources: {
        systemMemoryTotalBytes: 16 * 1024 ** 3,
        systemMemoryFreeBytes: 4 * 1024 ** 3,
        vramTotalBytes: 4 * 1024 ** 3,
        vramUsedBytes: 512 * 1024 ** 2
      }
    })
    expect(fit.severity).toBe('infeasible')
    expect(fit.details.at(-1)).toMatch(/Estimate only/)
  })

  it('distinguishes CPU loads and reports a KV range', () => {
    const fit = estimateModelFit({
      model,
      contextSize: 4_096,
      gpuLayers: 0,
      gpuEnabled: false,
      resources: {
        systemMemoryTotalBytes: 64 * 1024 ** 3,
        systemMemoryFreeBytes: 48 * 1024 ** 3,
        vramTotalBytes: null,
        vramUsedBytes: null
      }
    })
    expect(fit.severity).toBe('comfortable')
    expect(fit.offloadFraction).toBe(0)
    expect(fit.estimatedKvBytes.high).toBeGreaterThan(fit.estimatedKvBytes.low)
  })
})
