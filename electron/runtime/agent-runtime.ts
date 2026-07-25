import type { PermissionMode } from '../../shared/config'
import type { RunContext } from '../../shared/context'
import type { RunId, SessionId } from '../../shared/ids'
import type { CodeBackendManager } from '../code-intelligence/backend-manager'
import type { TraceService } from '../logging/service'
import type { McpManager } from '../mcp/mcp-manager'
import type { ProjectMetadataStore } from '../project/project-metadata-store'
import type { PromptRegistry } from '../prompts/registry'
import type { SessionManager } from '../session/session-manager'
import type { SkillsManager } from '../skills/manager'
import type { RuntimeEventBus } from './runtime-event-bus'
import type { RunCompletion } from './runtime-events'
import type { RunHarnessContext } from '../session/session-types'

export interface AgentRuntimeServices {
  sessions: SessionManager
  skills: SkillsManager
  traces: TraceService
  projects: ProjectMetadataStore
  codeBackends: CodeBackendManager
  mcp: McpManager
  prompts: PromptRegistry
}

export interface AgentRunHandle {
  sessionId: SessionId
  runId: RunId
  completion: Promise<RunCompletion>
  interrupt: () => boolean
}

export class AgentRuntime {
  readonly services: AgentRuntimeServices
  readonly events: RuntimeEventBus
  readonly #disposeRuntime: () => Promise<void>
  #disposing = false
  #disposePromise: Promise<void> | undefined

  constructor(options: {
    services: AgentRuntimeServices
    events: RuntimeEventBus
    dispose: () => Promise<void>
  }) {
    this.services = options.services
    this.events = options.events
    this.#disposeRuntime = options.dispose
  }

  createSession(input: {
    workspace: string
    mode: PermissionMode
    provider: string
  }): Promise<SessionId> {
    this.#assertAvailable()
    return this.services.sessions.createSession(input)
  }

  run(input: {
    sessionId: SessionId
    message: string
    clientRequestId: string
    context?: RunContext
    harnessContexts?: RunHarnessContext[]
    signal?: AbortSignal
  }): AgentRunHandle {
    this.#assertAvailable()
    if (input.signal?.aborted) {
      throw input.signal.reason
    }
    const runId = this.services.sessions.startRun(input)
    const completion = this.events
      .waitForRun(input.sessionId, runId)
      .then(async (result) => {
        await this.services.sessions.waitForRunSettled(input.sessionId, runId)
        return result
      })
    const interrupt = () =>
      this.services.sessions.interruptRun(input.sessionId, runId)
    const abort = () => interrupt()
    input.signal?.addEventListener('abort', abort, { once: true })
    void completion.then(
      () => input.signal?.removeEventListener('abort', abort),
      () => input.signal?.removeEventListener('abort', abort),
    )
    return {
      sessionId: input.sessionId,
      runId,
      completion,
      interrupt,
    }
  }

  interrupt(sessionId: SessionId, runId: RunId): boolean {
    this.#assertAvailable()
    return this.services.sessions.interruptRun(sessionId, runId)
  }

  closeSession(sessionId: SessionId): Promise<boolean> {
    return this.services.sessions.closeSession(sessionId)
  }

  dispose(): Promise<void> {
    this.#disposing = true
    this.#disposePromise ??= this.#disposeRuntime()
    return this.#disposePromise
  }

  #assertAvailable(): void {
    if (this.#disposing) {
      throw new Error('Agent runtime is disposing')
    }
  }
}
