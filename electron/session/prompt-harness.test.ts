import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '../../shared/ids'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PromptRegistry } from '../prompts/registry'
import { appendUserInput } from './canonical-history'
import {
  appendAgentsContextIfChanged,
  appendInitialPromptHarness,
  appendPromptLayer,
  appendRuntimeContextIfChanged,
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
    const runtimeContext = state.history.find(
      (record) => record.kind === 'runtime_context',
    )
    expect(runtimeContext?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/\ncommand_shell: .+ \([^)]+\)\n/u),
    })
    expect(
      runtimeContext?.parts[0]?.type === 'text'
        ? runtimeContext.parts[0].text
        : '',
    ).not.toMatch(/\nshell:/u)
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

  it('excludes Git and project tree snapshots from the runtime fingerprint', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'prompt-runtime-'))
    const state = history()
    const config = publicConfig()
    const readGitSummary = vi
      .fn()
      .mockResolvedValueOnce('git snapshot: initial')
      .mockResolvedValue('git snapshot: refreshed')
    const readProjectTree = vi
      .fn()
      .mockResolvedValueOnce('file initial.txt')
      .mockResolvedValue('file refreshed.txt')
    const input = {
      workspace,
      sessionTemp: {
        root: path.join(workspace, '.session-temp-a'),
        artifacts: path.join(workspace, '.session-temp-a', 'artifacts'),
        scratch: path.join(workspace, '.session-temp-a', 'scratch'),
      },
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
      reason: 'test',
      toolNames: ['read_file'],
      workspaceSnapshotReaders: {
        gitSummary: readGitSummary,
        projectTreeSummary: readProjectTree,
      },
    }

    await expect(appendRuntimeContextIfChanged(state, input)).resolves.toBe(
      true,
    )
    expect(readGitSummary).toHaveBeenCalledTimes(1)
    expect(readProjectTree).toHaveBeenCalledTimes(1)
    expect(state.history.at(-1)?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('git snapshot: initial'),
    })

    await expect(
      appendRuntimeContextIfChanged(state, {
        ...input,
        sessionTemp: {
          root: path.join(workspace, '.session-temp-b'),
          artifacts: path.join(workspace, '.session-temp-b', 'artifacts'),
          scratch: path.join(workspace, '.session-temp-b', 'scratch'),
        },
      }),
    ).resolves.toBe(false)
    expect(readGitSummary).toHaveBeenCalledTimes(1)
    expect(readProjectTree).toHaveBeenCalledTimes(1)

    await writeFile(path.join(workspace, 'ordinary-file.txt'), 'changed\n')
    await expect(appendRuntimeContextIfChanged(state, input)).resolves.toBe(
      false,
    )
    expect(readGitSummary).toHaveBeenCalledTimes(1)
    expect(readProjectTree).toHaveBeenCalledTimes(1)
    expect(
      state.history.filter((record) => record.kind === 'runtime_context'),
    ).toHaveLength(1)

    await expect(
      appendRuntimeContextIfChanged(state, { ...input, mode: 'confirm' }),
    ).resolves.toBe(true)
    expect(readGitSummary).toHaveBeenCalledTimes(2)
    expect(readProjectTree).toHaveBeenCalledTimes(2)
    expect(state.history.at(-1)?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(
        /git snapshot: refreshed[\s\S]*file refreshed\.txt/u,
      ),
    })
  })

  it('keeps stable tool and module fields in the runtime fingerprint', async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), 'prompt-runtime-stable-'),
    )
    const state = history()
    const config = publicConfig()
    const input = {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
      reason: 'test',
      toolNames: ['read_file'],
    }

    await expect(appendRuntimeContextIfChanged(state, input)).resolves.toBe(
      true,
    )
    await expect(
      appendRuntimeContextIfChanged(state, {
        ...input,
        toolNames: ['read_file', 'list_directory'],
      }),
    ).resolves.toBe(true)

    await writeFile(path.join(workspace, 'package.json'), '{}\n')
    await expect(
      appendRuntimeContextIfChanged(state, {
        ...input,
        toolNames: ['read_file', 'list_directory'],
      }),
    ).resolves.toBe(true)
    expect(state.history.at(-1)?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('.: package.json'),
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

  it('records budget pressure without dropping or rejecting active history', async () => {
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

    const selected = selectPromptMessages({
      state,
      tools: [],
      maxPromptTokens: 64,
      estimation: config.limits.tokenEstimation,
    })

    expect(selected.messages).toHaveLength(state.history.length)
    expect(selected.promptBuild.promptBudgetTokens).toBe(64)
    expect(selected.promptBuild.estimatedTokens).toBeGreaterThan(64)
    expect(state.history.every((record) => record.inHistory)).toBe(true)
  })
})
