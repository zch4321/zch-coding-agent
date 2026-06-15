export type DisposeTask = () => Promise<void> | void

export interface Disposable {
  dispose: DisposeTask
}

export interface DisposeReport {
  completed: number
  failed: number
  skipped: number
  timedOut: boolean
}

export interface DisposerOptions {
  timeoutMs?: number
  onError?: (error: unknown) => void
}

interface RegisteredTask {
  active: boolean
  task: DisposeTask
}

const DEFAULT_TIMEOUT_MS = 5_000

export class Disposer {
  readonly #timeoutMs: number
  readonly #onError: (error: unknown) => void
  readonly #tasks: RegisteredTask[] = []
  #disposePromise: Promise<DisposeReport> | undefined

  constructor(options: DisposerOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('timeoutMs must be a finite, non-negative number')
    }

    this.#timeoutMs = timeoutMs
    this.#onError = options.onError ?? (() => undefined)
  }

  add(disposable: Disposable | DisposeTask): () => void {
    if (this.#disposePromise) {
      throw new Error('Cannot register a resource after disposal has started')
    }

    const registered: RegisteredTask = {
      active: true,
      task:
        typeof disposable === 'function'
          ? disposable
          : () => disposable.dispose(),
    }

    this.#tasks.push(registered)

    return () => {
      registered.active = false
    }
  }

  dispose(): Promise<DisposeReport> {
    this.#disposePromise ??= this.#run()
    return this.#disposePromise
  }

  async #run(): Promise<DisposeReport> {
    const tasks = this.#tasks.filter(({ active }) => active).reverse()
    this.#tasks.length = 0

    const report: DisposeReport = {
      completed: 0,
      failed: 0,
      skipped: 0,
      timedOut: false,
    }
    const deadline = Date.now() + this.#timeoutMs

    for (const [index, registered] of tasks.entries()) {
      const remainingMs = deadline - Date.now()

      if (remainingMs <= 0) {
        report.timedOut = true
        report.skipped = tasks.length - index
        break
      }

      const result = await this.#runTask(registered.task, remainingMs)

      if (result === 'completed') {
        report.completed += 1
        continue
      }

      if (result === 'failed') {
        report.failed += 1
        continue
      }

      report.timedOut = true
      report.skipped = tasks.length - index - 1
      break
    }

    return report
  }

  #runTask(
    task: DisposeTask,
    timeoutMs: number,
  ): Promise<'completed' | 'failed' | 'timeout'> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (result: 'completed' | 'failed' | 'timeout') => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => finish('timeout'), timeoutMs)

      Promise.resolve()
        .then(task)
        .then(
          () => finish('completed'),
          (error: unknown) => {
            try {
              this.#onError(error)
            } catch {
              // Cleanup failures must not create a second failure path.
            }

            finish('failed')
          },
        )
    })
  }
}
