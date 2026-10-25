import { describe, expect, it, vi } from 'vitest'
import type { Llama } from 'node-llama-cpp'
import { readHardware } from './hardware'

function backend(overrides: Record<string, unknown> = {}): Llama {
  return {
    gpu: 'cuda',
    getGpuDeviceNames: vi.fn(async () => ['Test GPU']),
    getVramState: vi.fn(async () => ({ total: 16 * 1024 ** 3, used: 1024 ** 3, unifiedSize: 0 })),
    ...overrides
  } as unknown as Llama
}

describe('local hardware snapshot', () => {
  it('reads the inference device and memory without loading a model', async () => {
    const info = await readHardware(async () => backend())
    expect(info.gpuNames).toEqual(['Test GPU'])
    expect(info.gpuType).toBe('cuda')
    expect(info.vramTotalBytes).toBe(16 * 1024 ** 3)
    expect(info.systemMemoryTotalBytes).toBeGreaterThan(0)
    expect(info.logicalCores).toBeGreaterThan(0)
    expect(info.detectionError).toBeUndefined()
  })

  it('keeps RAM and CPU visible after backend detection fails without leaking native errors', async () => {
    const info = await readHardware(async () => { throw new Error('private filesystem path') })
    expect(info.gpuType).toBeNull()
    expect(info.systemMemoryTotalBytes).toBeGreaterThan(0)
    expect(info.detectionError).toContain('could not be detected')
    expect(JSON.stringify(info)).not.toContain('private filesystem path')
  })

  it('retains device names when GPU memory measurement fails', async () => {
    const info = await readHardware(async () => backend({
      getVramState: vi.fn(async () => { throw new Error('unavailable') })
    }))
    expect(info.gpuNames).toEqual(['Test GPU'])
    expect(info.vramTotalBytes).toBeNull()
    expect(info.detectionError).toContain('could not be measured')
  })

  it('recognizes shared GPU capacity and handles CPU fallback', async () => {
    const shared = await readHardware(async () => backend({
      getVramState: vi.fn(async () => ({ total: 100, used: 25, unifiedSize: 100 }))
    }))
    expect(shared.unifiedMemory).toBe(true)
    const cpu = await readHardware(async () => backend({ gpu: false }))
    expect(cpu.gpuType).toBe(false)
    expect(cpu.vramTotalBytes).toBeNull()
    expect(cpu.detectionError).toBeUndefined()
  })
})
