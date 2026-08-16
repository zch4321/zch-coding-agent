import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { PublicConfig } from '../../shared/config'
import type { PromptBuildSummary } from '../../shared/trace'
import type { MessageId } from '../../shared/ids'
import type {
  CanonicalPromptKind,
  MessageRecord,
  MessageVisibility,
} from '../../shared/message'
import { LEGACY_DEFAULT_SYSTEM_PROMPTS } from '../../shared/system-prompts'
import type { PromptRegistry, PromptResourceSummary } from '../prompts/registry'
import type { ProviderToolDefinition } from '../providers/provider'
import { estimateJsonTokens } from '../tools/context-budget'
import { commandShellService } from '../process/command-shell'
import {
  formatAgentsInstructions,
  loadAgentsInstructions,
} from './agents-context'
import {
  appendPromptMessage,
  latestPromptHash,
  MessageHistoryCompiler,
  type CanonicalHistoryState,
} from './canonical-history'

const MAX_TREE_DEPTH = 3
const MAX_TREE_ENTRIES = 300
const MAX_TREE_ENTRIES_PER_DIRECTORY = 60
const MAX_MODULES = 24
const GIT_TIMEOUT_MS = 1_500
const GIT_MAX_OUTPUT_BYTES = 8 * 1_024
const EMPTY_AGENTS_CONTEXT_HASH = sha256('')

export type PromptHistoryState = CanonicalHistoryState

export interface PromptSelection {
  messages: readonly MessageRecord[]
  promptBuild: PromptBuildSummary
}

export type WorkspaceConcurrencyContext =
  | { status: 'available' }
  | { status: 'writer'; writerSessionId: string; writerRunId: string }
  | {
      status: 'readonly_locked'
      writerSessionId: string
      writerRunId: string
    }

interface RuntimeContextInput {
  workspace: string
  mode: string
  config: PublicConfig
  providerId: string
  promptRegistry?: PromptRegistry
  reason: string
  workspaceConcurrency?: WorkspaceConcurrencyContext
  toolNames?: readonly string[]
  signal?: AbortSignal
}

interface HarnessPromptInput {
  workspace: string
  mode: string
  config: PublicConfig
  providerId: string
  promptRegistry?: PromptRegistry
  skillSummary?: string
  workspaceConcurrency?: WorkspaceConcurrencyContext
  toolNames?: readonly string[]
  signal?: AbortSignal
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value))
}

function currentTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
  const offsetMinutes = -new Date().getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const minutes = String(absolute % 60).padStart(2, '0')
  return `${timeZone} (UTC${sign}${hours}:${minutes})`
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

  if (kind === 'baseInstructions') {
    return { content: LEGACY_DEFAULT_SYSTEM_PROMPTS[locale] }
  }
  return {
    content: [
      '<environment_context>',
      'current_date: ${currentDate}',
      'current_time: ${currentTime}',
      'timezone: ${timezone}',
      'workspace: ${workspace}',
      'cwd: ${cwd}',
      'command_shell: ${commandShell}',
      'os: ${osInfo}',
      'assistant_language: ${assistantLanguage}',
      'permission_mode: ${permissionMode}',
      'provider: ${providerLabel} (${providerId})',
      'model: ${model}',
      'builtin_policies: ${builtinPolicies}',
      'remembered_rules: ${rememberedRules}',
      'sensitive_data_mode: ${sensitiveDataMode}',
      'available_tools: ${availableTools}',
      '${gitSummary}',
      'project_tree_depth_${projectTreeDepth}:',
      '${projectTree}',
      '<project_model status="${moduleStatus}">',
      '${moduleContent}',
      '</project_model>',
      '<workspace_concurrency status="${workspaceConcurrencyStatus}">',
      '${workspaceConcurrencyContent}',
      '</workspace_concurrency>',
      '</environment_context>',
    ].join('\n'),
  }
}

/** Appends a prompt layer with provenance and stable canonical-history metadata. */
export function appendPromptLayer(
  state: PromptHistoryState,
  input: {
    kind: Exclude<CanonicalPromptKind, 'conversation_transcript'>
    content: string
    source: string
    trusted: boolean
    editable: boolean
    config: PublicConfig
    resource?: PromptResourceSummary
    hash?: string
    turnId?: MessageId
    interjectionId?: string
    visibility?: Exclude<MessageVisibility, 'superseded'>
  },
): MessageRecord {
  return appendPromptMessage(state, input)
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

/** Replaces required template variables and rejects unresolved placeholders. */
export function renderPromptTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  const rendered = template.replace(
    /\$\{([A-Za-z][A-Za-z0-9_]*)\}/gu,
    (_match, name: string) => {
      if (!(name in variables)) {
        throw new Error(`Prompt template references unknown variable: ${name}`)
      }

      return variables[name]!
    },
  )

  if (rendered.includes('${')) {
    throw new Error('Prompt template contains unresolved variables')
  }

  return rendered
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

async function projectContextSummary(input: RuntimeContextInput): Promise<{
  status: string
  content: string
}> {
  return {
    status: 'detected',
    content: await detectModules(input.workspace).catch(
      () => 'No module summary available.',
    ),
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
  const [git, projectTree, modules, commandShell] = await Promise.all([
    gitSummary(input.workspace, input.signal).catch(() => 'git: unavailable'),
    projectTreeSummary(input.workspace).catch(() => 'unavailable'),
    projectContextSummary(input),
    commandShellService.resolve(input.config.executionEnvironment.commandShell),
  ])
  const currentTime = new Date().toISOString()
  const concurrency = input.workspaceConcurrency ?? { status: 'available' }
  const workspaceConcurrencyContent =
    locale === 'zh-CN'
      ? workspaceConcurrencyContentZh(concurrency)
      : workspaceConcurrencyContentEn(concurrency)
  const content = renderPromptTemplate(prompt.content, {
    currentDate: new Date().toISOString().slice(0, 10),
    currentTime,
    timezone: currentTimeZone(),
    workspace: input.workspace,
    cwd: input.workspace,
    commandShell: `${commandShell.profile.label} (${commandShell.profile.id})`,
    osInfo: `${os.platform()} ${os.release()}`,
    assistantLanguage: locale,
    permissionMode: input.mode,
    providerLabel: provider?.label ?? input.providerId,
    providerId: input.providerId,
    model: provider?.model ?? 'unknown',
    builtinPolicies: input.config.permission.builtinPolicies
      ? 'enabled'
      : 'disabled',
    rememberedRules: String(input.config.permission.rememberedRules.length),
    sensitiveDataMode: input.config.permission.sensitiveData.mode,
    availableTools: input.toolNames?.join(', ') || 'not listed',
    gitSummary: git,
    projectTreeDepth: String(MAX_TREE_DEPTH),
    projectTree,
    moduleStatus: escapeAttribute(modules.status),
    moduleContent: modules.content,
    workspaceConcurrencyStatus: concurrency.status,
    workspaceConcurrencyContent,
  })
  const stableContent = content.replace(currentTime, '<current_time_snapshot>')

  return {
    content,
    hash: sha256(stableContent),
    ...(prompt.resource ? { resource: prompt.resource } : {}),
  }
}

function workspaceConcurrencyContentEn(
  context: WorkspaceConcurrencyContext,
): string {
  if (context.status === 'available') {
    return 'No agent run currently owns the workspace writer.'
  }

  if (context.status === 'writer') {
    return [
      'This session owns the workspace writer for its complete run.',
      `writer_session_id: ${escapeAttribute(context.writerSessionId)}`,
      `writer_run_id: ${escapeAttribute(context.writerRunId)}`,
    ].join('\n')
  }

  return [
    'Another agent run is modifying this workspace. This session is forcibly restricted to readonly access.',
    'Do not write or delete files, modify Git or project metadata, write to terminals, spawn side-effecting processes, access the network for side effects, or call any other mutating tool.',
    'After the writer finishes, reread relevant files before drawing conclusions because prior workspace state may be stale.',
    `writer_session_id: ${escapeAttribute(context.writerSessionId)}`,
    `writer_run_id: ${escapeAttribute(context.writerRunId)}`,
  ].join('\n')
}

function workspaceConcurrencyContentZh(
  context: WorkspaceConcurrencyContext,
): string {
  if (context.status === 'available') {
    return '当前没有 agent run 持有 workspace writer。'
  }

  if (context.status === 'writer') {
    return [
      '当前 session 在完整 run 生命周期内持有 workspace writer。',
      `writer_session_id: ${escapeAttribute(context.writerSessionId)}`,
      `writer_run_id: ${escapeAttribute(context.writerRunId)}`,
    ].join('\n')
  }

  return [
    '另一个 agent run 正在修改同一 workspace；当前 session 被强制限制为只读。',
    '不得写入或删除文件、修改 Git 或项目元数据、写入终端、启动有副作用的进程、执行有副作用的网络访问，或调用任何其他 mutating tool。',
    'writer 结束后必须重新读取相关文件再下结论，避免依据过期的 workspace 状态。',
    `writer_session_id: ${escapeAttribute(context.writerSessionId)}`,
    `writer_run_id: ${escapeAttribute(context.writerRunId)}`,
  ].join('\n')
}

async function agentsContext(input: HarnessPromptInput): Promise<{
  content: string
  hash: string
} | null> {
  const agents = await loadAgentsInstructions({
    workspace: input.workspace,
    attachments: [],
    signal: input.signal,
  })
  const formatted = formatAgentsInstructions(agents)
  if (!formatted) {
    return null
  }

  return { content: formatted, hash: sha256(formatted) }
}

/** Appends localized initial harness resources when they are absent from prompt history. */
export async function appendInitialPromptHarness(
  state: PromptHistoryState,
  input: HarnessPromptInput,
): Promise<void> {
  const locale = input.config.assistant.language
  const base = resourceContent(input.promptRegistry, 'baseInstructions', locale)
  appendPromptLayer(state, {
    kind: 'system_instruction',
    content: base.content,
    source: base.resource?.path ?? 'fallback:harness.base-instructions',
    trusted: true,
    editable: false,
    config: input.config,
    ...(base.resource ? { resource: base.resource } : {}),
  })

  await appendRuntimeContextIfChanged(state, {
    ...input,
    reason: 'session_created',
  })

  const preferences = input.config.assistant.preferences[locale].trim()
  appendPromptLayer(state, {
    kind: 'assistant_preferences',
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
  if (agents) {
    appendPromptLayer(state, {
      kind: 'agents_context',
      content: agents.content,
      source: 'workspace:AGENTS',
      trusted: false,
      editable: false,
      config: input.config,
    })
  }

  const skillSummary = input.skillSummary?.trim()
  if (skillSummary) {
    appendPromptLayer(state, {
      kind: 'selected_context',
      content: tagged(
        'selected_context',
        { source: 'skills', status: 'enabled' },
        tagged('skills_summary', { source: 'enabled_skills' }, skillSummary),
      ),
      source: 'skills.summary',
      trusted: false,
      editable: false,
      config: input.config,
    })
  }
}

/** Appends runtime context only when its canonical content differs from the previous version. */
export async function appendRuntimeContextIfChanged(
  state: PromptHistoryState,
  input: RuntimeContextInput,
): Promise<boolean> {
  const runtime = await runtimeContext(input)

  if (latestPromptHash(state, 'runtime_context') === runtime.hash) {
    return false
  }

  appendPromptLayer(state, {
    kind: 'runtime_context',
    content: runtime.content,
    source: runtime.resource?.path ?? 'fallback:harness.runtime-context',
    trusted: true,
    editable: false,
    config: input.config,
    hash: runtime.hash,
    ...(runtime.resource ? { resource: runtime.resource } : {}),
  })
  return true
}

/** Loads AGENTS context and appends it only when its cache key has changed. */
export async function appendAgentsContextIfChanged(
  state: PromptHistoryState,
  input: HarnessPromptInput,
): Promise<boolean> {
  const agents = await agentsContext(input)
  const hash = agents?.hash ?? EMPTY_AGENTS_CONTEXT_HASH

  if (latestPromptHash(state, 'agents_context') === hash) {
    return false
  }

  if (!agents) {
    return false
  }

  appendPromptLayer(state, {
    kind: 'agents_context',
    content: agents.content,
    source: 'workspace:AGENTS',
    trusted: false,
    editable: false,
    config: input.config,
  })
  return true
}

/** Selects all active history and records an advisory prompt-token estimate. */
export function selectPromptMessages(options: {
  state: PromptHistoryState
  tools: ProviderToolDefinition[]
  maxPromptTokens: number
  estimation: PublicConfig['limits']['tokenEstimation']
}): PromptSelection {
  const compiled = new MessageHistoryCompiler().compile(options.state.history)
  const messages = compiled.messages
  const toolsHash = hashJson(options.tools)
  const estimatedTokens = estimateJsonTokens(
    { messages, tools: options.tools },
    options.estimation,
  )

  const layers = messages.flatMap((record) => {
    const layer =
      record.metadata && 'layer' in record.metadata
        ? record.metadata.layer
        : undefined
    if (!layer) return []
    return [
      {
        seq: record.seq,
        messageId: record.id,
        kind: record.kind as CanonicalPromptKind,
        source: layer.source,
        trusted: layer.trusted,
        editable: layer.editable,
        sha256: layer.hash,
        estimatedTokens: estimateJsonTokens(record.parts, options.estimation),
        included: true,
        truncated: false,
      },
    ]
  })

  return {
    messages,
    promptBuild: {
      schemaVersion: 2,
      layers,
      messageCount: messages.length,
      activeMessageCount: messages.length,
      omittedHistoryMessages: 0,
      promptBudgetTokens: options.maxPromptTokens,
      estimatedTokens,
      toolsHash,
      sourceHash: compiled.sourceHash,
    },
  }
}

/** Returns the prompt-resource summaries present in prompt history. */
export function promptResources(
  state: PromptHistoryState,
): PromptResourceSummary[] {
  const resources = state.history.flatMap((record) => {
    if (
      !record.inHistory ||
      !record.metadata ||
      !('layer' in record.metadata) ||
      !('prompt' in record.metadata) ||
      !record.metadata.prompt
    ) {
      return []
    }
    return [
      {
        id: record.metadata.prompt.resourceId,
        version: record.metadata.prompt.version,
        path: record.metadata.layer.source,
        sha256: record.metadata.prompt.hash,
      },
    ]
  })
  const seen = new Set<string>()
  return resources.filter((resource) => {
    const key = `${resource.id}:${resource.sha256}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Wraps selected context in the tagged prompt block consumed by the provider. */
export function selectedContextContent(
  content: string,
  source: string,
): string {
  return tagged('selected_context', { source }, content)
}

/** Wraps an orchestration request in its tagged prompt block. */
export function orchestrationRequestContent(
  kind: string,
  content: string,
): string {
  return tagged('orchestration_request', { kind }, content)
}

/** Wraps a history-compaction summary in its tagged prompt block. */
export function compactHistoryContent(content: string): string {
  return tagged('compact_history', { source: 'history_compaction' }, content)
}
