import type { SessionOrchestratorMessages } from './session-orchestrator-messages'
import type { ActiveRun, AgentEventDraft, SessionState } from './session-types'

const MAX_GOAL_CONTINUATIONS = 8

export class SessionOrchestrationPlanner {
  readonly #orchestratorMessages: SessionOrchestratorMessages
  readonly #emit: (session: SessionState, event: AgentEventDraft) => void

  constructor(options: {
    orchestratorMessages: SessionOrchestratorMessages
    emit: (session: SessionState, event: AgentEventDraft) => void
  }) {
    this.#orchestratorMessages = options.orchestratorMessages
    this.#emit = options.emit
  }

  async nextStep(
    session: SessionState,
    run: ActiveRun,
  ): Promise<'continue' | 'finish'> {
    const goal = session.goal

    if (goal?.status === 'active') {
      if (goal.continuationCount >= MAX_GOAL_CONTINUATIONS) {
        goal.status = 'paused'
        goal.updatedAt = new Date().toISOString()
        this.#emit(session, {
          type: 'goal.updated',
          sessionId: session.sessionId,
          runId: run.runId,
          goal: structuredClone(goal),
        })
        await this.#orchestratorMessages.emit(session, run, {
          kind: 'goal-paused',
          text: 'Goal auto-continuation limit reached. The Goal was paused instead of being marked complete.',
          injectIntoHistory: false,
        })
        return 'finish'
      }

      goal.continuationCount += 1
      goal.updatedAt = new Date().toISOString()
      this.#emit(session, {
        type: 'goal.updated',
        sessionId: session.sessionId,
        runId: run.runId,
        goal: structuredClone(goal),
      })
      const prompt = this.#orchestratorMessages.prompt('goalContinue')
      await this.#orchestratorMessages.emit(session, run, {
        kind: 'goal-continuation',
        text: [
          prompt.text,
          '',
          `Goal objective: ${goal.objective}`,
          `Goal state: ${JSON.stringify(goal)}`,
          session.plan
            ? `Current plan state: ${JSON.stringify(session.plan)}`
            : 'Current plan state: none',
        ].join('\n'),
        resource: prompt.resource,
        injectIntoHistory: true,
      })
      return 'continue'
    }

    const plan = session.plan
    const openItems = (plan?.items ?? []).filter(
      (item) => item.status !== 'completed' && item.status !== 'cancelled',
    )

    if (
      !plan ||
      (plan.status ?? 'active') !== 'active' ||
      openItems.length === 0
    ) {
      return 'finish'
    }

    if (plan.continuationCount < 1) {
      plan.continuationCount += 1
      plan.updatedAt = new Date().toISOString()
      this.#emit(session, {
        type: 'plan.updated',
        sessionId: session.sessionId,
        runId: run.runId,
        plan: structuredClone(plan),
      })
      const prompt = this.#orchestratorMessages.prompt('planContinue')
      await this.#orchestratorMessages.emit(session, run, {
        kind: 'plan-continuation',
        text: [
          prompt.text,
          '',
          `Plan objective: ${plan.objective}`,
          `Open plan items: ${JSON.stringify(openItems)}`,
        ].join('\n'),
        resource: prompt.resource,
        injectIntoHistory: true,
      })
      return 'continue'
    }

    const prompt = this.#orchestratorMessages.prompt('planWarning')
    plan.warning = prompt.text
    plan.updatedAt = new Date().toISOString()
    this.#emit(session, {
      type: 'plan.updated',
      sessionId: session.sessionId,
      runId: run.runId,
      plan: structuredClone(plan),
    })
    await this.#orchestratorMessages.emit(session, run, {
      kind: 'plan-warning',
      text: prompt.text,
      resource: prompt.resource,
      injectIntoHistory: false,
    })
    return 'finish'
  }
}
