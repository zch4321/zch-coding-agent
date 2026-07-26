import { describe, expect, it, vi } from 'vitest'
import {
  acquireDesktopSingleInstance,
  type FocusableDesktopWindow,
} from './single-instance'

function windowFixture(
  overrides: Partial<FocusableDesktopWindow> = {},
): FocusableDesktopWindow {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  }
}

describe('desktop single-instance guard', () => {
  it('quits before registering a listener when another instance owns the lock', () => {
    const quit = vi.fn()
    const onSecondInstance = vi.fn()

    expect(
      acquireDesktopSingleInstance({
        requestLock: () => false,
        onSecondInstance,
        quit,
        getWindow: () => undefined,
      }),
    ).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(onSecondInstance).not.toHaveBeenCalled()
  })

  it('restores, shows, and focuses the primary window on relaunch', () => {
    let secondInstanceListener: (() => void) | undefined
    const window = windowFixture({
      isMinimized: () => true,
      isVisible: () => false,
    })

    expect(
      acquireDesktopSingleInstance({
        requestLock: () => true,
        onSecondInstance: (listener) => {
          secondInstanceListener = listener
        },
        quit: vi.fn(),
        getWindow: () => window,
      }),
    ).toBe(true)
    secondInstanceListener?.()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('ignores relaunch events until a usable primary window exists', () => {
    let secondInstanceListener: (() => void) | undefined
    const window = windowFixture({ isDestroyed: () => true })

    acquireDesktopSingleInstance({
      requestLock: () => true,
      onSecondInstance: (listener) => {
        secondInstanceListener = listener
      },
      quit: vi.fn(),
      getWindow: () => window,
    })
    secondInstanceListener?.()
    expect(window.focus).not.toHaveBeenCalled()
  })
})
