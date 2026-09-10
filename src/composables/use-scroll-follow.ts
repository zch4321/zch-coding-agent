import { nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'

interface ScrollFollowOptions {
  content(): HTMLElement | null | undefined
  scroll(): void
  initialFollowing?: boolean
}

/** Follows content resize once per frame and cancels queued work on user navigation. */
export function useScrollFollow(options: ScrollFollowOptions) {
  const following = ref(options.initialFollowing ?? true)
  const element = shallowRef<HTMLElement>()
  let generation = 0
  let pending = false
  let frame: number | undefined
  let observer: ResizeObserver | undefined
  let lastTop = 0
  let touchY: number | undefined
  let disposed = false

  function cancel(): void {
    generation += 1
    pending = false
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }

  function pause(top = element.value?.scrollTop ?? 0): void {
    cancel()
    following.value = false
    lastTop = top
  }

  function schedule(): void {
    if (disposed || pending || !following.value) return
    const ticket = generation
    pending = true
    void nextTick().then(() => {
      if (disposed || ticket !== generation || !following.value) return
      frame = requestAnimationFrame(() => {
        if (disposed || ticket !== generation || !following.value) return
        frame = undefined
        pending = false
        options.scroll()
        lastTop = element.value?.scrollTop ?? 0
      })
    })
  }

  function resume(): void {
    cancel()
    following.value = true
    lastTop = element.value?.scrollTop ?? 0
    schedule()
  }

  function onScroll(event: Event): void {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    element.value = target
    const difference = target.scrollTop - lastTop
    const nearBottom =
      target.scrollHeight - target.scrollTop - target.clientHeight < 48
    lastTop = target.scrollTop
    if (difference < -1 || (following.value && !nearBottom)) pause()
    else if (!following.value && difference > 1 && nearBottom) resume()
  }

  function onWheel(event: WheelEvent): void {
    if (event.deltaY < 0 && !event.ctrlKey) pause()
  }

  function onKeydown(event: KeyboardEvent): void {
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest('input, textarea, [contenteditable="true"]')
    )
      return
    if (
      ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
      (event.key === ' ' && event.shiftKey)
    )
      pause()
  }

  function onTouchstart(event: TouchEvent): void {
    touchY = event.touches[0]?.clientY
  }

  function onTouchmove(event: TouchEvent): void {
    const nextY = event.touches[0]?.clientY
    if (touchY !== undefined && nextY !== undefined && nextY > touchY + 1)
      pause()
    touchY = nextY
  }

  watch(
    options.content,
    (content) => {
      observer?.disconnect()
      observer = undefined
      lastTop = element.value?.scrollTop ?? 0
      if (content && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(schedule)
        observer.observe(content)
      }
      if (content) schedule()
    },
    { flush: 'post', immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
    cancel()
    observer?.disconnect()
  })

  return {
    element,
    following,
    pause,
    resume,
    schedule,
    onScroll,
    onWheel,
    onKeydown,
    onTouchstart,
    onTouchmove,
  }
}
