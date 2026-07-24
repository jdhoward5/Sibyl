import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('node-llama-cpp')
  vi.resetModules()
})

describe('llama initialization retry', () => {
  it('clears a rejected cached request so the same backend can retry', async () => {
    const instance = { dispose: vi.fn(async () => undefined) }
    const getLlama = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(instance)
    vi.doMock('node-llama-cpp', () => ({ getLlama }))
    const { getLlamaInstance, disposeLlama } = await import('./llama')

    await expect(getLlamaInstance('cpu')).rejects.toThrow('transient')
    await expect(getLlamaInstance('cpu')).resolves.toBe(instance)
    await disposeLlama()
  })
})
