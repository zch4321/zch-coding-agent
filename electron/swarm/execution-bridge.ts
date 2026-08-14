import type { SwarmRunArgs, SwarmRunResult } from '../../shared/swarm'
import type { SwarmExecutionPort, SwarmParentContext } from './contracts'

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

  /** Delegates one Job to the bound Swarm coordinator. */
  run(args: SwarmRunArgs, parent: SwarmParentContext): Promise<SwarmRunResult> {
    if (!this.#target) {
      return Promise.reject(new Error('Swarm runtime is not available'))
    }
    return this.#target.run(args, parent)
  }
}
