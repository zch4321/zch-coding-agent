// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, type Component } from 'vue'
import { NTree } from 'naive-ui'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../../shared/agent-api'
import type { ProjectId } from '../../../shared/ids'
import { i18n } from '../../i18n'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useWorkspaceFilesStore } from '../../stores/workspace-files'
import FilesTab from './FilesTab.vue'
import DiffTab from './DiffTab.vue'

const projectA = 'project:a' as ProjectId
const projectB = 'project:b' as ProjectId
const workspace = (id: ProjectId) =>
  id === projectA ? '/workspace/a' : '/workspace/b'
function success<T>(value: T) {
  return { version: 1 as const, ok: true as const, value }
}

function bridge(
  beforeRead: (id: ProjectId) => Promise<void> = async () => undefined,
) {
  const listWorkspaceDirectory = vi.fn<AgentApi['listWorkspaceDirectory']>(
    async ({ projectId }) => {
      await beforeRead(projectId)
      return success({
        workspace: workspace(projectId),
        path: '.',
        entries: [
          { type: 'file', name: `${projectId}.ts`, path: `${projectId}.ts` },
        ],
        truncated: false,
      })
    },
  )
  const getGitReviewStatus = vi.fn<AgentApi['getGitReviewStatus']>(
    async ({ projectId }) => {
      await beforeRead(projectId)
      return success({
        repository: true,
        workspace: workspace(projectId),
        headRef: `branch-${projectId}`,
        detached: false,
        unborn: false,
        baseRefs: [],
        entries: [],
        truncated: false,
      })
    },
  )
  const getGitReviewDiff = vi.fn<AgentApi['getGitReviewDiff']>(async () =>
    success({
      mode: 'head',
      content: '',
      totalBytes: 0,
      truncated: false,
      binary: false,
    }),
  )
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: {
      listWorkspaceDirectory,
      getGitReviewStatus,
      getGitReviewDiff,
    } as Partial<AgentApi>,
  })
  return { listWorkspaceDirectory, getGitReviewStatus, getGitReviewDiff }
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }))
  setActivePinia(createPinia())
  const replica = useAgentReplicaStore()
  replica.projects = [projectA, projectB].map((id) => ({
    schemaVersion: 1,
    id,
    path: workspace(id),
    name: id,
    revision: 1,
    createdAt: '2026-09-11T00:00:00.000Z',
    updatedAt: '2026-09-11T00:00:00.000Z',
  }))
  replica.selectedProjectId = projectA
})
afterEach(() => {
  Reflect.deleteProperty(window, 'agentApi')
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each([
  ['Files', FilesTab],
  ['Diff', DiffTab],
] as const)('%s workspace refresh', (name, component: Component) => {
  it('skips other projects and hidden panels, coalescing visible changes and resuming once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const api = bridge()
    const query =
      name === 'Files' ? api.listWorkspaceDirectory : api.getGitReviewStatus
    const files = useWorkspaceFilesStore()
    const wrapper = mount(component, {
      props: { active: false },
      global: { plugins: [i18n] },
    })
    try {
      files.markDirty(projectA)
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000)
      expect(query).not.toHaveBeenCalled()
      await wrapper.setProps({ active: true })
      await flushPromises()
      expect(query).toHaveBeenCalledTimes(1)
      files.markDirty(projectB)
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000)
      expect(query).toHaveBeenCalledTimes(1)
      files.markDirty(projectA)
      await nextTick()
      files.markDirty(projectA)
      await nextTick()
      await vi.advanceTimersByTimeAsync(150)
      await flushPromises()
      expect(query).toHaveBeenCalledTimes(2)
      await wrapper.setProps({ active: false })
      for (let index = 0; index < 5; index += 1) files.markDirty(projectA)
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000)
      expect(query).toHaveBeenCalledTimes(2)
      await wrapper.setProps({ active: true })
      await flushPromises()
      expect(query).toHaveBeenCalledTimes(3)
    } finally {
      wrapper.unmount()
    }
  })

  it('invalidates old responses when switching projects while hidden', async () => {
    let finishOld!: () => void
    const oldRead = new Promise<void>((resolve) => {
      finishOld = resolve
    })
    const api = bridge((id) => (id === projectA ? oldRead : Promise.resolve()))
    const query =
      name === 'Files' ? api.listWorkspaceDirectory : api.getGitReviewStatus
    const wrapper = mount(component, { global: { plugins: [i18n] } })
    try {
      await flushPromises()
      expect(query).toHaveBeenCalledTimes(1)
      await wrapper.setProps({ active: false })
      useAgentReplicaStore().selectedProjectId = projectB
      await nextTick()
      expect(query).toHaveBeenCalledTimes(1)
      await wrapper.setProps({ active: true })
      await flushPromises()
      expect(query).toHaveBeenCalledTimes(2)
      const view = () =>
        name === 'Files'
          ? JSON.stringify(wrapper.findComponent(NTree).props('data'))
          : wrapper.text()
      expect(view()).toContain(projectB)
      finishOld()
      await flushPromises()
      expect(view()).toContain(projectB)
      expect(view()).not.toContain(projectA)
    } finally {
      finishOld()
      wrapper.unmount()
    }
  })
})
