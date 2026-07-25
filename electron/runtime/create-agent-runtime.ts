import path from 'node:path'
import type { ConfigStore } from '../config/store'
import { CodeBackendManager } from '../code-intelligence/backend-manager'
import { Disposer } from '../disposer'
import { TraceService } from '../logging/service'
import { McpManager } from '../mcp/mcp-manager'
import { PluginEventBus } from '../plugins/event-bus'
import { ProjectMetadataStore } from '../project/project-metadata-store'
import { PromptRegistry } from '../prompts/registry'
import type { AutoApprover } from '../permission/auto-approver'
import type { LLMProvider } from '../providers/provider'
import { SessionManager } from '../session/session-manager'
import { SkillsManager } from '../skills/manager'
import { AgentRuntime } from './agent-runtime'
import { RuntimeEventBus } from './runtime-event-bus'
import type { RuntimeEventListener } from './runtime-events'
import type { SessionExecutionStatePort } from '../session/session-types'
import type { FileChangeExecutionPort } from '../session/file-change-execution'

export interface CreateAgentRuntimeOptions {
  configStore: ConfigStore
  userDataDirectory: string
  promptDirectory: string
  fetchImpl?: typeof fetch
  providerFactory?: (options: {
    config: ReturnType<ConfigStore['getPublicConfig']>
    apiKey: string
  }) => LLMProvider
  autoApproverFactory?: (options: {
    config: ReturnType<ConfigStore['getPublicConfig']>
    apiKey: string
  }) => AutoApprover
  eventListeners?: RuntimeEventListener[]
  executionState?: SessionExecutionStatePort
  fileChangeExecution: FileChangeExecutionPort
  onDiagnostic?: (message: string, error?: unknown) => void
}

export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const onDiagnostic = options.onDiagnostic ?? (() => undefined)
  const disposer = new Disposer({
    timeoutMs: 5_000,
    onError: (error) => onDiagnostic('Agent runtime cleanup failed', error),
  })
  const events = new RuntimeEventBus({ onDiagnostic })
  disposer.add(() => events.dispose())

  for (const listener of options.eventListeners ?? []) {
    const unsubscribe = events.subscribe(listener)
    disposer.add(unsubscribe)
  }

  try {
    const pluginBus = new PluginEventBus({
      onDiagnostic: (diagnostic, error) =>
        onDiagnostic(`Plugin hook ${diagnostic.hook} failed`, error),
    })
    const skills = new SkillsManager(
      path.join(options.userDataDirectory, 'skills'),
    )
    await skills.initialize()
    const traces = new TraceService(
      path.join(options.userDataDirectory, 'traces'),
    )
    await traces.initialize()
    const projects = new ProjectMetadataStore()
    const codeBackends = new CodeBackendManager({ projectMetadata: projects })
    disposer.add(() => codeBackends.dispose())
    const mcp = new McpManager({
      configStore: options.configStore,
      defaultCwd: options.userDataDirectory,
      onDiagnostic,
    })
    disposer.add(() => mcp.dispose())
    await mcp.initialize()
    const promptRegistry = await PromptRegistry.load(options.promptDirectory)
    const sessions = new SessionManager({
      configStore: options.configStore,
      traceDirectory: traces.directory,
      eventSink: events,
      pluginBus,
      skillsManager: skills,
      fileChangeExecution: options.fileChangeExecution,
      projectMetadata: projects,
      codeBackends,
      mcpManager: mcp,
      promptRegistry,
      fetchImpl: options.fetchImpl,
      providerFactory: options.providerFactory,
      autoApproverFactory: options.autoApproverFactory,
      executionState: options.executionState,
      onDiagnostic,
    })
    disposer.add(() => sessions.dispose())

    return new AgentRuntime({
      events,
      services: {
        sessions,
        skills,
        traces,
        projects,
        codeBackends,
        mcp,
        prompts: promptRegistry,
      },
      dispose: async () => {
        const report = await disposer.dispose()
        if (report.failed > 0 || report.timedOut) {
          onDiagnostic('Agent runtime cleanup did not fully complete', report)
        }
      },
    })
  } catch (error) {
    await disposer.dispose()
    throw error
  }
}
