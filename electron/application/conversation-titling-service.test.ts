import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/agent-events'
import type { MessageId, RunId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { ConfigStore } from '../config/store'
import type { ModelProvider, ProviderEvent } from '../providers/provider'
import { PromptRegistry } from '../prompts/registry'
import { RuntimeEventBus } from '../runtime/runtime-event-bus'
import {
  ConversationTitlingService,
  sanitizeModelTitle,
} from './conversation-titling-service'
import type { SessionService } from './session-service'

const sessionId = 'session:titling' as SessionId
const runId = 'run:titling' as RunId

const titlingResource = {
  id: 'titling.conversation-title.zh-CN',
  version: 'test',
  path: 'test',
  content: '给会话起一个短标题。',
  sha256: '0'.repeat(64),
}

class FakeProvider {
  readonly providerType = 'generic.chat-completions'
  readonly requests: string[] = []

  constructor(private readonly responder: () => string) {}

  compile(input: { history: { messages: MessageRecord[] } }) {
    const part = input.history.messages[0]?.parts[0]
    this.requests.push(part?.type === 'text' ? part.text : '')
    return { request: {}, normalizedMessages: [] } as never
  }

  async *stream(): AsyncIterable<ProviderEvent> {
    const answer = this.responder()
    yield { type: 'text.delta', delta: answer } as ProviderEvent
    yield {
      type: 'completed',
      turn: { parts: [{ type: 'text', text: answer }] },
    } as ProviderEvent
  }

  compactModes(): readonly never[] {
    return []
  }

  compileCompact(): never {
    throw new Error('not implemented')
  }

  compact(): never {
    throw new Error('not implemented')
  }
}

function userMessage(text: string): MessageRecord {
  return {
    schemaVersion: 1,
    id: 'message:user' as MessageId,
    sessionId,
    seq: 1,
    visibility: 'visible',
    turnId: 'message:user' as MessageId,
    inHistory: true,
    createdAt: '2026-08-16T00:00:00.000Z',
    kind: 'user_input',
    clientRequestId: 'request:1',
    parts: [{ type: 'text', text }],
    metadata: { schemaVersion: 1, submission: { type: 'message' } },
  } as MessageRecord
}

function assistantMessage(text: string): MessageRecord {
  return {
    schemaVersion: 1,
    id: 'message:assistant' as MessageId,
    sessionId,
    seq: 2,
    visibility: 'visible',
    turnId: 'message:user' as MessageId,
    inHistory: true,
    createdAt: '2026-08-16T00:00:01.000Z',
    kind: 'assistant_turn',
    parts: [{ type: 'text', text }],
  } as MessageRecord
}

function harness(input: {
  titleSource?: 'auto' | 'user' | 'model'
  recordMissing?: boolean
  messages?: MessageRecord[]
  responder?: () => string
  noRoute?: boolean
}) {
  const bus = new RuntimeEventBus()
  const provider = new FakeProvider(input.responder ?? (() => '修复终端竞态'))
  const createProvider = vi.fn(() => provider as unknown as ModelProvider)
  const applied: string[] = []
  const diagnostics: string[] = []
  const sessions = {
    getRecord: async () => {
      if (input.recordMissing) throw new Error('NOT_FOUND')
      return { titleSource: input.titleSource ?? 'auto' }
    },
    listAllMessages: async () =>
      input.messages ?? [
        userMessage('修复 Windows 终端尺寸调整的竞态问题'),
        assistantMessage('已在 pool.ts 中修复……'),
      ],
    applyModelTitle: async ({ title }: { title: string }) => {
      applied.push(title)
      return true
    },
  } as unknown as SessionService
  const service = new ConversationTitlingService({
    configStore: {
      getPublicConfig: () => ({ assistant: { language: 'zh-CN' } }),
    } as unknown as ConfigStore,
    sessions,
    prompts: PromptRegistry.fromResources([titlingResource]),
    events: bus,
    resolveRoute: async () => (input.noRoute ? undefined : ({} as never)),
    createProvider,
    onDiagnostic: (message, error) => {
      diagnostics.push(`${message}: ${String(error)}`)
    },
  })
  return { bus, provider, createProvider, applied, diagnostics, service }
}

function completedEvent(seq: number): AgentEvent {
  return {
    schemaVersion: 1,
    seq,
    ts: new Date().toISOString(),
    type: 'run.status',
    sessionId,
    runId,
    status: 'completed',
  } as AgentEvent
}

describe('sanitizeModelTitle', () => {
  it('takes the first non-empty line and strips decoration', () => {
    expect(sanitizeModelTitle('"Fix login bug"\n')).toBe('Fix login bug')
    expect(sanitizeModelTitle('标题：修复登录缺陷')).toBe('修复登录缺陷')
    expect(sanitizeModelTitle('\n\n- Add dark mode toggle。\nignored')).toBe(
      'Add dark mode toggle',
    )
  })

  it('rejects empty output and caps length', () => {
    expect(sanitizeModelTitle('')).toBeUndefined()
    expect(sanitizeModelTitle('  \n "" \n')).toBeUndefined()
    expect(sanitizeModelTitle('x'.repeat(200))).toHaveLength(120)
  })
})

describe('ConversationTitlingService', () => {
  it('titles an auto-titled Session after its first completed run', async () => {
    const { bus, provider, applied, diagnostics, service } = harness({})

    bus.publishAgent(completedEvent(1))
    await service.settle()

    expect(diagnostics).toEqual([])
    expect(applied).toEqual(['修复终端竞态'])
    expect(provider.requests[0]).toContain(
      '修复 Windows 终端尺寸调整的竞态问题',
    )
    expect(provider.requests[0]).toContain('已在 pool.ts 中修复')
  })

  it('never attempts a Session twice in one process', async () => {
    const { bus, createProvider, service } = harness({})

    bus.publishAgent(completedEvent(1))
    bus.publishAgent(completedEvent(2))
    await service.settle()

    expect(createProvider).toHaveBeenCalledTimes(1)
  })

  it('skips user-managed or already model-titled Sessions', async () => {
    for (const titleSource of ['user', 'model'] as const) {
      const { bus, createProvider, applied, service } = harness({
        titleSource,
      })
      bus.publishAgent(completedEvent(1))
      await service.settle()
      expect(createProvider).not.toHaveBeenCalled()
      expect(applied).toEqual([])
    }
  })

  it('skips sessions the public repository does not expose', async () => {
    const { bus, createProvider, service } = harness({ recordMissing: true })

    bus.publishAgent(completedEvent(1))
    await service.settle()

    expect(createProvider).not.toHaveBeenCalled()
  })

  it('stays silent when no light pool route is available', async () => {
    const { bus, createProvider, applied, service } = harness({
      noRoute: true,
    })

    bus.publishAgent(completedEvent(1))
    await service.settle()

    expect(createProvider).not.toHaveBeenCalled()
    expect(applied).toEqual([])
  })

  it('keeps the derived title when the provider fails or answers garbage', async () => {
    const failing = harness({
      responder: () => {
        throw new Error('network down')
      },
    })
    failing.bus.publishAgent(completedEvent(1))
    await failing.service.settle()
    expect(failing.applied).toEqual([])

    const garbage = harness({ responder: () => '  \n  ' })
    garbage.bus.publishAgent(completedEvent(1))
    await garbage.service.settle()
    expect(garbage.applied).toEqual([])
  })
})
