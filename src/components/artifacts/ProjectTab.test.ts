// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../../shared/agent-api'
import type {
  CodeBackendStatus,
  ProjectMetadataSnapshot,
  ProjectModel,
  ProjectModule,
} from '../../../shared/project-model'
import { i18n, setAppLocale } from '../../i18n'
import { useAgentStore } from '../../stores/agent'
import ProjectTab from './ProjectTab.vue'

const workspace = 'F:/workspace/project'
const timestamp = '2026-06-28T00:00:00.000Z'

function projectModule(overrides: Partial<ProjectModule> = {}): ProjectModule {
  return {
    id: 'frontend',
    root: '.',
    name: 'frontend',
    languages: ['typescript'],
    manifests: ['package.json'],
    sourceRoots: ['src'],
    testRoots: [],
    excludedRoots: ['node_modules'],
    backendHints: ['serena'],
    source: 'user-set',
    confidence: 0.9,
    fingerprint: 'fingerprint',
    updatedAt: timestamp,
    ...overrides,
  }
}

function projectModel(
  modules: ProjectModule[] = [projectModule()],
): ProjectModel {
  return {
    schemaVersion: 1,
    workspaceRoot: workspace,
    modules,
    defaultModuleId: modules[0]?.id,
    storage: 'project-local',
    backendBindings: [
      {
        id: 'serena:typescript',
        language: 'typescript',
        backendId: 'serena',
        backendKind: 'serena-mcp',
        enabled: false,
        capabilities: ['symbol_overview', 'definition', 'references'],
        configuredBy: 'user',
        updatedAt: timestamp,
      },
    ],
    serena: {
      id: 'serena',
      enabled: false,
      command: 'serena',
      args: [
        'start-mcp-server',
        '--context',
        'ide-assistant',
        '--project',
        '${workspace}',
      ],
      startupTimeoutMs: 15_000,
      toolTimeoutMs: 30_000,
      languages: ['typescript'],
    },
    updatedAt: timestamp,
  }
}

function snapshot(
  project = projectModel(),
  gitIgnoreRecommended = true,
): ProjectMetadataSnapshot {
  return {
    project,
    path: '.zch/project-model.json',
    gitIgnoreRecommended,
  }
}

function readyStatus(): CodeBackendStatus {
  return {
    backendId: 'serena',
    backendKind: 'serena-mcp',
    state: 'ready',
    capabilities: ['symbol_overview', 'definition', 'references'],
    message: 'Serena backend is ready.',
    updatedAt: timestamp,
  }
}

function projectApi(overrides: Partial<AgentApi> = {}) {
  const api = {
    getProject: vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: snapshot(),
    })),
    saveProject: vi.fn(
      async (payload: Parameters<AgentApi['saveProject']>[0]) => ({
        version: 1 as const,
        ok: true as const,
        value: snapshot(payload.project),
      }),
    ),
    detectProjectModules: vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: {
        modules: [
          projectModule({
            id: 'api',
            root: 'api',
            name: 'api',
            source: 'detected',
          }),
        ],
      },
    })),
    getProjectBackendStatus: vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: { statuses: [readyStatus()] },
    })),
    restartProjectBackend: vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      value: readyStatus(),
    })),
    ...overrides,
  } satisfies Partial<AgentApi>

  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: api as AgentApi,
  })
  return api
}

function bodyButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

async function mountProjectTab() {
  const pinia = createPinia()
  const agent = useAgentStore(pinia)
  agent.workspacePath = workspace
  const wrapper = mount(ProjectTab, {
    attachTo: document.body,
    global: {
      plugins: [pinia, i18n],
    },
  })
  await flushPromises()
  return wrapper
}

describe('ProjectTab', () => {
  beforeEach(() => {
    setAppLocale('en-US')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      })),
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    Reflect.deleteProperty(window, 'agentApi')
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('shows modules, backend health, and .zch gitignore guidance', async () => {
    projectApi()

    const wrapper = await mountProjectTab()

    expect(wrapper.text()).toContain('Project modules')
    expect(wrapper.text()).toContain('.zch/project-model.json')
    expect(wrapper.text()).toContain('frontend')
    expect(wrapper.text()).toContain('user-set')
    expect(wrapper.text()).toContain('Serena MCP backend')
    expect(wrapper.text()).toContain('ready')
    expect(wrapper.text()).toContain('Consider adding .zch/')
  })

  it('previews detected modules and saves them as project metadata', async () => {
    const api = projectApi({
      getProject: vi.fn(async () => ({
        version: 1 as const,
        ok: true as const,
        value: snapshot(projectModel([]), false),
      })),
    })
    const wrapper = await mountProjectTab()

    bodyButton('Detect again').click()
    await flushPromises()
    expect(wrapper.text()).toContain('Detected modules')
    expect(wrapper.text()).toContain('api')

    bodyButton('Use detected modules').click()
    await flushPromises()

    expect(api.saveProject).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace,
        project: expect.objectContaining({
          modules: [expect.objectContaining({ id: 'api', source: 'detected' })],
          defaultModuleId: 'api',
        }),
      }),
    )
  })
})
