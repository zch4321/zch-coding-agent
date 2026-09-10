import { onScopeDispose, shallowRef, watch } from 'vue'

/** Coalesces append-only display updates while flushing resets and completed content immediately. */
export function useStreamText(
  source: () => string,
  streaming: () => boolean,
  interval = 50,
) {
  const text = shallowRef(source())
  let timer: ReturnType<typeof setTimeout> | undefined
  function flush(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    text.value = source()
  }
  watch(
    [source, streaming],
    ([value, live]) => {
      if (!live || !value.startsWith(text.value)) flush()
      else if (timer === undefined) timer = setTimeout(flush, interval)
    },
    { flush: 'sync' },
  )
  onScopeDispose(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
  return text
}
