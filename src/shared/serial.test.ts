import { describe, expect, it } from 'vitest'
import { SerialQueue } from './serial'

describe('SerialQueue', () => {
  it('runs tasks in FIFO order and survives rejection', async () => {
    const queue = new SerialQueue()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = queue.run(async () => {
      order.push('first:start')
      await gate
      order.push('first:end')
      throw new Error('disk full')
    })
    const second = queue.run(async () => {
      order.push('second')
      return 2
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    release()
    await expect(first).rejects.toThrow('disk full')
    await expect(second).resolves.toBe(2)
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })
})
