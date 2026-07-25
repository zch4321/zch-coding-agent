// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import { useTraceStore } from './traces'

const ok = (value: unknown) => ({ version: 1, ok: true, value }) as never

function installApi(api: Partial<AgentApi>) {
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: api as AgentApi,
  })
}

describe('trace transcript store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
  })

  it('resolves a conversation trace and appends paginated entries', async () => {
    const listTraces = vi.fn(async () =>
      ok([
        {
          traceId: 'session-1',
          sessionId: 'session-1',
          closed: true,
          size: 100,
          eventCount: 2,
        },
      ]),
    )
    const getSessionTranscriptPage = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          metadata: {
            traceId: 'session-1',
            revision: 'revision',
            lastSeq: 2,
            active: false,
          },
          total: 2,
          entries: [
            {
              id: 'event-1:user',
              seq: 1,
              ts: '2026-07-12T00:00:00.000Z',
              kind: 'user',
              categories: ['user'],
              title: 'User message',
              text: 'hello',
            },
          ],
          nextCursor: 'next',
        }),
      )
      .mockResolvedValueOnce(
        ok({
          metadata: {
            traceId: 'session-1',
            revision: 'revision',
            lastSeq: 2,
            active: false,
          },
          total: 2,
          entries: [
            {
              id: 'event-2:assistant',
              seq: 2,
              ts: '2026-07-12T00:00:01.000Z',
              kind: 'assistant',
              categories: ['assistant'],
              title: 'Assistant message',
              text: 'done',
            },
          ],
        }),
      )
    installApi({
      listTraces,
      getTraceStats: vi.fn(async () => ok({})),
      getSessionTranscriptPage,
    })

    const store = useTraceStore()
    await store.openSessionTranscript('session-1')
    expect(store.transcriptOpen).toBe(true)
    expect(store.transcriptEntries.map((entry) => entry.text)).toEqual([
      'hello',
    ])
    await store.loadTranscript(false)
    expect(store.transcriptEntries.map((entry) => entry.text)).toEqual([
      'hello',
      'done',
    ])
    expect(getSessionTranscriptPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'next' }),
    )
  })

  it('shows an explicit unavailable state instead of fabricating history', async () => {
    installApi({
      listTraces: vi.fn(async () => ok([])),
      getTraceStats: vi.fn(async () => ok({})),
    })
    const store = useTraceStore()
    await store.openSessionTranscript('session-missing')
    expect(store.transcriptOpen).toBe(true)
    expect(store.transcriptTraceId).toBeUndefined()
    expect(store.transcriptUnavailable).toBe(true)
  })

  it('loads provider request pages and delegates export to the main process', async () => {
    const getSessionTranscriptRequestMessages = vi.fn(async () =>
      ok({
        traceId: 'session-1',
        revision: 'revision',
        requestEventId: 'event-request',
        total: 1,
        messages: [{ role: 'system', content: 'system' }],
      }),
    )
    const exportSessionTranscript = vi.fn(async () =>
      ok({ canceled: false, path: 'F:/out/transcript.md' }),
    )
    installApi({
      getSessionTranscriptRequestMessages,
      exportSessionTranscript,
    })
    const store = useTraceStore()
    store.transcriptTraceId = 'session-1'
    await store.loadTranscriptRequest('event-request')
    expect(store.transcriptRequests['event-request']?.messages).toEqual([
      { role: 'system', content: 'system' },
    ])
    await store.exportTranscript()
    expect(exportSessionTranscript).toHaveBeenCalledWith({
      version: 1,
      traceId: 'session-1',
    })
  })
})
