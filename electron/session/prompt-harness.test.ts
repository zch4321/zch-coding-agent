import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import {
  appendInitialPromptHarness,
  appendPromptLayer,
  appendRuntimeContextIfChanged,
  selectPromptMessages,
  type PromptLedgerState,
} from './prompt-harness'

function publicConfig() {
  return toPublicConfig(structuredClone(DEFAULT_APP_CONFIG), false)
}

function ledger(): PromptLedgerState {
  return {
    history: [],
    promptLedger: [],
    nextPromptSeq: 1,
  }
}

describe('prompt harness', () => {
  it('appends initial harness messages before raw user messages', async () => {
    const workspace = path.join(os.tmpdir(), `prompt-harness-${Date.now()}`)
    await mkdir(workspace, { recursive: true })
    await writeFile(path.join(workspace, 'AGENTS.md'), 'project guidance\n')
    const state = ledger()
    const config = publicConfig()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      toolNames: ['read_file'],
    })
    state.history.push({ role: 'user', content: 'hello raw user' })

    expect(state.promptLedger.map((entry) => entry.kind)).toEqual([
      'base_instructions',
      'runtime_policy_and_context',
      'assistant_preferences',
      'agents',
    ])
    expect(state.history.at(-1)).toEqual({
      role: 'user',
      content: 'hello raw user',
    })
    expect(state.history[3]?.content).toContain('<agents')
  })

  it('only appends runtime context when its content changes', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-runtime-${Date.now()}`,
    )
    await mkdir(workspace, { recursive: true })
    const state = ledger()
    const config = publicConfig()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      toolNames: ['read_file'],
    })
    const before = state.history.length

    await appendRuntimeContextIfChanged(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      reason: 'same-state',
      toolNames: ['read_file'],
    })
    expect(state.history).toHaveLength(before)

    await appendRuntimeContextIfChanged(state, {
      workspace,
      mode: 'confirm',
      config,
      providerId: 'deepseek',
      reason: 'mode-changed',
      toolNames: ['read_file'],
    })
    expect(state.history).toHaveLength(before + 1)
    expect(state.promptLedger.at(-1)?.kind).toBe('runtime_policy_and_context')
  })

  it('records prompt build metadata without mutating existing messages', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-select-${Date.now()}`,
    )
    await mkdir(workspace, { recursive: true })
    const state = ledger()
    const config = publicConfig()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
    })
    const original = structuredClone(state.history)
    appendPromptLayer(state, {
      kind: 'orchestration_request',
      role: 'user',
      content:
        '<orchestration_request kind="test">Continue.</orchestration_request>',
      source: 'test',
      trusted: false,
      editable: false,
      config,
    })
    state.history.push({ role: 'user', content: 'raw user text' })

    const selected = selectPromptMessages({
      state,
      tools: [],
      maxPromptTokens: 64_000,
      estimation: config.limits.tokenEstimation,
    })

    expect(state.history.slice(0, original.length)).toEqual(original)
    expect(selected.promptBuild.layers.at(-1)?.kind).toBe(
      'orchestration_request',
    )
    expect(selected.messages.at(-1)).toEqual({
      role: 'user',
      content: 'raw user text',
    })
  })
})
