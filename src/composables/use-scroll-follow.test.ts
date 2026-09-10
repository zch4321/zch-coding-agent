// @vitest-environment jsdom
import { effectScope, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useScrollFollow } from './use-scroll-follow'

afterEach(() => vi.restoreAllMocks())

describe('scroll following', () => {
  it('coalesces frames and cancels both queued and in-flight work after an upward gesture', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let sequence = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++sequence, callback)
      return sequence
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const scope = effectScope()
    const scroll = vi.fn()
    const follow = scope.run(() =>
      useScrollFollow({ content: () => undefined, scroll }),
    )!
    follow.schedule()
    follow.schedule()
    await nextTick()
    expect(frames.size).toBe(1)
    const stale = [...frames.values()][0]!
    follow.onWheel(new WheelEvent('wheel', { deltaY: -1 }))
    stale(0)
    expect(scroll).not.toHaveBeenCalled()
    expect(follow.following.value).toBe(false)
    follow.resume()
    await nextTick()
    for (const callback of frames.values()) callback(1)
    frames.clear()
    expect(scroll).toHaveBeenCalledTimes(1)
    follow.schedule()
    follow.pause()
    await nextTick()
    expect(frames.size).toBe(0)
    follow.resume()
    scope.stop()
    await nextTick()
    expect(frames.size).toBe(0)
  })

  it('keeps a small upward scroll paused and resumes only when the user returns downward to the bottom', () => {
    const scope = effectScope()
    const follow = scope.run(() =>
      useScrollFollow({ content: () => undefined, scroll: vi.fn() }),
    )!
    const element = document.createElement('div')
    Object.defineProperties(element, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 200 },
    })
    const scrollEvent = new Event('scroll')
    Object.defineProperty(scrollEvent, 'target', { value: element })
    element.scrollTop = 800
    follow.onScroll(scrollEvent)
    follow.onWheel(new WheelEvent('wheel', { deltaY: -10 }))
    element.scrollTop = 790
    follow.onScroll(scrollEvent)
    expect(follow.following.value).toBe(false)
    follow.onScroll(scrollEvent)
    expect(follow.following.value).toBe(false)
    element.scrollTop = 800
    follow.onScroll(scrollEvent)
    expect(follow.following.value).toBe(true)
    // Restoring a pagination anchor is not a user request to resume following.
    follow.pause(800)
    follow.onScroll(scrollEvent)
    expect(follow.following.value).toBe(false)
    scope.stop()
  })
})
