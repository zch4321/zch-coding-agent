import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { SessionId } from '../../shared/ids'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PromptRegistry } from '../prompts/registry'
import { ContextBudgetError } from '../tools/context-budget'
import { appendUserInput } from './canonical-history'
import {
  appendAgentsContextIfChanged,
  appendInitialPromptHarness,
  appendPromptLayer,
  orchestrationRequestContent,
  promptResources,
  renderPromptTemplate,
  selectPromptMessages,
  selectedContextContent,
  type PromptHistoryState,
} from './prompt-harness'

let promptRegistry: PromptRegistry

function publicConfig() {
  return toPublicConfig(structuredClone(DEFAULT_APP_CONFIG), false)
}

function history(): PromptHistoryState {
  return {
    sessionId: 'session:prompt-test' as SessionId,
    history: [],
    nextMessageSeq: 1,
  }
}

describe('canonical prompt harness', () => {
  beforeAll(async () => {
    promptRegistry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )
  })

  it('renders deterministic templates and rejects unresolved variables', () => {
    expect(
      renderPromptTemplate('Hello ${name}; repeat ${name}.', {
        name: 'agent',
      }),
    ).toBe('Hello agent; repeat agent.')
    expect(() => renderPromptTemplate('${missing}', {})).toThrow(
      'Prompt template references unknown variable: missing',
    )
    expect(() =>
      renderPromptTemplate('prefix ${name }', { name: 'x' }),
    ).toThrow('Prompt template contains unresolved variables')
  })

  it('escapes tag attributes without changing body text', () => {
    expect(selectedContextContent('body <kept>', 'run"&<>')).toContain(
      '<selected_context source="run&quot;&amp;&lt;&gt;">',
    )
    expect(selectedContextContent('body <kept>', 'run"&<>')).toContain(
      'body <kept>',
    )
    expect(orchestrationRequestContent('plan"&<>', 'review')).toContain(
      '<orchestration_request kind="plan&quot;&amp;&lt;&gt;">',
    )
  })

  it('appends fine-grained canonical harness records before the user', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'prompt-harness-'))
    await writeFile(path.join(workspace, 'AGENTS.md'), 'project guidance\n')
    const state = history()
    const config = publicConfig()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
      skillSummary: 'one enabled skill',
      toolNames: ['read_file'],
    })
    appendUserInput(state, {
      content: 'hello',
      clientRequestId: 'request:prompt-test',
    })

    expect(state.history.map((record) => record.kind)).toEqual([
      'system_instruction',
      'runtime_context',
      'assistant_preferences',
      'agents_context',
      'selected_context',
      'user_input',
    ])
    expect(state.history.map((record) => record.seq)).toEqual([
      1, 2, 3, 4, 5, 6,
    ])
    for (const record of state.history.slice(0, -1)) {
      expect(record.metadata).toMatchObject({
        schemaVersion: 1,
        layer: {
          source: expect.any(String),
          trusted: expect.any(Boolean),
          editable: expect.any(Boolean),
          hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      })
    }
  })

  it('deduplicates unchanged AGENTS content and appends changed guidance', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'prompt-agents-'))
    const agentsPath = path.join(workspace, 'AGENTS.md')
    await writeFile(agentsPath, 'initial guidance\n')
    const state = history()
    const input = {
      workspace,
      mode: 'readonly',
      config: publicConfig(),
      providerId: 'deepseek',
      promptRegistry,
    }

    await appendInitialPromptHarness(state, input)
    const before = state.history.length
    await expect(appendAgentsContextIfChanged(state, input)).resolves.toBe(
      false,
    )
    expect(state.history).toHaveLength(before)

    await writeFile(agentsPath, 'updated guidance\n')
    await expect(appendAgentsContextIfChanged(state, input)).resolves.toBe(true)
    expect(state.history.at(-1)?.kind).toBe('agents_context')
    expect(state.history.at(-1)?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('updated guidance'),
    })
  })

  it('derives trace layers/resources from canonical metadata', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'prompt-trace-'))
    const state = history()
    const config = publicConfig()
    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
    })
    appendPromptLayer(state, {
      kind: 'orchestrator',
      content: 'Continue the plan',
      source: 'test:orchestrator',
      trusted: false,
      editable: false,
      config,
    })

    const selected = selectPromptMessages({
      state,
      tools: [],
      maxPromptTokens: 100_000,
      estimation: config.limits.tokenEstimation,
    })
    expect(selected.messages).toHaveLength(state.history.length)
    expect(selected.promptBuild).toMatchObject({
      schemaVersion: 2,
      activeMessageCount: state.history.length,
      omittedHistoryMessages: 0,
      sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(selected.promptBuild.layers.at(-1)).toMatchObject({
      kind: 'orchestrator',
      messageId: state.history.at(-1)?.id,
      source: 'test:orchestrator',
    })
    expect(promptResources(state).length).toBeGreaterThan(0)
  })

  it('never silently drops active canonical history for budget pressure', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'prompt-budget-'))
    const state = history()
    const config = publicConfig()
    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
    })
    appendUserInput(state, {
      content: 'x'.repeat(20_000),
      clientRequestId: 'request:large',
    })

    expect(() =>
      selectPromptMessages({
        state,
        tools: [],
        maxPromptTokens: 64,
        estimation: config.limits.tokenEstimation,
      }),
    ).toThrow(ContextBudgetError)
    expect(state.history.every((record) => record.inHistory)).toBe(true)
  })
})
