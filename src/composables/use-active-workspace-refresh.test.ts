import { effectScope, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectId } from '../../shared/ids'
import { useActiveWorkspaceRefresh } from './use-active-workspace-refresh'

afterEach(() => vi.useRealTimers())

describe('visible workspace refresh scheduling', () => {
  it('coalesces changes behind an active request and cancels deferred work on disposal', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const scope = effectScope()
    const revision = ref(0)
    const completions: Array<() => void> = []
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => completions.push(resolve)),
    )
    scope.run(() =>
      useActiveWorkspaceRefresh({
        active: () => true,
        projectId: () => 'project:a' as ProjectId,
        workspace: () => '/a',
        revision: () => revision.value,
        refresh,
        onError: vi.fn(),
      }),
    )
    try {
      revision.value += 1
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000)
      expect(refresh).toHaveBeenCalledTimes(1)
      completions[0]!()
      await flushPromises()
      revision.value += 1
      await nextTick()
      await vi.advanceTimersByTimeAsync(150)
      expect(refresh).toHaveBeenCalledTimes(2)
      completions[1]!()
      await flushPromises()
      revision.value += 1
      await nextTick()
      scope.stop()
      await vi.advanceTimersByTimeAsync(1000)
      expect(refresh).toHaveBeenCalledTimes(2)
    } finally {
      scope.stop()
      completions.forEach((complete) => complete())
      await flushPromises()
    }
  })

  it('does not block a new project on an old request or report the old project failure', async () => {
    const scope = effectScope()
    const project = ref('project:a' as ProjectId)
    let rejectOld!: (error: Error) => void
    const refresh = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectOld = reject
          }),
      )
      .mockResolvedValue(undefined)
    const onError = vi.fn()
    scope.run(() =>
      useActiveWorkspaceRefresh({
        active: () => true,
        projectId: () => project.value,
        workspace: () => '/workspace',
        revision: () => 0,
        refresh,
        onError,
      }),
    )
    try {
      project.value = 'project:b' as ProjectId
      await nextTick()
      expect(refresh).toHaveBeenCalledTimes(2)
      rejectOld(new Error('old project'))
      await flushPromises()
      expect(onError).not.toHaveBeenCalled()
    } finally {
      scope.stop()
    }
  })
})
