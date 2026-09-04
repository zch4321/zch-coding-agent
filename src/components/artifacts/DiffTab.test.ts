// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../../shared/agent-api'
import type { GitReviewDiff, GitReviewStatus } from '../../../shared/git-review'
import type { ProjectId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import DiffTab from './DiffTab.vue'

const projectId = 'project:git-review-component' as ProjectId
const timestamp = '2026-09-02T00:00:00.000Z'

function success<T>(value: T) {
  return { version: 1 as const, ok: true as const, value }
}

describe('Diff artifact Git Review', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setAppLocale('zh-CN')
    const replica = useAgentReplicaStore()
    replica.projects = [
      {
        schemaVersion: 1,
        id: projectId,
        path: '/workspace/project',
        name: 'project',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]
    replica.selectedProjectId = projectId
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('loads Project Git status and lazily requests the selected path diff', async () => {
    const status: GitReviewStatus = {
      repository: true,
      workspace: '/workspace/project',
      topLevel: '/workspace/project',
      headRef: 'feature/review',
      headOid: 'a'.repeat(40),
      upstreamRef: 'origin/main',
      detached: false,
      unborn: false,
      baseRefs: ['feature/review', 'origin/main'],
      entries: [
        {
          path: 'src/main.ts',
          indexStatus: ' ',
          worktreeStatus: 'M',
          kind: 'modified',
        },
      ],
      truncated: false,
    }
    const diff: GitReviewDiff = {
      mode: 'head',
      path: 'src/main.ts',
      content: '@@ -1 +1 @@\n-old\n+new\n',
      totalBytes: 24,
      truncated: false,
      binary: false,
    }
    const getGitReviewStatus = vi.fn(async () => success(status))
    const getGitReviewDiff = vi.fn(async () => success(diff))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        getGitReviewStatus,
        getGitReviewDiff,
      } as Partial<AgentApi> as AgentApi,
    })

    const wrapper = mount(DiffTab, { global: { plugins: [i18n] } })
    await vi.waitFor(() => expect(getGitReviewDiff).toHaveBeenCalledOnce())
    await flushPromises()

    expect(getGitReviewStatus).toHaveBeenCalledWith({
      version: 1,
      projectId,
    })
    expect(getGitReviewDiff).toHaveBeenCalledWith({
      version: 1,
      projectId,
      mode: 'head',
      path: 'src/main.ts',
    })
    expect(wrapper.text()).toContain('Git 变更')
    expect(wrapper.text()).toContain('feature/review')
    expect(wrapper.text()).toContain('src/main.ts')
    expect(wrapper.get('.diff-content').text()).toContain('+new')
    expect(wrapper.find('.diff-actions').exists()).toBe(false)
    wrapper.unmount()
  })
})
