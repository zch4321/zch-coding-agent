import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import {
  IPC_CONTRACTS,
  type IpcChannel,
  type IpcPayload,
} from '../../shared/ipc-contract'
import type { CallId, RunId, SessionId, TerminalId } from '../../shared/ids'
import { handleIpcInvocation, registerIpcHandlers } from './index'

const sessionId = 'session-1' as SessionId
const runId = 'run-1' as RunId
const callId = 'call-1' as CallId
const terminalId = 'terminal-1' as TerminalId

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
  'provider:list-models': { version: 1, refresh: false },
  'workbench:get': { version: 1 },
  'workbench:save': {
    version: 1,
    workbench: { projects: [], conversations: [] },
  },
  'workbench:migrate-v1': {
    version: 1,
    workbench: { projects: [], conversations: [] },
  },
  'workbench:export-conversation': {
    version: 1,
    markdown: '# Exported conversation',
    suggestedName: 'conversation.md',
  },
  'workbench:import-conversation': { version: 1 },
  'workspace:choose': { version: 1 },
  'workspace:list-directory': {
    version: 1,
    workspace: 'F:/workspace',
    path: '.',
  },
  'workspace:read-file': {
    version: 1,
    workspace: 'F:/workspace',
    path: 'README.md',
  },
  'workspace:choose-context': {
    version: 1,
    workspace: 'F:/workspace',
    kind: 'file',
  },
  'session:create': {
    version: 1,
    conversationId: 'conversation-1',
    workspace: 'F:/workspace',
    mode: 'readonly',
    provider: 'deepseek',
  },
  'session:close': { version: 1, sessionId },
  'changes:list': {
    version: 1,
    conversationId: 'conversation-1',
    workspace: 'F:/workspace',
  },
  'changes:revert': {
    version: 1,
    id: 'change-1',
    conversationId: 'conversation-1',
    workspace: 'F:/workspace',
  },
  'session:update-mode': { version: 1, sessionId, mode: 'auto' },
  'run:start': {
    version: 1,
    sessionId,
    message: 'hello',
    clientRequestId: 'request-1',
  },
  'run:interrupt': {
    version: 1,
    sessionId,
    runId,
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
  'trace:stats': { version: 1 },
  'trace:fork': {
    version: 1,
    traceId: 'session-test',
    eventId: 'event-1' as import('../../shared/ids').EventId,
  },
  'trace:start-fork': { version: 1, sessionId },
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
})
