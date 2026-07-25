import { describe, expect, it } from 'vitest'
import type { InstalledModel } from './types'
import { estimateModelFit } from './hardwareFit'

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
