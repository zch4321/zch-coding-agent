import type { SwarmRunArgs, SwarmRunResult } from '../../shared/swarm'
import type { SwarmExecutionPort, SwarmParentContext } from './contracts'
import type {
  BackgroundArtifactStatus,
  BackgroundTaskHandle,
} from '../subagent/contracts'
import type { AgentExecutionId, SessionId } from '../../shared/ids'

/** Breaks runtime construction cycles until the durable Swarm coordinator is bound. */
export class SwarmExecutionBridge implements SwarmExecutionPort {
  #target: SwarmExecutionPort | undefined

  /** Binds the sole runtime implementation once during backend construction. */
  bind(target: SwarmExecutionPort): void {
    if (this.#target && this.#target !== target) {
      throw new Error('Swarm execution bridge is already bound')
    }
    this.#target = target
  }

  /** Starts one detached Swarm and returns its durable handle. */
  start(
    args: SwarmRunArgs,
    parent: SwarmParentContext,
  ): Promise<BackgroundTaskHandle> {
    if (!this.#target) {
      return Promise.reject(new Error('Swarm runtime is not available'))
    }
    if (!this.#target.start) {
      return Promise.reject(new Error('Detached Swarm start is unavailable'))
    }
    return this.#target.start(args, parent)
  }

  /** Delegates one Job to the bound Swarm coordinator. */
  run(args: SwarmRunArgs, parent: SwarmParentContext): Promise<SwarmRunResult> {
    if (!this.#target) {
      return Promise.reject(new Error('Swarm runtime is not available'))
    }
    return this.#target.run(args, parent)
  }

  /** Cancels an owned Swarm root through the bound coordinator. */
  cancel(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<boolean> {
    return (
      this.#target?.cancel?.(parentSessionId, executionId) ??
      Promise.resolve(false)
    )
  }

  /** Returns in-process Swarm manifest capture state when available. */
  artifactStatus(
    executionId: AgentExecutionId,
  ): BackgroundArtifactStatus | undefined {
    return this.#target?.artifactStatus?.(executionId)
  }
}
