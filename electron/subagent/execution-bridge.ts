import type {
  SubagentExecutionPort,
  SubagentParentContext,
  SubagentRunResult,
  SubagentSpec,
} from './contracts'

/** Breaks runtime construction cycles by binding the Subagent implementation after SessionManager exists. */
export class SubagentExecutionBridge implements SubagentExecutionPort {
  #target: SubagentExecutionPort | undefined

  /** Binds the sole runtime implementation once during backend construction. */
  bind(target: SubagentExecutionPort): void {
    if (this.#target && this.#target !== target) {
      throw new Error('Subagent execution bridge is already bound')
    }
    this.#target = target
  }

  /** Delegates one execution to the bound runtime service. */
  runOne(
    spec: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<SubagentRunResult> {
    if (!this.#target) {
      return Promise.reject(new Error('Subagent runtime is not available'))
    }
    return this.#target.runOne(spec, parent)
  }
}
