import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '../../shared/json'
import type { CallId, FileChangeId } from '../../shared/ids'
import type {
  LLMProvider,
  ProviderChatRequest,
  ProviderEvent,
} from '../providers/provider'
import { PromptRegistry } from '../prompts/registry'
import type {
  FileChangeExecutionPort,
  PreparedFileChange,
} from './file-change-execution'
import { SessionManager } from './session-manager'
import {
  createConfig,
  createIpcTestEventSink,
} from './session-manager-test-support'

class DeferredReadProvider implements LLMProvider {
  readonly entered: Promise<void>
  #resolveEntered!: () => void
  #release!: () => void
  readonly #released: Promise<void>
  calls = 0

  constructor() {
    this.entered = new Promise((resolve) => {
      this.#resolveEntered = resolve
    })
    this.#released = new Promise((resolve) => {
      this.#release = resolve
    })
  }

  continue(): void {
    this.#release()
  }

  async *streamChat(): AsyncIterable<ProviderEvent> {
    this.calls += 1
    if (this.calls === 1) {
      this.#resolveEntered()
      await this.#released
      yield toolCompletion('read_file', { path: 'README.md' })
      return
    }
    yield finalCompletion()
  }
}

class CreateWarningProvider implements LLMProvider {
  calls = 0
  readonly requests: ProviderChatRequest['messages'][] = []

  async *streamChat(
    request: ProviderChatRequest,
  ): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.messages))
    if (this.calls === 1) {
      yield toolCompletion('create_file', {
        path: 'warning.txt',
        content: 'mutation survives history failure',
      })
      return
    }
    yield finalCompletion()
  }
}

describe('SessionManager durable FileChange port', () => {
  it('freezes the FileChange byte budget at Run start', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-file-change-limit-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'README.md'), 'frozen limit')
    const configStore = await createConfig(directory)
    const provider = new DeferredReadProvider()
    const prepareMutation = vi.fn(async () => undefined)
    const manager = await createManager({
      directory,
      configStore,
      provider,
      fileChangeExecution: {
        prepareMutation,
        commitMutation: vi.fn(),
      },
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Read the fixture',
      clientRequestId: 'request:frozen-file-change-limit',
    })
    await provider.entered
    await configStore.update({
      version: 1,
      kind: 'limits',
      value: {
        ...configStore.getPublicConfig().limits,
        fileChangeHistoryBytes: 1_000_000,
      },
    })
    provider.continue()
    await manager.waitForRunSettled(sessionId, runId)

    expect(prepareMutation).toHaveBeenCalledWith(
      expect.objectContaining({ maximumPayloadBytes: 100_000_000 }),
    )
    await manager.closeSession(sessionId)
  })

  it('keeps successful file I/O truthful when durable history persistence fails', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-file-change-warning-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(workspace)
    const configStore = await createConfig(directory)
    const provider = new CreateWarningProvider()
    const fileChangeExecution: FileChangeExecutionPort = {
      async prepareMutation(input) {
        return {
          id: 'file-change:warning' as FileChangeId,
          sessionId: input.sessionId,
          callId: input.approvedCall.callId,
          path: 'warning.txt',
          operation: 'write',
          diff: input.diff,
          diffHash: input.approvedCall.diffHash!,
          diffTruncated: false,
          beforeExists: false,
          beforeHash:
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          beforeContent: null,
          afterExists: true,
          afterHash:
            input.approvedCall.resourcePreconditions[0]!.expectedResultHash!,
          payloadBytes: Buffer.byteLength(input.diff, 'utf8'),
          maximumPayloadBytes: input.maximumPayloadBytes,
        } satisfies PreparedFileChange
      },
      async commitMutation() {
        return {
          status: 'warning',
          warningCode: 'CHANGE_HISTORY_PERSIST_FAILED',
        }
      },
    }
    const manager = await createManager({
      directory,
      configStore,
      provider,
      fileChangeExecution,
    })
    const sessionId = await manager.createSession({
      workspace,
      mode: 'auto',
      provider: 'deepseek',
    })
    const runId = manager.startRun({
      sessionId,
      message: 'Create the warning fixture',
      clientRequestId: 'request:file-change-warning',
    })
    await manager.waitForRunSettled(sessionId, runId)

    expect(await readFile(path.join(workspace, 'warning.txt'), 'utf8')).toBe(
      'mutation survives history failure',
    )
    expect(JSON.stringify(provider.requests[1])).toContain(
      'CHANGE_HISTORY_PERSIST_FAILED',
    )
    expect(JSON.stringify(provider.requests[1])).toContain(
      '\\"mutationSucceeded\\":true',
    )
    expect(JSON.stringify(provider.requests[1])).toContain(
      '\\"revertAvailable\\":false',
    )
    await manager.closeSession(sessionId)
  })
})

async function createManager(input: {
  directory: string
  configStore: Awaited<ReturnType<typeof createConfig>>
  provider: LLMProvider
  fileChangeExecution: FileChangeExecutionPort
}) {
  return new SessionManager({
    configStore: input.configStore,
    traceDirectory: path.join(input.directory, 'traces'),
    eventSink: createIpcTestEventSink(() => undefined),
    providerFactory: () => input.provider,
    promptRegistry: await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    ),
    fileChangeExecution: input.fileChangeExecution,
  })
}

function toolCompletion(
  toolId: string,
  args: Record<string, string>,
): Extract<ProviderEvent, { type: 'completed' }> {
  const callId = `call:${toolId}` as CallId
  return {
    type: 'completed',
    rawResponse: { id: `response:${toolId}` },
    turn: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: toolId, arguments: JSON.stringify(args) },
        },
      ],
    },
    toolCalls: [
      {
        id: callId,
        toolId,
        args: args as JsonValue,
        reason: 'FileChange test fixture',
      },
    ],
    usage: {},
    providerState: {},
    timing: {},
  }
}

function finalCompletion(): Extract<ProviderEvent, { type: 'completed' }> {
  return {
    type: 'completed',
    rawResponse: { id: 'response:final' },
    turn: { role: 'assistant', content: 'Done' },
    toolCalls: [],
    usage: {},
    providerState: {},
    timing: {},
  }
}
