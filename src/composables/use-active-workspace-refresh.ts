import { onScopeDispose, watch } from 'vue'
import type { ProjectId } from '../../shared/ids'

/** Coalesces visible workspace refreshes and serializes requests within each project view. */
export function useActiveWorkspaceRefresh(options: {
  active: () => boolean
  projectId: () => ProjectId | undefined
  workspace: () => string
  revision: () => number
  refresh: () => Promise<void>
  onError: (error: unknown) => void
}): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let busy = false
  let dirty = true
  let disposed = false
  const available = () =>
    !disposed &&
    options.active() &&
    Boolean(options.projectId() && options.workspace())
  const clear = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const schedule = () => {
    if (!available() || busy || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void run()
    }, 150)
  }
  const run = async () => {
    if (!available() || busy || !dirty) return
    clear()
    dirty = false
    busy = true
    const current = generation
    try {
      await options.refresh()
    } catch (error) {
      if (current === generation && !disposed) options.onError(error)
    } finally {
      if (current === generation && !disposed) {
        busy = false
        if (dirty) schedule()
      }
    }
  }
  watch(
    [
      options.projectId,
      options.workspace,
      options.active,
      options.revision,
    ] as const,
    (next, previous) => {
      const changedProject =
        next[0] !== previous?.[0] || next[1] !== previous?.[1]
      if (changedProject) {
        generation += 1
        busy = false
        clear()
      }
      dirty = true
      if (!available()) {
        clear()
        return
      }
      if (changedProject || !previous?.[2]) void run()
      else schedule()
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    disposed = true
    generation += 1
    clear()
  })
}
