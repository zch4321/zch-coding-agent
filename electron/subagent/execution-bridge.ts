import type {
  PreparedSubagentExecution,
  PreparedSubagentExecutionPort,
  BackgroundArtifactStatus,
  BackgroundTaskHandle,
  SubagentParentContext,
  SubagentRunResult,
  SubagentSpec,
} from './contracts'
import type { AgentExecutionId, SessionId } from '../../shared/ids'

/** Breaks runtime construction cycles by binding the Subagent implementation after SessionManager exists. */
export class SubagentExecutionBridge implements PreparedSubagentExecutionPort {
  #target: PreparedSubagentExecutionPort | undefined

  /** Binds the sole runtime implementation once during backend construction. */
  bind(target: PreparedSubagentExecutionPort): void {
    if (this.#target && this.#target !== target) {
      throw new Error('Subagent execution bridge is already bound')
    }
    this.#target = target
  }

  /** Starts one detached execution and returns its durable handle. */
  startOne(
    spec: SubagentSpec,
    parent: SubagentParentContext,
  ): Promise<BackgroundTaskHandle> {
    if (!this.#target) {
      return Promise.reject(new Error('Subagent runtime is not available'))
    }
    if (!this.#target.startOne) {
      return Promise.reject(new Error('Detached Subagent start is unavailable'))
    }
    return this.#target.startOne(spec, parent)
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

  /** Delegates one pre-persisted Swarm child to the bound runtime service. */
  runPrepared(
    spec: SubagentSpec,
    parent: SubagentParentContext,
    prepared: PreparedSubagentExecution,
  ): Promise<SubagentRunResult> {
    if (!this.#target) {
      return Promise.reject(new Error('Subagent runtime is not available'))
    }
    return this.#target.runPrepared(spec, parent, prepared)
  }

  /** Cancels one active child through the bound runtime. */
  async cancel(
    parentSessionId: SessionId,
    executionId: AgentExecutionId,
  ): Promise<boolean> {
    return (await this.#target?.cancel?.(parentSessionId, executionId)) ?? false
  }

  /** Returns in-process artifact capture state when the execution is live. */
  artifactStatus(
    executionId: AgentExecutionId,
  ): BackgroundArtifactStatus | undefined {
    return this.#target?.artifactStatus?.(executionId)
  }
}
