/**
 * A tiny FIFO promise queue. A rejected task never poisons later tasks.
 *
 * `run` deliberately chains from both the fulfilled and rejected states so a
 * failed durable write or native operation cannot block a later retry.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  idle(): Promise<void> {
    return this.tail
  }
}

