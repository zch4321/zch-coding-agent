import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import {
  appendInitialPromptHarness,
  appendPromptLayer,
  appendRuntimeContextIfChanged,
  selectPromptMessages,
  type PromptLedgerState,
} from './prompt-harness'

const execFileAsync = promisify(execFile)

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
    await mkdir(path.join(workspace, 'src', 'feature'), { recursive: true })
    await writeFile(path.join(workspace, 'AGENTS.md'), 'project guidance\n')
    await writeFile(path.join(workspace, 'src', 'feature', 'view.ts'), 'ok\n')
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
    expect(state.history[1]?.content).toContain('current_time:')
    expect(state.history[1]?.content).toContain('assistant_language: zh-CN')
    expect(state.history[1]?.content).toContain('project_tree_depth_3:')
    expect(state.history[1]?.content).toContain('src/feature/view.ts')
    expect(state.history[3]?.content).toContain('<agents')
  })

  it('includes recent git commit summaries when the workspace is a repository', async () => {
    const workspace = path.join(os.tmpdir(), `prompt-harness-git-${Date.now()}`)
    await mkdir(workspace, { recursive: true })
    await execFileAsync('git', ['init'], { cwd: workspace })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: workspace,
    })
    await execFileAsync('git', ['config', 'user.name', 'Test User'], {
      cwd: workspace,
    })

    for (let index = 1; index <= 6; index += 1) {
      await writeFile(path.join(workspace, 'file.txt'), `commit ${index}\n`)
      await execFileAsync('git', ['add', 'file.txt'], { cwd: workspace })
      await execFileAsync('git', ['commit', '-m', `commit ${index}`], {
        cwd: workspace,
      })
    }

    const state = ledger()
    const config = publicConfig()
    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
    })

    expect(state.history[1]?.content).toContain('recent_commits:')
    expect(state.history[1]?.content).toContain('commit 6')
    expect(state.history[1]?.content).toContain('commit 2')
    expect(state.history[1]?.content).not.toContain('commit 1')
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
