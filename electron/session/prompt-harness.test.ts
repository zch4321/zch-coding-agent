import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { ProjectMetadataStore } from '../project/project-metadata-store'
import { PromptRegistry } from '../prompts/registry'
import {
  appendAgentsContextIfChanged,
  appendInitialPromptHarness,
  appendPromptLayer,
  appendRuntimeContextIfChanged,
  orchestrationRequestContent,
  renderPromptTemplate,
  selectPromptMessages,
  selectedContextContent,
  type PromptLedgerState,
} from './prompt-harness'

const execFileAsync = promisify(execFile)
let promptRegistry: PromptRegistry

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
  beforeAll(async () => {
    promptRegistry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )
  })

  it('renders prompt templates and fails on unresolved placeholders', () => {
    expect(
      renderPromptTemplate('Hello ${name}; repeat ${name}.', {
        name: 'agent',
      }),
    ).toBe('Hello agent; repeat agent.')
    expect(() => renderPromptTemplate('${missing}', {})).toThrow(
      'Prompt template references unknown variable: missing',
    )

    for (const template of [
      '${name }',
      '${ name}',
      '${name-name}',
      '${',
      'prefix ${name } suffix',
    ]) {
      expect(() => renderPromptTemplate(template, { name: 'agent' })).toThrow(
        'Prompt template contains unresolved variables',
      )
    }
  })

  it('escapes harness tag attributes while preserving body text', () => {
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
      promptRegistry,
      toolNames: ['read_file'],
    })
    state.history.push({ role: 'user', content: 'hello raw user' })

    expect(state.promptLedger.map((entry) => entry.kind)).toEqual([
      'base_instructions',
      'runtime_context',
      'assistant_preferences',
      'agents',
    ])
    expect(state.promptLedger[0]?.role).toBe('system')
    expect(state.promptLedger[1]?.role).toBe('user')
    expect(state.history[1]?.role).toBe('user')
    expect(state.history.at(-1)).toEqual({
      role: 'user',
      content: 'hello raw user',
    })
    expect(state.history[1]?.content?.trimStart()).toMatch(
      /^<environment_context/u,
    )
    expect(state.history[1]?.content).not.toContain('${')
    expect(state.history[1]?.content).toContain('current_time:')
    expect(state.history[1]?.content).toContain('timezone:')
    expect(state.history[1]?.content).toContain('assistant_language: zh-CN')
    expect(state.history[1]?.content).toContain('project_tree_depth_3:')
    expect(state.history[1]?.content).toContain('src/feature/view.ts')
    expect(state.history[3]?.content).toContain('<agents')
  })

  it('loads AGENTS override guidance with explicit priority metadata', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-agents-override-${Date.now()}`,
    )
    await mkdir(path.join(workspace, 'src', 'feature'), { recursive: true })
    await writeFile(path.join(workspace, 'AGENTS.md'), 'root guidance\n')
    await writeFile(
      path.join(workspace, 'AGENTS.override.md'),
      'root override\n',
    )
    await writeFile(path.join(workspace, 'src', 'AGENTS.md'), 'src guidance\n')
    await writeFile(
      path.join(workspace, 'src', 'feature', 'AGENTS.override.md'),
      'feature override\n',
    )
    await writeFile(path.join(workspace, 'src', 'feature', 'view.ts'), 'ok\n')

    const prepared = await import('./context-attachments').then((module) =>
      module.prepareRunContext({
        workspace,
        attachments: [
          {
            kind: 'file',
            path: 'src/feature/view.ts',
            source: 'mention',
          },
        ],
        config: publicConfig(),
      }),
    )

    expect(prepared.providerContent).toContain(
      '<agents path="AGENTS.md" kind="AGENTS.md" depth="0" priority="0"',
    )
    expect(prepared.providerContent).toContain(
      '<agents path="AGENTS.override.md" kind="AGENTS.override.md" depth="0" priority="1"',
    )
    expect(prepared.providerContent).toContain(
      '<agents path="src/AGENTS.md" kind="AGENTS.md" depth="1"',
    )
    expect(prepared.providerContent).toContain(
      '<agents path="src/feature/AGENTS.override.md" kind="AGENTS.override.md" depth="2"',
    )
    expect(prepared.providerContent.indexOf('root guidance')).toBeLessThan(
      prepared.providerContent.indexOf('root override'),
    )
    expect(prepared.providerContent.indexOf('src guidance')).toBeLessThan(
      prepared.providerContent.indexOf('feature override'),
    )
  })

  it('skips AGENTS layer when no AGENTS.md exists', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-no-agents-${Date.now()}`,
    )
    await mkdir(workspace, { recursive: true })
    const state = ledger()
    const config = publicConfig()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
    })

    expect(state.promptLedger.map((entry) => entry.kind)).not.toContain(
      'agents',
    )
    expect(
      state.history.some((message) =>
        message.content?.includes(
          'No AGENTS.md instructions were found for this workspace.',
        ),
      ),
    ).toBe(false)

    const before = state.history.length
    await expect(
      appendAgentsContextIfChanged(state, {
        workspace,
        mode: 'readonly',
        config,
        providerId: 'deepseek',
        promptRegistry,
      }),
    ).resolves.toBe(false)
    expect(state.history).toHaveLength(before)

    await writeFile(path.join(workspace, 'AGENTS.md'), 'later guidance\n')
    await expect(
      appendAgentsContextIfChanged(state, {
        workspace,
        mode: 'readonly',
        config,
        providerId: 'deepseek',
        promptRegistry,
      }),
    ).resolves.toBe(true)
    expect(state.promptLedger.at(-1)?.kind).toBe('agents')
    expect(state.history.at(-1)?.content).toContain('<agents')
    expect(state.history.at(-1)?.content).toContain('later guidance')
  })

  it('appends updated AGENTS guidance without rewriting earlier layers', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-agents-update-${Date.now()}`,
    )
    await mkdir(workspace, { recursive: true })
    await writeFile(path.join(workspace, 'AGENTS.md'), 'initial guidance\n')
    const state = ledger()
    const config = publicConfig()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
    })
    const originalHistory = structuredClone(state.history)

    await writeFile(path.join(workspace, 'AGENTS.md'), 'updated guidance\n')
    await expect(
      appendAgentsContextIfChanged(state, {
        workspace,
        mode: 'readonly',
        config,
        providerId: 'deepseek',
        promptRegistry,
      }),
    ).resolves.toBe(true)

    expect(state.history.slice(0, originalHistory.length)).toEqual(
      originalHistory,
    )
    expect(
      state.promptLedger.filter((entry) => entry.kind === 'agents'),
    ).toHaveLength(2)
    expect(state.history.at(-1)?.content).toContain('updated guidance')
    expect(state.history.at(-1)?.content).not.toContain('initial guidance')

    const beforeSameContent = state.history.length
    await expect(
      appendAgentsContextIfChanged(state, {
        workspace,
        mode: 'readonly',
        config,
        providerId: 'deepseek',
        promptRegistry,
      }),
    ).resolves.toBe(false)
    expect(state.history).toHaveLength(beforeSameContent)
  })

  it('marks oversized AGENTS guidance as truncated and keeps content bounded', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-agents-truncated-${Date.now()}`,
    )
    await mkdir(workspace, { recursive: true })
    await writeFile(path.join(workspace, 'AGENTS.md'), 'A'.repeat(70 * 1_024))
    const state = ledger()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config: publicConfig(),
      providerId: 'deepseek',
      promptRegistry,
    })

    const agents = state.history.find((message) =>
      message.content?.startsWith('<agents '),
    )
    if (!agents?.content) {
      throw new Error('Expected AGENTS guidance layer to be appended')
    }
    expect(agents.content).toContain('truncated="true"')
    expect(agents.content).toContain('bytes="71680"')
    expect(agents.content.length).toBeLessThan(70 * 1_024)
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
      promptRegistry,
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
      promptRegistry,
      toolNames: ['read_file'],
    })
    const before = state.history.length

    await appendRuntimeContextIfChanged(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
      reason: 'same-state',
      toolNames: ['read_file'],
    })
    expect(state.history).toHaveLength(before)

    await appendRuntimeContextIfChanged(state, {
      workspace,
      mode: 'confirm',
      config,
      providerId: 'deepseek',
      promptRegistry,
      reason: 'mode-changed',
      toolNames: ['read_file'],
    })
    expect(state.history).toHaveLength(before + 1)
    expect(state.promptLedger.at(-1)?.kind).toBe('runtime_context')
    expect(state.promptLedger.at(-1)?.role).toBe('user')
  })

  it('appends workspace writer snapshots without rewriting prompt history', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-writer-${Date.now()}`,
    )
    await mkdir(workspace, { recursive: true })
    const state = ledger()
    const config = publicConfig()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
      workspaceConcurrency: { status: 'available' },
    })
    const original = structuredClone(state.history)

    await expect(
      appendRuntimeContextIfChanged(state, {
        workspace,
        mode: 'readonly',
        config,
        providerId: 'deepseek',
        promptRegistry,
        reason: 'writer-acquired',
        workspaceConcurrency: {
          status: 'readonly_locked',
          writerConversationId: 'conversation:writer',
          writerRunId: 'run:writer',
        },
      }),
    ).resolves.toBe(true)

    expect(state.history.slice(0, original.length)).toEqual(original)
    expect(state.history.at(-1)?.content).toContain(
      '<workspace_concurrency status="readonly_locked">',
    )
    expect(state.history.at(-1)?.content).toContain('conversation:writer')
    expect(state.history.at(-1)?.content).toContain('run:writer')
    expect(state.history.at(-1)?.content).toContain('重新读取相关文件')

    await expect(
      appendRuntimeContextIfChanged(state, {
        workspace,
        mode: 'readonly',
        config,
        providerId: 'deepseek',
        promptRegistry,
        reason: 'writer-released',
        workspaceConcurrency: { status: 'available' },
      }),
    ).resolves.toBe(true)
    expect(state.history.at(-1)?.content).toContain(
      '<workspace_concurrency status="available">',
    )
  })

  it('renders the English readonly lock warning with fixed safety guidance', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-writer-en-${Date.now()}`,
    )
    await mkdir(workspace, { recursive: true })
    const config = publicConfig()
    config.assistant.language = 'en-US'
    const state = ledger()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config,
      providerId: 'deepseek',
      promptRegistry,
      workspaceConcurrency: {
        status: 'readonly_locked',
        writerConversationId: 'conversation:writer-en',
        writerRunId: 'run:writer-en',
      },
    })

    const runtime = state.history.find((message) =>
      message.content?.includes('<workspace_concurrency'),
    )
    expect(runtime?.content).toContain('forcibly restricted to readonly')
    expect(runtime?.content).toContain('Do not write or delete files')
    expect(runtime?.content).toContain('reread relevant files')
    expect(runtime?.content).not.toContain('${')
  })

  it('uses ProjectModel metadata in module context when available', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-project-${Date.now()}`,
    )
    await mkdir(workspace, { recursive: true })
    const projectMetadata = new ProjectMetadataStore()
    const snapshot = await projectMetadata.get(workspace)
    await projectMetadata.save(workspace, {
      ...snapshot.project,
      modules: [
        {
          id: 'frontend',
          root: '.',
          name: 'frontend',
          languages: ['typescript'],
          manifests: ['package.json'],
          sourceRoots: ['src'],
          testRoots: [],
          excludedRoots: ['node_modules'],
          backendHints: ['serena'],
          source: 'agent-set',
          confidence: 0.9,
          fingerprint: 'fingerprint',
          updatedAt: new Date().toISOString(),
        },
      ],
      defaultModuleId: 'frontend',
    })
    const state = ledger()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config: publicConfig(),
      providerId: 'deepseek',
      promptRegistry,
      projectMetadata,
    })

    expect(state.history[1]?.content).toContain(
      'project_model: .zch/project-model.json',
    )
    expect(state.history[1]?.content).toContain('module frontend')
    expect(state.history[1]?.content).toContain('semantic_tools:')
    expect(state.history[1]?.content).toContain(
      'code_intelligence: unavailable',
    )
    expect(state.history[1]?.content).toContain('code_backends:')
  })

  it('encourages code intelligence only when a backend is configured', async () => {
    const workspace = path.join(
      os.tmpdir(),
      `prompt-harness-intelligence-${Date.now()}`,
    )
    await mkdir(workspace, { recursive: true })
    const projectMetadata = new ProjectMetadataStore()
    const snapshot = await projectMetadata.get(workspace)
    await projectMetadata.save(workspace, {
      ...snapshot.project,
      serena: { ...snapshot.project.serena, enabled: true },
      backendBindings: snapshot.project.backendBindings.map((binding) => ({
        ...binding,
        enabled: true,
      })),
    })
    const state = ledger()

    await appendInitialPromptHarness(state, {
      workspace,
      mode: 'readonly',
      config: publicConfig(),
      providerId: 'deepseek',
      promptRegistry,
      projectMetadata,
    })

    expect(state.history[1]?.content).toContain('code_intelligence: configured')
    expect(state.history[1]?.content).toContain(
      'code_find_definition may return function/class bodies',
    )
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
      promptRegistry,
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

  it('retains pinned layers and the latest user turn under a tight prompt budget', () => {
    const config = publicConfig()
    config.limits.tokenEstimation = {
      mode: 'custom-bytes',
      bytesPerToken: 1,
    }
    const state = ledger()

    appendPromptLayer(state, {
      kind: 'base_instructions',
      role: 'system',
      content: 'base',
      source: 'test:base',
      trusted: true,
      editable: false,
      config,
    })
    appendPromptLayer(state, {
      kind: 'runtime_context',
      role: 'user',
      content: 'runtime',
      source: 'test:runtime',
      trusted: true,
      editable: false,
      config,
    })
    state.history.push({
      role: 'user',
      content: `old user ${'x'.repeat(5_000)}`,
    })
    state.history.push({
      role: 'assistant',
      content: `old assistant ${'y'.repeat(5_000)}`,
    })
    appendPromptLayer(state, {
      kind: 'agents',
      role: 'user',
      content: 'current agents guidance',
      source: 'workspace:AGENTS',
      trusted: false,
      editable: false,
      config,
    })
    state.history.push({ role: 'user', content: 'latest user task' })

    const selected = selectPromptMessages({
      state,
      tools: [],
      maxPromptTokens: 1_000,
      estimation: config.limits.tokenEstimation,
    })
    const rendered = JSON.stringify(selected.messages)

    expect(rendered).toContain('base')
    expect(rendered).toContain('runtime')
    expect(rendered).toContain('current agents guidance')
    expect(rendered).toContain('latest user task')
    expect(rendered).not.toContain('old user')
    expect(rendered).not.toContain('old assistant')
    expect(selected.promptBuild.omittedHistoryMessages).toBe(2)
    expect(selected.promptBuild.layers.every((layer) => layer.included)).toBe(
      true,
    )
  })
})
