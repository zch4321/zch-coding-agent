import path from 'node:path'
import type { ConfigStore } from '../config/store'
import { Disposer } from '../disposer'
import { TraceService } from '../logging/service'
import { McpManager } from '../mcp/mcp-manager'
import { PluginEventBus } from '../plugins/event-bus'
import { PromptRegistry } from '../prompts/registry'
import type { AutoApprover } from '../permission/auto-approver'
import type { ModelProvider } from '../providers/provider'
import { SessionManager } from '../session/session-manager'
import { SkillsManager } from '../skills/manager'
import { AgentRuntime } from './agent-runtime'
import { RuntimeEventBus } from './runtime-event-bus'
import type { RuntimeEventListener } from './runtime-events'
import type {
  SessionExecutionStatePort,
  SessionHistorySourcePort,
} from '../session/session-types'
import type { SubagentExecutionPort } from '../subagent/contracts'
import type { SwarmExecutionPort } from '../swarm/contracts'
import type { OperationalLogService } from '../operational-logging/service'
import {
  desktopSessionTempRoot,
  SessionTempService,
} from '../session-temp/service'
import type { BackgroundTaskPort } from '../background/contracts'

export interface CreateAgentRuntimeOptions {
  backendInstanceId?: string
  configStore: ConfigStore
  userDataDirectory: string
  promptDirectory: string
  fetchImpl?: typeof fetch
  providerFactory?: (options: {
    config: ReturnType<ConfigStore['getPublicConfig']>
    apiKey: string
  }) => ModelProvider
  autoApproverFactory?: (options: {
    config: ReturnType<ConfigStore['getPublicConfig']>
    apiKey: string
  }) => AutoApprover
  eventListeners?: RuntimeEventListener[]
  executionState?: SessionExecutionStatePort
  historySource?: SessionHistorySourcePort
  subagentExecution?: SubagentExecutionPort
  swarmExecution?: SwarmExecutionPort
  backgroundTasks?: BackgroundTaskPort
  swarmHostEnabled?: boolean
  onDiagnostic?: (message: string, error?: unknown) => void
  operationalLog?: Pick<OperationalLogService, 'log'>
  sessionTemps?: SessionTempService
}

/** Builds the privileged services, event plumbing, and AgentRuntime composition. */
export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const onDiagnostic = options.onDiagnostic ?? (() => undefined)
  const disposer = new Disposer({
    timeoutMs: 5_000,
    onError: (error) => onDiagnostic('Agent runtime cleanup failed', error),
  })
  const events = new RuntimeEventBus({
    onDiagnostic,
    backendInstanceId: options.backendInstanceId,
  })
  disposer.add(() => events.dispose())

  for (const listener of options.eventListeners ?? []) {
    const unsubscribe = events.subscribe(listener)
    disposer.add(unsubscribe)
  }

  try {
    const sessionTemps =
      options.sessionTemps ??
      new SessionTempService({
        rootDirectory: desktopSessionTempRoot(options.userDataDirectory),
        onDiagnostic,
      })
    if (!options.sessionTemps) await sessionTemps.initialize()
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
      mcpManager: mcp,
      subagentExecution: options.subagentExecution,
      swarmExecution: options.swarmExecution,
      backgroundTasks: options.backgroundTasks,
      swarmHostEnabled: options.swarmHostEnabled,
      promptRegistry,
      fetchImpl: options.fetchImpl,
      providerFactory: options.providerFactory,
      autoApproverFactory: options.autoApproverFactory,
      executionState: options.executionState,
      historySource: options.historySource,
      onDiagnostic,
      operationalLog: options.operationalLog,
      sessionTemps,
    })
    disposer.add(() => sessions.dispose())

    return new AgentRuntime({
      events,
      services: {
        sessions,
        skills,
        traces,
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
