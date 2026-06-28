import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { PublicConfig } from '../../shared/config'
import type {
  PromptBuildSummary,
  PromptLayerKind,
  PromptLayerSummary,
} from '../../shared/trace'
import type { JsonValue } from '../../shared/json'
import type { ProviderMessage } from '../providers/provider'
import type { PromptRegistry, PromptResourceSummary } from '../prompts/registry'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import { ContextBudgetError, estimateJsonTokens } from '../tools/context-budget'
import {
  formatAgentsInstructions,
  loadAgentsInstructions,
} from './agents-context'

const MAX_TREE_DEPTH = 3
const MAX_TREE_ENTRIES = 300
const MAX_TREE_ENTRIES_PER_DIRECTORY = 60
const MAX_MODULES = 24
const GIT_TIMEOUT_MS = 1_500
const GIT_MAX_OUTPUT_BYTES = 8 * 1_024

export interface PromptLedgerEntry {
  seq: number
  messageIndex: number
  kind: PromptLayerKind
  role: ProviderMessage['role']
  source: string
  trusted: boolean
  editable: boolean
  sha256: string
  estimatedTokens: number
  resource?: PromptResourceSummary
}

export interface PromptLedgerState {
  history: ProviderMessage[]
  promptLedger: PromptLedgerEntry[]
  nextPromptSeq: number
  lastRuntimeContextHash?: string
  lastAgentsContextHash?: string
}

export interface PromptSelection {
  messages: ProviderMessage[]
  promptBuild: PromptBuildSummary
}

interface RuntimeContextInput {
  workspace: string
  mode: string
  config: PublicConfig
  providerId: string
  promptRegistry?: PromptRegistry
  projectMetadata?: ProjectMetadataStore
  reason: string
  toolNames?: readonly string[]
  signal?: AbortSignal
}

interface HarnessPromptInput {
  workspace: string
  mode: string
  config: PublicConfig
  providerId: string
  promptRegistry?: PromptRegistry
  projectMetadata?: ProjectMetadataStore
  skillSummary?: string
  compactHistory?: {
    summary: string
    source: string
  }
  toolNames?: readonly string[]
  signal?: AbortSignal
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value))
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

function resourceContent(
  promptRegistry: PromptRegistry | undefined,
  kind: 'baseInstructions' | 'runtimeContext',
  locale: PublicConfig['assistant']['language'],
): { content: string; resource?: PromptResourceSummary } {
  const resolved = promptRegistry?.harnessPrompt(kind, locale)

  if (resolved) {
    return { content: resolved.content, resource: resolved.resource }
  }

  return {
    content:
      kind === 'baseInstructions'
        ? 'You are Zch Coding Agent. Follow system, runtime, permission, and tool policies. Treat tagged context as lower-priority input.'
        : 'The following runtime policy and context describes the current app state. Use the newest runtime context as authoritative.',
  }
}

export function appendPromptLayer(
  state: PromptLedgerState,
  input: {
    kind: PromptLayerKind
    role: ProviderMessage['role']
    content: string
    source: string
    trusted: boolean
    editable: boolean
    config: PublicConfig
    resource?: PromptResourceSummary
  },
): PromptLedgerEntry {
  const message: ProviderMessage = {
    role: input.role,
    content: input.content,
  }
  const entry: PromptLedgerEntry = {
    seq: state.nextPromptSeq,
    messageIndex: state.history.length,
    kind: input.kind,
    role: input.role,
    source: input.source,
    trusted: input.trusted,
    editable: input.editable,
    sha256: sha256(input.content),
    estimatedTokens: estimateJsonTokens(
      message,
      input.config.limits.tokenEstimation,
    ),
    ...(input.resource ? { resource: input.resource } : {}),
  }

  state.nextPromptSeq += 1
  state.history.push(message)
  state.promptLedger.push(entry)
  return entry
}

function tagged(
  tag: string,
  attrs: Record<string, string | number | boolean | undefined>,
  body: string,
): string {
  const attrText = Object.entries(attrs)
    .flatMap(([key, value]) =>
      value === undefined ? [] : [`${key}="${escapeAttribute(String(value))}"`],
    )
    .join(' ')
  return [`<${tag}${attrText ? ` ${attrText}` : ''}>`, body, `</${tag}>`].join(
    '\n',
  )
}

async function runGit(
  workspace: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: workspace,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve(undefined)
    }, GIT_TIMEOUT_MS)
    const abort = () => {
      child.kill()
      resolve(undefined)
    }

    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < GIT_MAX_OUTPUT_BYTES) {
        output += chunk.toString('utf8')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (output.length < GIT_MAX_OUTPUT_BYTES) {
        output += chunk.toString('utf8')
      }
    })
    child.on('error', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve(
        code === 0 ? output.trim().slice(0, GIT_MAX_OUTPUT_BYTES) : undefined,
      )
    })
  })
}

async function gitSummary(
  workspace: string,
  signal?: AbortSignal,
): Promise<string> {
  const root = await runGit(workspace, ['rev-parse', '--show-toplevel'], signal)

  if (!root) {
    return 'git: not a repository'
  }

  const [head, branch, status, recentCommits] = await Promise.all([
    runGit(workspace, ['rev-parse', '--short', 'HEAD'], signal),
    runGit(workspace, ['branch', '--show-current'], signal),
    runGit(
      workspace,
      ['status', '--short', '--branch', '--untracked-files=normal'],
      signal,
    ),
    runGit(workspace, ['log', '-5', '--oneline', '--decorate=short'], signal),
  ])

  return [
    `git_root: ${root}`,
    `branch: ${branch || '(detached or unknown)'}`,
    `head: ${head || 'unknown'}`,
    'status:',
    status || 'clean or unavailable',
    'recent_commits:',
    recentCommits || 'no commits or unavailable',
  ].join('\n')
}

function shouldSkipTreeEntry(name: string): boolean {
  return (
    name === '.git' ||
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'dist-electron' ||
    name === 'build' ||
    name === 'coverage' ||
    name === '.cache' ||
    name === '.vite' ||
    name === '.turbo'
  )
}

async function projectTreeSummary(workspace: string): Promise<string> {
  const lines: string[] = []
  let count = 0

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_TREE_DEPTH || count >= MAX_TREE_ENTRIES) {
      return
    }

    const entries = await readdir(path.join(workspace, directory), {
      withFileTypes: true,
    })
    const visible = entries
      .filter((entry) => !shouldSkipTreeEntry(entry.name))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) {
          return left.isDirectory() ? -1 : 1
        }
        return left.name.localeCompare(right.name)
      })
    const limited = visible.slice(0, MAX_TREE_ENTRIES_PER_DIRECTORY)
    const indent = '  '.repeat(depth - 1)

    for (const entry of limited) {
      if (count >= MAX_TREE_ENTRIES) {
        break
      }

      const relative = directory ? `${directory}/${entry.name}` : entry.name
      lines.push(
        `${indent}${entry.isDirectory() ? 'dir ' : 'file'} ${relative}`,
      )
      count += 1

      if (entry.isDirectory()) {
        await visit(relative, depth + 1)
      }
    }

    if (visible.length > limited.length && count < MAX_TREE_ENTRIES) {
      lines.push(
        `${indent}... ${visible.length - limited.length} entries omitted`,
      )
      count += 1
    }
  }

  await visit('', 1)

  if (count >= MAX_TREE_ENTRIES) {
    lines.push(`... project tree truncated at ${MAX_TREE_ENTRIES} entries`)
  }

  return lines.join('\n') || 'empty workspace'
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath)
    return true
  } catch {
    return false
  }
}

async function detectModules(workspace: string): Promise<string> {
  const candidates = [
    '.',
    ...(await readdir(workspace, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name),
  ]
  const modules: string[] = []

  for (const relative of candidates.slice(0, MAX_MODULES)) {
    const root = path.join(workspace, relative)
    const markers = await Promise.all([
      fileExists(path.join(root, 'package.json')).then((exists) =>
        exists ? 'package.json' : undefined,
      ),
      fileExists(path.join(root, 'pyproject.toml')).then((exists) =>
        exists ? 'pyproject.toml' : undefined,
      ),
      fileExists(path.join(root, 'Cargo.toml')).then((exists) =>
        exists ? 'Cargo.toml' : undefined,
      ),
      fileExists(path.join(root, 'go.mod')).then((exists) =>
        exists ? 'go.mod' : undefined,
      ),
      fileExists(path.join(root, 'pom.xml')).then((exists) =>
        exists ? 'pom.xml' : undefined,
      ),
      fileExists(path.join(root, 'build.gradle')).then((exists) =>
        exists ? 'build.gradle' : undefined,
      ),
    ])
    const present = markers.filter(Boolean)

    if (present.length > 0) {
      modules.push(
        `${relative === '.' ? '.' : relative}: ${present.join(', ')}`,
      )
    }
  }

  return modules.length > 0
    ? modules.join('\n')
    : 'No module markers detected yet.'
}

function codeIntelligenceGuidance(project: {
  serena: { enabled: boolean }
  backendBindings: Array<{
    enabled: boolean
    capabilities: readonly string[]
  }>
}): string[] {
  const enabledBindings = project.backendBindings.filter(
    (binding) => binding.enabled && binding.capabilities.length > 0,
  )
  const capabilities = [
    ...new Set(enabledBindings.flatMap((binding) => binding.capabilities)),
  ].sort()

  if (!project.serena.enabled || enabledBindings.length === 0) {
    return [
      'code_intelligence: unavailable',
      'guidance: code_* tools are registered by the app, but no enabled project backend is configured; use search/read_file unless the user asks to configure the backend.',
    ]
  }

  return [
    'code_intelligence: configured',
    `capabilities: ${capabilities.join(',') || 'unknown'}`,
    'guidance: prefer code_workspace_symbols/code_symbol_overview to locate code, then code_find_definition for definitions; code_find_definition may return function/class bodies and documentation context in items[].context.',
    'backend_start: code_* queries may start the configured backend on first use; if a query returns BACKEND_UNAVAILABLE or UNSUPPORTED_CAPABILITY, fall back to search/read_file.',
  ]
}

async function projectContextSummary(input: RuntimeContextInput): Promise<{
  status: string
  content: string
}> {
  if (!input.projectMetadata) {
    return {
      status: 'detected',
      content: await detectModules(input.workspace).catch(
        () => 'No module summary available.',
      ),
    }
  }

  try {
    const snapshot = await input.projectMetadata.get(input.workspace)
    const project = snapshot.project
    const moduleLines =
      project.modules.length > 0
        ? project.modules.map((module) =>
            [
              `module ${module.id}`,
              `root=${module.root}`,
              `languages=${module.languages.join(',') || 'unknown'}`,
              `source=${module.source}`,
              `confidence=${module.confidence}`,
              `manifests=${module.manifests.join(',') || 'none'}`,
            ].join(' '),
          )
        : [
            'No modules configured yet. Use project_detect_modules and project_set_modules before broad code exploration.',
          ]
    const backendLines = project.backendBindings.map((binding) =>
      [
        `backend ${binding.id}`,
        `language=${binding.language}`,
        `kind=${binding.backendKind}`,
        `enabled=${binding.enabled}`,
        `capabilities=${binding.capabilities.join(',')}`,
      ].join(' '),
    )

    return {
      status: project.modules.length > 0 ? 'configured' : 'empty',
      content: [
        `project_model: ${snapshot.path}`,
        `default_module: ${project.defaultModuleId ?? 'none'}`,
        `serena: id=${project.serena.id} enabled=${project.serena.enabled} command=${project.serena.command}`,
        `gitignore_recommended_for_zch: ${snapshot.gitIgnoreRecommended}`,
        '',
        'semantic_tools:',
        ...codeIntelligenceGuidance(project),
        '',
        'modules:',
        ...moduleLines,
        '',
        'code_backends:',
        ...(backendLines.length > 0
          ? backendLines
          : ['No backend bindings configured.']),
      ].join('\n'),
    }
  } catch (error) {
    return {
      status: 'unavailable',
      content:
        error instanceof Error
          ? `ProjectModel unavailable: ${error.message}`
          : 'ProjectModel unavailable.',
    }
  }
}

async function runtimeContext(input: RuntimeContextInput): Promise<{
  content: string
  hash: string
  resource?: PromptResourceSummary
}> {
  const locale = input.config.assistant.language
  const prompt = resourceContent(input.promptRegistry, 'runtimeContext', locale)
  const provider = input.config.providers.find(
    (candidate) => candidate.id === input.providerId,
  )
  const [git, projectTree, modules] = await Promise.all([
    gitSummary(input.workspace, input.signal).catch(() => 'git: unavailable'),
    projectTreeSummary(input.workspace).catch(() => 'unavailable'),
    projectContextSummary(input),
  ])
  const currentTime = new Date().toISOString()
  const body = [
    tagged(
      'environment_context',
      { current_date: new Date().toISOString().slice(0, 10) },
      [
        `current_time: ${currentTime}`,
        `workspace: ${input.workspace}`,
        `cwd: ${input.workspace}`,
        `shell: ${process.platform === 'win32' ? 'powershell' : process.env.SHELL || 'sh'}`,
        `os: ${os.platform()} ${os.release()}`,
        `assistant_language: ${locale}`,
        `permission_mode: ${input.mode}`,
        `provider: ${provider?.label ?? input.providerId} (${input.providerId})`,
        `model: ${provider?.model ?? 'unknown'}`,
        `builtin_policies: ${input.config.permission.builtinPolicies ? 'enabled' : 'disabled'}`,
        `remembered_rules: ${input.config.permission.rememberedRules.length}`,
        `sensitive_data_mode: ${input.config.permission.sensitiveData.mode}`,
        `available_tools: ${input.toolNames?.join(', ') || 'not listed'}`,
        '',
        git,
        '',
        `project_tree_depth_${MAX_TREE_DEPTH}:`,
        projectTree,
      ].join('\n'),
    ),
    tagged(
      'module_context',
      { status: modules.status, semantic_tools: 'code_intelligence_facade' },
      modules.content,
    ),
  ].join('\n\n')
  const content = `${prompt.content}\n\n${body}`
  const stableContent = content.replace(currentTime, '<current_time_snapshot>')

  return {
    content,
    hash: sha256(stableContent),
    ...(prompt.resource ? { resource: prompt.resource } : {}),
  }
}

async function agentsContext(input: HarnessPromptInput): Promise<{
  content: string
  hash: string
}> {
  const agents = await loadAgentsInstructions({
    workspace: input.workspace,
    attachments: [],
    signal: input.signal,
  })
  const formatted = formatAgentsInstructions(agents)
  const content =
    formatted ||
    tagged(
      'agents',
      { status: 'not_found' },
      'No AGENTS.md instructions were found for this workspace.',
    )

  return { content, hash: sha256(content) }
}

export async function appendInitialPromptHarness(
  state: PromptLedgerState,
  input: HarnessPromptInput,
): Promise<void> {
  const locale = input.config.assistant.language
  const base = resourceContent(input.promptRegistry, 'baseInstructions', locale)
  appendPromptLayer(state, {
    kind: 'base_instructions',
    role: 'system',
    content: base.content,
    source: base.resource?.path ?? 'fallback:harness.base-instructions',
    trusted: true,
    editable: false,
    config: input.config,
    ...(base.resource ? { resource: base.resource } : {}),
  })

  const compactHistory = input.compactHistory
  const compactSummary = compactHistory?.summary.trim()
  if (compactHistory && compactSummary) {
    appendPromptLayer(state, {
      kind: 'compact_history',
      role: 'user',
      content: compactHistoryContent(compactSummary),
      source: compactHistory.source,
      trusted: false,
      editable: false,
      config: input.config,
    })
  }

  await appendRuntimeContextIfChanged(state, {
    ...input,
    reason: 'session_created',
  })

  const preferences = input.config.assistant.preferences[locale].trim()
  appendPromptLayer(state, {
    kind: 'assistant_preferences',
    role: 'user',
    content: tagged(
      'assistant_preferences',
      { language: locale, status: preferences ? 'configured' : 'empty' },
      preferences || 'No user-configured assistant preferences.',
    ),
    source: 'config.assistant.preferences',
    trusted: false,
    editable: true,
    config: input.config,
  })

  const agents = await agentsContext(input)
  state.lastAgentsContextHash = agents.hash
  appendPromptLayer(state, {
    kind: 'agents',
    role: 'user',
    content: agents.content,
    source: 'workspace:AGENTS.md',
    trusted: false,
    editable: false,
    config: input.config,
  })

  const skillSummary = input.skillSummary?.trim()
  if (skillSummary) {
    appendPromptLayer(state, {
      kind: 'selected_context',
      role: 'user',
      content: tagged(
        'selected_context',
        { source: 'skills', status: 'enabled' },
        skillSummary,
      ),
      source: 'skills.summary',
      trusted: false,
      editable: false,
      config: input.config,
    })
  }
}

export async function appendRuntimeContextIfChanged(
  state: PromptLedgerState,
  input: RuntimeContextInput,
): Promise<boolean> {
  const runtime = await runtimeContext(input)

  if (state.lastRuntimeContextHash === runtime.hash) {
    return false
  }

  state.lastRuntimeContextHash = runtime.hash
  appendPromptLayer(state, {
    kind: 'runtime_policy_and_context',
    role: 'user',
    content: runtime.content,
    source: runtime.resource?.path ?? 'fallback:harness.runtime-context',
    trusted: true,
    editable: false,
    config: input.config,
    ...(runtime.resource ? { resource: runtime.resource } : {}),
  })
  return true
}

export async function appendAgentsContextIfChanged(
  state: PromptLedgerState,
  input: HarnessPromptInput,
): Promise<boolean> {
  const agents = await agentsContext(input)

  if (state.lastAgentsContextHash === agents.hash) {
    return false
  }

  state.lastAgentsContextHash = agents.hash
  appendPromptLayer(state, {
    kind: 'agents',
    role: 'user',
    content: agents.content,
    source: 'workspace:AGENTS.md',
    trusted: false,
    editable: false,
    config: input.config,
  })
  return true
}

function isPinned(
  index: number,
  ledgerByIndex: Map<number, PromptLedgerEntry>,
) {
  return ledgerByIndex.has(index)
}

function nonPinnedGroups(
  history: readonly ProviderMessage[],
  ledgerByIndex: Map<number, PromptLedgerEntry>,
): number[][] {
  const groups: number[][] = []

  for (let index = 0; index < history.length; index += 1) {
    if (isPinned(index, ledgerByIndex)) {
      continue
    }

    const message = history[index]
    if (message?.role === 'user' || groups.length === 0) {
      groups.push([index])
    } else {
      groups.at(-1)!.push(index)
    }
  }

  return groups
}

function selectedMessages(
  history: readonly ProviderMessage[],
  includedIndexes: ReadonlySet<number>,
): ProviderMessage[] {
  return history.filter((_message, index) => includedIndexes.has(index))
}

export function selectPromptMessages(options: {
  state: PromptLedgerState
  tools: JsonValue[]
  maxPromptTokens: number
  estimation: PublicConfig['limits']['tokenEstimation']
}): PromptSelection {
  const ledgerByIndex = new Map(
    options.state.promptLedger.map((entry) => [entry.messageIndex, entry]),
  )
  const groups = nonPinnedGroups(options.state.history, ledgerByIndex)
  const selectedGroups = [...groups]
  const toolsHash = hashJson(options.tools)
  let included = new Set<number>()

  const rebuildIncluded = () => {
    included = new Set(
      options.state.promptLedger.map((entry) => entry.messageIndex),
    )
    for (const group of selectedGroups) {
      for (const index of group) {
        included.add(index)
      }
    }
  }

  rebuildIncluded()
  let messages = selectedMessages(options.state.history, included)

  while (
    selectedGroups.length > 1 &&
    estimateJsonTokens(messages, options.estimation) > options.maxPromptTokens
  ) {
    selectedGroups.shift()
    rebuildIncluded()
    messages = selectedMessages(options.state.history, included)
  }

  const estimatedTokens = estimateJsonTokens(messages, options.estimation)

  if (estimatedTokens > options.maxPromptTokens) {
    throw new ContextBudgetError(
      'The latest complete conversation turn exceeds the model context budget',
    )
  }

  const layers: PromptLayerSummary[] = options.state.promptLedger.map(
    (entry) => ({
      seq: entry.seq,
      messageIndex: entry.messageIndex,
      kind: entry.kind,
      role: entry.role,
      source: entry.source,
      trusted: entry.trusted,
      editable: entry.editable,
      sha256: entry.sha256,
      estimatedTokens: entry.estimatedTokens,
      included: included.has(entry.messageIndex),
      truncated: false,
    }),
  )

  return {
    messages,
    promptBuild: {
      schemaVersion: 1,
      layers,
      messageCount: messages.length,
      historyMessageCount: options.state.history.length,
      ledgerMessageCount: options.state.promptLedger.length,
      omittedHistoryMessages: options.state.history.length - messages.length,
      promptBudgetTokens: options.maxPromptTokens,
      estimatedTokens,
      toolsHash,
    },
  }
}

export function promptResources(
  state: PromptLedgerState,
): PromptResourceSummary[] {
  const resources = state.promptLedger.flatMap((entry) =>
    entry.resource ? [entry.resource] : [],
  )
  const seen = new Set<string>()
  return resources.filter((resource) => {
    const key = `${resource.id}:${resource.sha256}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function selectedContextContent(
  content: string,
  source: string,
): string {
  return tagged('selected_context', { source }, content)
}

export function orchestrationRequestContent(
  kind: string,
  content: string,
): string {
  return tagged('orchestration_request', { kind }, content)
}

export function compactHistoryContent(content: string): string {
  return tagged('compact_history', { source: 'history_compaction' }, content)
}
