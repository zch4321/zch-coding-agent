import type { SwarmRunArgs, SwarmRunResult } from '../../shared/swarm'
import type { SubagentParentContext } from '../subagent/contracts'
import type {
  BackgroundArtifactStatus,
  BackgroundTaskHandle,
} from '../subagent/contracts'
import type { AgentExecutionId, SessionId } from '../../shared/ids'

export type SwarmParentContext = SubagentParentContext

/** Carries stable Swarm failures through Tool Result normalization. */
export class SwarmRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SwarmRuntimeError'
  }
}

/** Executes one model-pool Swarm Job for a live parent Run. */
export interface SwarmExecutionPort {
  start?(
    args: SwarmRunArgs,
    parent: SwarmParentContext,
  ): Promise<BackgroundTaskHandle>
  run(args: SwarmRunArgs, parent: SwarmParentContext): Promise<SwarmRunResult>
  cancel?(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<boolean>
  artifactStatus?(
    executionId: AgentExecutionId,
  ): BackgroundArtifactStatus | undefined
}
