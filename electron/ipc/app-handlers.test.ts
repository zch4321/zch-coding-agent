import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TRACE_NOTICE_VERSION } from '../../shared/notices'

const { showSaveDialog, writeTextAtomic } = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  writeTextAtomic: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {
    showSaveDialog,
    showOpenDialog: vi.fn(),
  },
  shell: { openPath: vi.fn() },
}))

vi.mock('../config/atomic-file', () => ({ writeTextAtomic }))

import { createAppIpcHandlers } from './app-handlers'

const stubEvent = {} as never

function createHandlers(input?: {
  traceService?: Record<string, unknown>
  backend?: Record<string, unknown>
  sessions?: Record<string, unknown>
  configStore?: Record<string, unknown>
}) {
  const sessions = {
    activeTraceIds: vi.fn(() => new Set<string>()),
    reconfigureTraceLogging: vi.fn(async () => []),
    ...input?.sessions,
  }
  const projects = {
    list: vi.fn(async () => []),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    get: vi.fn(),
  }
  const backend = {
    runtime: { services: { sessions } },
    bootstrap: vi.fn(),
    projects,
    sessions: {},
    fileChanges: {},
    runs: {},
    liveSessions: {},
    ...input?.backend,
  }
  const traceService = {
    transcriptDocument: vi.fn(),
    transcriptMarkdown: vi.fn(),
    ...input?.traceService,
  }

  return {
    handlers: createAppIpcHandlers({
      configStore: (input?.configStore ?? {}) as never,
      backend: backend as never,
      skillsManager: {} as never,
      traceService: traceService as never,
      projectMetadata: {} as never,
      codeBackends: {} as never,
      getMainWindow: () => undefined,
    }),
    backend,
    projects,
    sessions,
    traceService,
  }
}

describe('app IPC handlers', () => {
  beforeEach(() => {
    showSaveDialog.mockReset()
    writeTextAtomic.mockReset()
  })

  it('does not write a transcript when the save dialog is cancelled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true })
    const transcriptDocument = vi.fn(async () => ({
      metadata: { sessionId: 'session-test' },
    }))
    const transcriptMarkdown = vi.fn(async () => '# transcript')
    const { handlers } = createHandlers({
      traceService: { transcriptDocument, transcriptMarkdown },
    })

    await expect(
      handlers['trace:export-transcript']!(
        { version: 1, traceId: 'trace-test', confirmed: true },
        stubEvent,
      ),
    ).resolves.toEqual({ canceled: true })

    expect(transcriptDocument).toHaveBeenCalledWith('trace-test')
    expect(transcriptMarkdown).not.toHaveBeenCalled()
    expect(writeTextAtomic).not.toHaveBeenCalled()
  })

  it('passes domain list requests through to the durable project service', async () => {
    const records = [{ id: 'project-test' }]
    const list = vi.fn(async () => records)
    const { handlers } = createHandlers({
      backend: {
        projects: {
          list,
          add: vi.fn(),
          update: vi.fn(),
          remove: vi.fn(),
          get: vi.fn(),
        },
      },
    })

    await expect(
      handlers['project:list']!({ version: 1 }, stubEvent),
    ).resolves.toEqual({ version: 1, projects: records })
    expect(list).toHaveBeenCalledOnce()
  })

  it('reconfigures live Session captures after saving logging settings', async () => {
    const config = {
      privacy: {
        traceNoticeAccepted: {
          version: TRACE_NOTICE_VERSION,
          acceptedAt: '2026-07-25T00:00:00Z',
        },
      },
      logging: { enabled: true },
    }
    const update = vi.fn(async () => config)
    const reconfigureTraceLogging = vi.fn(async () => [
      'session-test: trace directory unavailable',
    ])
    const { handlers } = createHandlers({
      configStore: {
        getPublicConfig: vi.fn(() => config),
        update,
      },
      sessions: { reconfigureTraceLogging },
    })
    const payload = {
      version: 1,
      kind: 'logging',
      value: { enabled: true },
    } as const

    await expect(
      handlers['config:set']!(payload as never, stubEvent),
    ).resolves.toEqual({
      config,
      warnings: ['session-test: trace directory unavailable'],
    })
    expect(update).toHaveBeenCalledWith(payload)
    expect(reconfigureTraceLogging).toHaveBeenCalledWith(true)
  })
})
