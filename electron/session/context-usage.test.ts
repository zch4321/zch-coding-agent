import { describe, expect, it } from 'vitest'
import type { RunId } from '../../shared/ids'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import { messageFixtures } from '../persistence/repository-fixtures'
import {
  appendPromptMessage,
  appendProviderCompactSummary,
  type CanonicalHistoryState,
} from './canonical-history'
import {
  buildContextUsage,
  measureContextTools,
  type ContextUsageRecipe,
} from './context-usage'

const route: ModelRouteSnapshot = {
  schemaVersion: 2,
  purpose: 'main',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  reasoning: 'off',
  providerType: 'deepseek.chat-completions',
  endpoint: 'https://api.deepseek.com/chat/completions',
  providerConfigRevision: 1,
}
const recipe: ContextUsageRecipe = {
  runId: 'run:context' as RunId,
  route,
  tools: {
    bytes: 60,
    count: 1,
    entries: [{ id: 'read_file', kind: 'tool_definition', bytes: 60 }],
  },
}

function history(): CanonicalHistoryState {
  const records = messageFixtures()
  for (const record of records)
    if (record.kind === 'tool_result' && record.metadata)
      record.metadata.tool.resultProjection = 'model-content.v1'
  return {
    sessionId: records[0]!.sessionId,
    history: records,
    nextMessageSeq: 5,
  }
}

describe('current context accounting', () => {
  it('counts serialized UTF-8 bytes for multilingual text and escaped characters', () => {
    const record = messageFixtures()[0]!
    record.parts = [{ type: 'text', text: '中文🙂\n"quoted"' }]
    const snapshot = buildContextUsage([record], {
      ...recipe,
      tools: { bytes: 0, count: 0, entries: [] },
    })
    // The compiled user message includes JSON framing and escape sequences.
    const serialized = '[{"role":"user","content":"中文🙂\\n\\"quoted\\""}]'
    const bytes = Buffer.byteLength(serialized, 'utf8')
    expect(bytes).toBeGreaterThan(serialized.length)
    expect(snapshot.totalBytes).toBe(bytes)
    expect(
      snapshot.categories.find((group) => group.category === 'user'),
    ).toMatchObject({ bytes, count: 1, entries: [{ bytes }] })
  })

  it('partitions valid model-visible messages, assistant text and tool calls without including hidden history', () => {
    const state = history()
    for (const kind of [
      'system_instruction',
      'assistant_preferences',
      'agents_context',
      'selected_context',
      'runtime_context',
      'orchestrator',
    ] as const) {
      appendPromptMessage(state, {
        kind,
        content: `fixture ${kind}`,
        source: kind,
        trusted: false,
        editable: false,
      })
    }
    const ignored = appendPromptMessage(state, {
      kind: 'selected_context',
      content: 'OMITTED'.repeat(1000),
      source: 'omitted',
      trusted: false,
      editable: false,
    })
    ignored.inHistory = false
    const snapshot = buildContextUsage(state.history, recipe)
    expect(snapshot.categories.every((group) => group.bytes > 0)).toBe(true)
    expect(
      snapshot.categories.find((group) => group.category === 'system')?.count,
    ).toBe(3)
    expect(
      snapshot.categories.find((group) => group.category === 'user')?.count,
    ).toBe(2)
    expect(
      snapshot.categories.find((group) => group.category === 'toolCalls')
        ?.count,
    ).toBe(1)
    expect(snapshot.totalBytes).toBe(
      snapshot.categories.reduce((sum, group) => sum + group.bytes, 0),
    )
    expect(JSON.stringify(snapshot)).not.toContain('OMITTED')
    expect(
      snapshot.categories
        .flatMap((group) => group.entries)
        .some((entry) => entry.id === ignored.id),
    ).toBe(false)
    const withoutText = structuredClone(state.history)
    const assistant = withoutText.find(
      (record) => record.kind === 'assistant_turn',
    )!
    assistant.parts = assistant.parts.filter((part) => part.type !== 'text')
    const next = buildContextUsage(withoutText, recipe)
    expect(
      next.categories.find((group) => group.category === 'toolCalls')?.bytes,
    ).toBe(
      snapshot.categories.find((group) => group.category === 'toolCalls')
        ?.bytes,
    )
  })

  it('uses the selected provider projection for reasoning and omits unfinished tool batches', () => {
    const state = history()
    const anthropic: ContextUsageRecipe = {
      ...recipe,
      route: { ...route, providerType: 'generic.anthropic' },
    }
    const first = buildContextUsage(state.history, anthropic)
    const assistant = state.history[1]!
    if (assistant.kind === 'assistant_turn')
      assistant.normalizedReasoningText =
        'reasoning not sent by Anthropic'.repeat(100)
    expect(buildContextUsage(state.history, anthropic).totalBytes).toBe(
      first.totalBytes,
    )
    expect(buildContextUsage(state.history, recipe).totalBytes).toBeGreaterThan(
      first.totalBytes,
    )
    expect(() => buildContextUsage(state.history.slice(0, 2), recipe)).toThrow(
      'tool batch',
    )
  })

  it('accounts only for the new compact epoch and keeps tool schemas separate from request controls', () => {
    const state = history()
    for (const record of state.history) record.inHistory = false
    appendProviderCompactSummary(state, {
      payload: {
        schemaVersion: 1,
        providerType: route.providerType,
        format: 'summary-text.v1',
        data: { text: 'short checkpoint' },
      },
      route,
      replacesThroughSeq: 4,
      sourceHash: 'a'.repeat(64),
    })
    const snapshot = buildContextUsage(state.history, recipe)
    expect(
      snapshot.categories.find((group) => group.category === 'orchestration')
        ?.count,
    ).toBe(1)
    expect(
      snapshot.categories.find((group) => group.category === 'user')?.bytes,
    ).toBe(0)
    const compiled = {
      request: {
        model: 'model',
        max_tokens: 100,
        tools: [
          { name: 'tool', description: 'abc', parameters: { type: 'object' } },
        ],
      },
      normalizedMessages: [],
      tools: [
        {
          name: 'tool',
          description: 'abc',
          inputSchema: { type: 'object' },
          intentParameter: 'intent',
        },
      ],
    }
    const tools = measureContextTools(compiled)
    expect(tools.bytes).toBe(
      Buffer.byteLength(JSON.stringify(compiled.request.tools[0]), 'utf8'),
    )
    compiled.request.model = 'a'.repeat(1000)
    compiled.request.max_tokens = 999999
    expect(measureContextTools(compiled)).toEqual(tools)
    expect(JSON.stringify(tools)).not.toContain('parameters')
  })
})
