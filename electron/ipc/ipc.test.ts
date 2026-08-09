import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import {
  IPC_CONTRACTS,
  type IpcChannel,
  type IpcPayload,
} from '../../shared/ipc-contract'
import type {
  CallId,
  FileChangeId,
  AgentExecutionId,
  MessageId,
  ProjectId,
  RunId,
  SessionId,
  TerminalId,
} from '../../shared/ids'
import type { ProjectModel } from '../../shared/project-model'
import { handleIpcInvocation, registerIpcHandlers } from './index'

const sessionId = 'session-1' as SessionId
const runId = 'run-1' as RunId
const callId = 'call-1' as CallId
const terminalId = 'terminal-1' as TerminalId
const projectId = 'project-1' as ProjectId
const messageId = 'message-1' as MessageId
const fileChangeId = 'change-1' as FileChangeId
const agentExecutionId = 'subagent-1' as AgentExecutionId
const projectModel = {
  schemaVersion: 1,
  workspaceRoot: 'F:/workspace',
  modules: [],
  storage: 'project-local',
  backendBindings: [],
  serena: {
    id: 'serena',
    enabled: false,
    command: 'serena',
    context: 'ide-assistant',
    projectMode: 'workspacePath',
    openWebDashboard: false,
    extraArgs: [],
    startupTimeoutMs: 15_000,
    toolTimeoutMs: 30_000,
    languages: ['typescript', 'javascript'],
  },
  updatedAt: '2026-06-28T00:00:00.000Z',
} satisfies ProjectModel

function createEvent(options: {
  trusted?: boolean
  mainFrame?: boolean
  url?: string
}) {
  const frame = {
    url: options.url ?? 'app://bundle/index.html',
  } as WebFrameMain
  const trusted = {
    mainFrame: frame,
  } as WebContents
  const sender = options.trusted === false ? ({} as WebContents) : trusted
  const senderFrame =
    options.mainFrame === false ? ({ url: frame.url } as WebFrameMain) : frame

  return {
    event: { sender, senderFrame } as IpcMainInvokeEvent,
    trusted,
  }
}

const validPayloads: {
  [Channel in IpcChannel]: IpcPayload<Channel>
} = {
  'config:get': { version: 1, section: 'all' },
  'config:set': {
    version: 1,
    kind: 'workspace',
    lastOpened: 'F:/workspace',
  },
  'mcp:list': { version: 1 },
  'mcp:reload': { version: 1 },
  'mcp:trust-enable': {
    version: 1,
    serverId: 'github',
    fingerprint: 'a'.repeat(64),
  },
  'mcp:disable': { version: 1, serverId: 'github' },
  'mcp:restart': { version: 1, serverId: 'github' },
  'provider:list-models': { version: 1, refresh: false },
  'app:get-bootstrap': { version: 1 },
  'session:export-markdown': {
    version: 1,
    sessionId: 'session:one' as never,
    confirmed: true,
  },
  'project:list': { version: 1 },
  'project:add': { version: 1, path: 'F:/workspace' },
  'project:update': {
    version: 1,
    projectId,
    expectedRevision: 1,
    patch: { name: 'Workspace' },
  },
  'project:remove': { version: 1, projectId, expectedRevision: 1 },
  'session:list': { version: 1, projectId },
  'session:get': { version: 1, sessionId },
  'session:update': {
    version: 1,
    sessionId,
    expectedRevision: 1,
    patch: { title: 'Updated session' },
  },
  'session:archive': { version: 1, sessionId, expectedRevision: 1 },
  'session:restore': { version: 1, sessionId, expectedRevision: 1 },
  'session:delete': { version: 1, sessionId, expectedRevision: 1 },
  'session:fork': {
    version: 1,
    sourceSessionId: sessionId,
    expectedRevision: 1,
    sessionId: 'session-fork' as SessionId,
  },
  'session:rewind': {
    version: 1,
    sessionId,
    expectedRevision: 1,
    messageId,
    boundary: 'before_message',
  },
  'session:search': { version: 1, text: 'query' },
  'message:list': { version: 1, sessionId },
  'message:search': { version: 1, sessionId, text: 'query' },
  'file-change:list': { version: 1, sessionId },
  'file-change:revert': {
    version: 1,
    sessionId,
    fileChangeId,
    expectedRevision: 1,
  },
  'agent-execution:list': { version: 1, parentSessionId: sessionId },
  'agent-execution:get': {
    version: 1,
    parentSessionId: sessionId,
    executionId: agentExecutionId,
  },
  'workspace:choose': { version: 1 },
  'workspace:list-directory': {
    version: 1,
    projectId,
    path: '.',
  },
  'workspace:read-file': {
    version: 1,
    projectId,
    path: 'README.md',
  },
  'workspace:open-file': {
    version: 1,
    projectId,
    path: 'README.md',
  },
  'workspace:choose-context': {
    version: 1,
    projectId,
    kind: 'file',
  },
  'project:get': { version: 1, projectId },
  'project:save': {
    version: 1,
    projectId,
    project: projectModel,
  },
  'project:detect-modules': { version: 1, projectId },
  'project:backend-status': { version: 1, projectId },
  'project:restart-backend': {
    version: 1,
    projectId,
    backendId: 'serena',
  },
  'plan:update-status': {
    version: 1,
    sessionId,
    status: 'active',
  },
  'run:start': {
    version: 1,
    kind: 'existing_session',
    sessionId,
    message: 'hello',
    clientRequestId: 'request-1',
  },
  'run:retry': {
    version: 1,
    sessionId,
    expectedRevision: 1,
    userMessageId: messageId,
    clientRequestId: 'request-retry',
  },
  'run:interrupt': {
    version: 1,
    sessionId,
    runId,
  },
  'run:interject': {
    version: 1,
    sessionId,
    runId,
    message: 'supplementary info',
    clientRequestId: 'request-interject',
  },
  'approval:decide': {
    version: 1,
    sessionId,
    runId,
    callId,
    decision: 'deny',
  },
  'terminal:input': {
    version: 1,
    sessionId,
    terminalId,
    data: 'dir\r',
  },
  'terminal:open': { version: 1, sessionId, cols: 100, rows: 30 },
  'terminal:list': { version: 1, sessionId },
  'terminal:resize': {
    version: 1,
    sessionId,
    terminalId,
    cols: 120,
    rows: 40,
  },
  'terminal:close': { version: 1, sessionId, terminalId },
  'terminal:snapshot': { version: 1, sessionId, terminalId },
  'window:minimize': { version: 1 },
  'window:toggle-maximize': { version: 1 },
  'window:close': { version: 1 },
  'skills:list': { version: 1 },
  'skills:installFromUrl': {
    version: 1,
    url: 'https://example.com/skill.md',
  },
  'skills:chooseAndInstallFile': { version: 1 },
  'skills:refresh': { version: 1 },
  'skills:setEnabled': { version: 1, name: 'test-skill', enabled: true },
  'trace:list': { version: 1 },
  'trace:replay': { version: 1, traceId: 'session-test' },
  'trace:transcript-page': { version: 1, traceId: 'session-test' },
  'trace:request-messages': {
    version: 1,
    traceId: 'session-test',
    requestEventId: 'event-1' as import('../../shared/ids').EventId,
  },
  'trace:export-transcript': {
    version: 1,
    traceId: 'session-test',
    confirmed: true,
  },
  'trace:stats': { version: 1 },
  'logs:open-directory': { version: 1 },
  'logs:clear-closed': { version: 1 },
}

describe('IPC security registrar', () => {
  it('registers only the fixed contract channels', () => {
    const registered = new Map<string, unknown>()
    const removeHandler = vi.fn((channel: string) => registered.delete(channel))
    const dispose = registerIpcHandlers({
      ipcMain: {
        handle: (channel, listener) => {
          registered.set(channel, listener)
        },
        removeHandler,
      },
      getTrustedWebContents: () => undefined,
      isAllowedUrl: () => false,
    })

    expect([...registered.keys()].sort()).toEqual(
      Object.keys(IPC_CONTRACTS).sort(),
    )
    expect(registered.has('unknown:channel')).toBe(false)

    dispose()
    expect(removeHandler).toHaveBeenCalledTimes(
      Object.keys(IPC_CONTRACTS).length,
    )
  })

  it.each(Object.keys(validPayloads) as IpcChannel[])(
    'rejects a forged sender for %s',
    async (channel) => {
      const { event, trusted } = createEvent({ trusted: false })
      const result = await handleIpcInvocation(
        channel,
        event,
        validPayloads[channel],
        {
          getTrustedWebContents: () => trusted,
          isAllowedUrl: () => true,
        },
      )

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'INVALID_SENDER' },
      })
    },
  )

  it('rejects subframes, disallowed origins, and oversized payloads', async () => {
    const subframe = createEvent({ mainFrame: false })
    const subframeResult = await handleIpcInvocation(
      'skills:list',
      subframe.event,
      validPayloads['skills:list'],
      {
        getTrustedWebContents: () => subframe.trusted,
        isAllowedUrl: () => true,
      },
    )
    expect(subframeResult).toMatchObject({
      ok: false,
      error: { code: 'INVALID_SENDER' },
    })

    const origin = createEvent({ url: 'https://example.com' })
    const originResult = await handleIpcInvocation(
      'skills:list',
      origin.event,
      validPayloads['skills:list'],
      {
        getTrustedWebContents: () => origin.trusted,
        isAllowedUrl: () => false,
      },
    )
    expect(originResult).toMatchObject({
      ok: false,
      error: { code: 'INVALID_SENDER' },
    })

    const oversized = createEvent({})
    const oversizedResult = await handleIpcInvocation(
      'run:start',
      oversized.event,
      {
        ...validPayloads['run:start'],
        message: 'x'.repeat(100),
      },
      {
        getTrustedWebContents: () => oversized.trusted,
        isAllowedUrl: () => true,
        limits: {
          maxDepth: 10,
          maxSerializedBytes: 10,
          maxStringLength: 10,
          maxArrayLength: 10,
          maxObjectKeys: 10,
        },
      },
    )
    expect(oversizedResult).toMatchObject({
      ok: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    })

    const nonJsonResult = await handleIpcInvocation(
      'config:get',
      oversized.event,
      { version: 1, section: new Date() },
      {
        getTrustedWebContents: () => oversized.trusted,
        isAllowedUrl: () => true,
      },
    )
    expect(nonJsonResult).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PAYLOAD' },
    })
  })

  it('returns NOT_AVAILABLE for valid unimplemented requests', async () => {
    const { event, trusted } = createEvent({})
    const result = await handleIpcInvocation(
      'skills:list',
      event,
      validPayloads['skills:list'],
      {
        getTrustedWebContents: () => trusted,
        isAllowedUrl: () => true,
      },
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'NOT_AVAILABLE' },
    })
  })

  it.each([
    [
      'trace:export-transcript',
      { version: 1, traceId: 'session-test', confirmed: false },
    ],
    ['session:export-markdown', { version: 1, sessionId, confirmed: false }],
  ] as const)(
    'requires explicit renderer confirmation for %s',
    async (channel, payload) => {
      const { event, trusted } = createEvent({})
      const result = await handleIpcInvocation(channel, event, payload, {
        getTrustedWebContents: () => trusted,
        isAllowedUrl: () => true,
      })

      expect(result).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PAYLOAD' },
      })
    },
  )
})
