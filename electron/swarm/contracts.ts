import type { SwarmRunArgs, SwarmRunResult } from '../../shared/swarm'
import type { SubagentParentContext } from '../subagent/contracts'

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
  run(args: SwarmRunArgs, parent: SwarmParentContext): Promise<SwarmRunResult>
}
