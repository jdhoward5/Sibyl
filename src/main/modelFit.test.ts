import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, InstalledModel } from '@shared/types'
import type { Llama } from 'node-llama-cpp'

const gib = 1024 ** 3
const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  read: vi.fn(),
  from: vi.fn(),
  weights: vi.fn(),
  context: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }))
vi.mock('./llama', () => ({
  nlc: async () => ({ readGgufFileInfo: mocks.read, GgufInsights: { from: mocks.from } })
}))
import { estimateInstalledModelFit, modelFitContextSize } from './modelFit'

const model: InstalledModel = {
  id: 'model', repoId: 'test/model', filename: 'anonymous.gguf', path: 'C:/models/anonymous.gguf',
  sizeBytes: 5 * gib, installedAt: '2026-01-01T00:00:00.000Z'
}
const resources = {
  systemMemoryTotalBytes: 32 * gib, systemMemoryFreeBytes: gib,
  vramTotalBytes: 16 * gib, vramUsedBytes: 15 * gib
}
const settings = { gpu: 'auto', load: { contextSize: 8192, gpuLayers: -1 } } as AppSettings
const llama = { gpu: 'cuda' } as Llama
let revision = 0

beforeEach(() => {
  vi.resetAllMocks()
  mocks.stat.mockResolvedValue({ size: model.sizeBytes, mtimeMs: ++revision })
  mocks.read.mockResolvedValue({ metadata: {} })
  mocks.weights.mockImplementation(({ gpuLayers }: { gpuLayers: number }) => ({
    cpuRam: 5 * gib * (1 - gpuLayers / 33), gpuVram: 5 * gib * gpuLayers / 33
  }))
  mocks.context.mockImplementation(({ modelGpuLayers, contextSize }: { modelGpuLayers: number; contextSize: number }) => ({
    cpuRam: 0.5 * gib * (contextSize / 4096) * (1 - modelGpuLayers / 33),
    gpuVram: 0.5 * gib * (contextSize / 4096) * modelGpuLayers / 33
  }))
  mocks.from.mockResolvedValue({
    totalLayers: 33, trainContextSize: 4096,
    estimateModelResourceRequirements: mocks.weights,
    estimateContextResourceRequirements: mocks.context
  })
})

describe('installed GGUF memory estimates', () => {
  it('reserves the trained context size during auto-offload planning', async () => {
    expect(await modelFitContextSize(model, 131072, llama)).toBe(4096)
    expect(await modelFitContextSize(model, 2048, llama)).toBe(2048)
    mocks.stat.mockRejectedValueOnce(new Error('unreadable'))
    expect(await modelFitContextSize({ ...model, trainContextLength: 8192 }, 131072, llama)).toBe(8192)
  })
  it('uses tensor placement and actual context metadata even without a parameter label', async () => {
    const fit = await estimateInstalledModelFit(model, settings, resources, llama)
    expect(fit.severity).toBe('comfortable')
    expect(fit.estimatedRamBytes).toBe(1.25 * gib)
    expect(fit.estimatedVramBytes).toBe(6 * gib)
    expect(mocks.context).toHaveBeenCalledWith({
      contextSize: 4096, modelGpuLayers: 33, sequences: 1, flashAttention: true
    })
    expect(mocks.read).toHaveBeenCalledWith(model.path, expect.objectContaining({
      sourceType: 'filesystem', logWarnings: false
    }))
  })

  it('keeps predictions independent of the model being replaced and uses CPU mode when selected', async () => {
    const fit = await estimateInstalledModelFit(model, settings, resources, llama)
    const free = await estimateInstalledModelFit(model, settings, {
      ...resources, systemMemoryFreeBytes: 24 * gib, vramUsedBytes: 0
    }, llama)
    expect(fit).toEqual(free)
    const cpu = await estimateInstalledModelFit(model, { ...settings, gpu: 'cpu' }, resources, llama)
    expect(cpu.estimatedVramBytes).toBe(0)
    expect(cpu.estimatedRamBytes).toBe(6.75 * gib)
  })

  it('invalidates cached headers when the registered file changes', async () => {
    await estimateInstalledModelFit(model, settings, resources, llama)
    await estimateInstalledModelFit(model, settings, resources, llama)
    expect(mocks.read).toHaveBeenCalledTimes(1)
    mocks.stat.mockResolvedValue({ size: model.sizeBytes + 1, mtimeMs: revision })
    await estimateInstalledModelFit(model, settings, resources, llama)
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('moves excess GPU layers to RAM using the GGUF estimator', async () => {
    const fit = await estimateInstalledModelFit(model, settings, { ...resources, vramTotalBytes: 4 * gib }, llama)
    expect(fit.severity).toBe('tight')
    expect(fit.usesCpuOffload).toBe(true)
    expect(fit.estimatedVramBytes).toBeLessThanOrEqual(fit.availableVramBytes!)
    expect(fit.estimatedRamBytes).toBeGreaterThan(1.25 * gib)
  })

  it('falls back visibly without leaking parser errors when GGUF metadata cannot be used', async () => {
    mocks.context.mockReturnValue({ cpuRam: NaN, gpuVram: NaN })
    const fit = await estimateInstalledModelFit(model, settings, resources, llama)
    expect(fit.details.join(' ')).toContain('less precise parameter-count estimate')
    expect(Number.isFinite(fit.estimatedRamBytes)).toBe(true)
    mocks.stat.mockRejectedValueOnce(new Error('sensitive filesystem path'))
    const missing = await estimateInstalledModelFit(model, settings, resources, llama)
    expect(JSON.stringify(missing)).not.toContain('sensitive filesystem path')
  })
})
