import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Provides controlled highlighting replies without starting a browser worker. */
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage?: (event: MessageEvent) => void
  onerror?: () => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() {
    FakeWorker.instances.push(this)
  }
  /** Completes the latest queued highlighting request. */
  reply(html: string): void {
    const { id } = this.postMessage.mock.lastCall![0] as { id: number }
    this.onmessage?.({ data: { id, html } } as MessageEvent)
  }
}

beforeEach(() => {
  vi.resetModules()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => vi.unstubAllGlobals())

describe('worker code highlighting', () => {
  it('shares in-flight requests, caches normalized languages and bounds the cache', async () => {
    const { renderCode, cachedCodeHtml } = await import('./markdown-code')
    const first = renderCode('const n = 1', 'ts')
    const second = renderCode('const n = 1', 'typescript')
    const worker = FakeWorker.instances[0]!
    expect(first).toBe(second)
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    worker.reply('<pre>colored</pre>')
    await expect(first).resolves.toBe('<pre>colored</pre>')
    await expect(renderCode('const n = 1', 'ts')).resolves.toBe(
      '<pre>colored</pre>',
    )
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 128; index++) {
      const result = renderCode(`const n = ${index + 2}`, 'ts')
      worker.reply('<pre>next</pre>')
      await result
    }
    expect(cachedCodeHtml('const n = 1', 'ts')).toBeUndefined()
    const large = renderCode('large result', 'ts')
    worker.reply('x'.repeat(5 * 1024 * 1024))
    await large
    expect(cachedCodeHtml('large result', 'ts')).toBeUndefined()
  })

  it('rejects failed work and can start a fresh worker without losing plain code', async () => {
    const { renderCode } = await import('./markdown-code')
    await expect(renderCode('first\nsecond\n', 'text')).resolves.toContain(
      'first\nsecond\n',
    )
    await expect(renderCode('<script>&', 'unsupported')).resolves.toContain(
      '&lt;script&gt;&amp;',
    )
    expect(FakeWorker.instances).toHaveLength(0)
    const failed = renderCode('const n = 1', 'ts')
    const rejection = expect(failed).rejects.toThrow('worker failed')
    FakeWorker.instances[0]!.onerror?.()
    await rejection
    const retry = renderCode('const n = 1', 'ts')
    expect(FakeWorker.instances).toHaveLength(2)
    FakeWorker.instances[1]!.reply('<pre>recovered</pre>')
    await expect(retry).resolves.toBe('<pre>recovered</pre>')
  })
})
