import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TRACE_NOTICE_VERSION } from '../../shared/notices'

const { openPath, showSaveDialog, writeTextAtomic } = vi.hoisted(() => ({
  openPath: vi.fn(),
  showSaveDialog: vi.fn(),
  writeTextAtomic: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {
    showSaveDialog,
    showOpenDialog: vi.fn(),
  },
  shell: { openPath },
}))

vi.mock('../config/atomic-file', () => ({ writeTextAtomic }))

import { createAppIpcHandlers } from './app-handlers'

const stubEvent = {} as never

function createHandlers(input?: {
  traceService?: Record<string, unknown>
  backend?: Record<string, unknown>
  sessions?: Record<string, unknown>
  configStore?: Record<string, unknown>
  commandShells?: Record<string, unknown>
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
      commandShells: input?.commandShells as never,
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
    openPath.mockReset()
    showSaveDialog.mockReset()
    writeTextAtomic.mockReset()
  })

  it('lists the Shell catalog for the persisted selection and forwards refresh', async () => {
    const resolved = {
      id: 'powershell-7',
      kind: 'powershell',
      label: 'PowerShell 7',
      executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      source: 'well-known',
    }
    const catalog = vi.fn(async () => ({
      selected: 'git-bash',
      resolved,
      fallback: true,
      profiles: [resolved],
    }))
    const { handlers } = createHandlers({
      configStore: {
        getPublicConfig: vi.fn(() => ({
          executionEnvironment: { commandShell: 'git-bash' },
        })),
      },
      commandShells: { catalog },
    })

    await expect(
      handlers['command-shell:list']!({ version: 1, refresh: true }, stubEvent),
    ).resolves.toMatchObject({ selected: 'git-bash', fallback: true })
    expect(catalog).toHaveBeenCalledWith('git-bash', true)
  })

  it('rejects legacy ProjectModel and code-intelligence IPC while disabled', async () => {
    const { handlers } = createHandlers()
    const projectId = 'project-disabled'
    const calls = [
      () =>
        handlers['project:get']!({ version: 1, projectId } as never, stubEvent),
      () =>
        handlers['project:save']!(
          { version: 1, projectId, project: {} } as never,
          stubEvent,
        ),
      () =>
        handlers['project:detect-modules']!(
          { version: 1, projectId } as never,
          stubEvent,
        ),
      () =>
        handlers['project:backend-status']!(
          { version: 1, projectId } as never,
          stubEvent,
        ),
      () =>
        handlers['project:restart-backend']!(
          { version: 1, projectId, backendId: 'serena' } as never,
          stubEvent,
        ),
    ]

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        error: { code: 'NOT_AVAILABLE' },
      })
    }
  })

  it('opens only guarded regular workspace files with an external application', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'agent-open-file-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'agent-open-outside-'))
    const target = path.join(workspace, 'README.md')
    const outsideTarget = path.join(outside, 'outside.md')
    await writeFile(target, 'workspace file\n')
    await writeFile(outsideTarget, 'outside file\n')
    const canonicalTarget = await realpath(target)
    openPath.mockResolvedValue('')
    const { handlers } = createHandlers({
      backend: {
        projects: {
          get: vi.fn(async () => ({ path: workspace })),
        },
      },
    })

    try {
      await expect(
        handlers['workspace:open-file']!(
          {
            version: 1,
            projectId: 'project-test',
            path: 'README.md',
          } as never,
          stubEvent,
        ),
      ).resolves.toEqual({ path: 'README.md' })
      expect(openPath).toHaveBeenCalledWith(canonicalTarget)

      await expect(
        handlers['workspace:open-file']!(
          {
            version: 1,
            projectId: 'project-test',
            path: outsideTarget,
          } as never,
          stubEvent,
        ),
      ).rejects.toMatchObject({
        error: { code: 'PRECONDITION_FAILED' },
      })
      expect(openPath).toHaveBeenCalledTimes(1)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('does not expose shell errors when no external application can open a file', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'agent-open-fail-'))
    await writeFile(path.join(workspace, 'README.md'), 'workspace file\n')
    openPath.mockResolvedValue('sensitive OS detail')
    const { handlers } = createHandlers({
      backend: {
        projects: {
          get: vi.fn(async () => ({ path: workspace })),
        },
      },
    })

    try {
      await expect(
        handlers['workspace:open-file']!(
          {
            version: 1,
            projectId: 'project-test',
            path: 'README.md',
          } as never,
          stubEvent,
        ),
      ).rejects.toMatchObject({
        error: {
          code: 'NOT_AVAILABLE',
          message: 'No external application could open this file',
        },
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
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

  it('exports a portable Session transcript without Provider continuation data', async () => {
    const filePath = 'F:/exports/session-conversation.md'
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    const getRecord = vi.fn(async () => ({
      id: 'session:export',
      title: 'Review: current/project',
    }))
    const listAllMessages = vi.fn(async () => [
      {
        schemaVersion: 1,
        id: 'message:system',
        sessionId: 'session:export',
        seq: 1,
        kind: 'system_instruction',
        parts: [{ type: 'text', text: 'SECRET SYSTEM' }],
        visibility: 'hidden',
        inHistory: true,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
      {
        schemaVersion: 1,
        id: 'message:user',
        sessionId: 'session:export',
        seq: 2,
        clientRequestId: 'request:export',
        turnId: 'message:user',
        kind: 'user_input',
        parts: [{ type: 'text', text: 'PORTABLE USER' }],
        metadata: {
          schemaVersion: 1,
          submission: { type: 'message' },
        },
        visibility: 'visible',
        inHistory: true,
        createdAt: '2026-08-08T00:00:01.000Z',
      },
      {
        schemaVersion: 1,
        id: 'message:assistant',
        sessionId: 'session:export',
        seq: 3,
        kind: 'assistant_turn',
        parts: [{ type: 'text', text: 'PORTABLE ASSISTANT' }],
        modelRoute: {
          schemaVersion: 2,
          purpose: 'main',
          providerType: 'openai.responses',
          providerId: 'openai',
          model: 'gpt-5.6',
          reasoning: 'high',
          endpoint: 'https://api.openai.com/v1/responses',
          providerConfigRevision: 1,
        },
        providerContinuation: {
          schemaVersion: 2,
          providerType: 'openai.responses',
          format: 'responses.output-items.v1',
          data: { encrypted_content: 'SECRET CONTINUATION' },
        },
        visibility: 'visible',
        inHistory: true,
        createdAt: '2026-08-08T00:00:02.000Z',
      },
    ])
    const { handlers } = createHandlers({
      backend: {
        sessions: { getRecord, listAllMessages },
      },
    })

    await expect(
      handlers['session:export-markdown']!(
        {
          version: 1,
          sessionId: 'session:export',
          confirmed: true,
        } as never,
        stubEvent,
      ),
    ).resolves.toEqual({ canceled: false, path: filePath })

    expect(getRecord).toHaveBeenCalledWith('session:export')
    expect(listAllMessages).toHaveBeenCalledWith('session:export')
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'Review_ current_project-conversation.md',
      }),
    )
    const markdown = writeTextAtomic.mock.calls[0]?.[1]
    expect(markdown).toContain('PORTABLE USER')
    expect(markdown).toContain('PORTABLE ASSISTANT')
    expect(markdown).not.toContain('SECRET SYSTEM')
    expect(markdown).not.toContain('SECRET CONTINUATION')
    expect(writeTextAtomic).toHaveBeenCalledWith(filePath, markdown)
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
