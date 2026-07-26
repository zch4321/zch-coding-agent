export interface FocusableDesktopWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface DesktopSingleInstanceOptions {
  requestLock: () => boolean
  onSecondInstance: (listener: () => void) => void
  quit: () => void
  getWindow: () => FocusableDesktopWindow | undefined
}

/** Claims the desktop process lock and focuses the primary window on relaunch. */
export function acquireDesktopSingleInstance(
  options: DesktopSingleInstanceOptions,
): boolean {
  if (!options.requestLock()) {
    options.quit()
    return false
  }

  options.onSecondInstance(() => {
    const window = options.getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
  })
  return true
}
