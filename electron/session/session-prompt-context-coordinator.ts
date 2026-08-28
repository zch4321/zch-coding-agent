import type { ConfigStore } from '../config/store'
import type { PromptRegistry } from '../prompts/registry'
import type { ToolRegistry } from '../tools/tool-registry'
import {
  appendAgentsContextIfChanged,
  appendRuntimeContextIfChanged,
} from './prompt-harness'
import { resolveSessionToolCatalog } from './session-tool-catalog'
import type { ActiveRun, SessionState } from './session-types'

/** Refreshes prompt context once at the externally initiated Run boundary. */
export class SessionPromptContextCoordinator {
  readonly #configStore: ConfigStore
  readonly #toolRegistry: ToolRegistry
  readonly #promptRegistry: PromptRegistry | undefined

  /** Creates a coordinator for runtime and workspace-instruction context. */
  constructor(options: {
    configStore: ConfigStore
    toolRegistry: ToolRegistry
    promptRegistry?: PromptRegistry
  }) {
    this.#configStore = options.configStore
    this.#toolRegistry = options.toolRegistry
    this.#promptRegistry = options.promptRegistry
  }

  /** Appends changed runtime and AGENTS layers for one newly started Run. */
  async refresh(session: SessionState, run: ActiveRun): Promise<void> {
    const binding = run.routes?.main
    if (!binding) throw new Error('Run model routes were not resolved')

    const config = this.#configStore.getPublicConfig()
    const toolCatalog = await resolveSessionToolCatalog({
      registry: this.#toolRegistry,
      allowedToolIds: run.allowedToolIds,
      subagentsEnabled: run.subagentsEnabled,
      swarmEnabled: Boolean(run.swarmToolConfig),
      gitToolsEnabled: session.gitToolsEnabled,
    })
    const input = {
      workspace: session.workspace,
      mode: session.mode,
      config,
      providerId: binding.snapshot.providerId,
      promptRegistry: this.#promptRegistry,
      toolNames: toolCatalog.names,
      signal: run.controller.signal,
    }

    await appendRuntimeContextIfChanged(session, {
      ...input,
      reason: 'run_started',
    })
    await appendAgentsContextIfChanged(session, input)
  }
}
