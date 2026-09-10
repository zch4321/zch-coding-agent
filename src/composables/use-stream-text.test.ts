import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStreamText } from './use-stream-text'

afterEach(() => vi.useRealTimers())

describe('stream display scheduling', () => {
  it('keeps only the latest pending text and flushes reset, completion and disposal boundaries', () => {
    vi.useFakeTimers()
    const source = ref('start')
    const live = ref(true)
    const scope = effectScope()
    const displayed = scope.run(() =>
      useStreamText(
        () => source.value,
        () => live.value,
      ),
    )!
    for (let index = 0; index < 100; index++) source.value += 'x'
    expect(vi.getTimerCount()).toBe(1)
    expect(displayed.value).toBe('start')
    vi.advanceTimersByTime(50)
    expect(displayed.value).toBe(source.value)
    source.value += ' pending'
    live.value = false
    expect(displayed.value).toBe(source.value)
    expect(vi.getTimerCount()).toBe(0)
    live.value = true
    source.value = ''
    expect(displayed.value).toBe('')
    source.value = 'next stream'
    scope.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
