import type { CallId } from '../../shared/ids'
import type {
  LLMProvider,
  ProviderStreamRequest,
  ProviderEvent,
} from '../providers/provider'

export class GoalContinuationProvider implements LLMProvider {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []

  async *stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))

    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'goal-first' },
        turn: { role: 'assistant', content: 'Working on the goal' },
        toolCalls: [],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    if (this.calls === 2) {
      const args = {
        summary: 'Goal finished',
        evidence: 'Continuation requested explicit completion',
        remainingRisks: 'none',
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'goal-complete' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-goal-complete',
              type: 'function',
              function: {
                name: 'goal_complete',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-goal-complete' as CallId,
            toolId: 'goal_complete',
            args,
            reason: 'The goal is complete',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: 'goal-final' },
      turn: { role: 'assistant', content: 'Goal complete' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

export class PlanWarningProvider implements LLMProvider {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []

  constructor(private readonly activatePlan = false) {}

  async *stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))

    if (this.calls === 1) {
      const args = { items: ['Inspect state', 'Report result'] }
      yield {
        type: 'completed',
        rawResponse: { id: 'plan-set' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-plan-set',
              type: 'function',
              function: {
                name: 'plan_set',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-plan-set' as CallId,
            toolId: 'plan_set',
            args,
            reason: 'Create the requested plan',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    if (this.calls === 2 && this.activatePlan) {
      const args = { status: 'active' }
      yield {
        type: 'completed',
        rawResponse: { id: 'plan-activate' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-plan-status',
              type: 'function',
              function: {
                name: 'plan_status',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-plan-status' as CallId,
            toolId: 'plan_status',
            args,
            reason: 'The user approved the plan',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: `plan-open-${this.calls}` },
      turn: { role: 'assistant', content: 'Plan still open' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

export class PlanCompletionProvider implements LLMProvider {
  calls = 0
  requests: ProviderStreamRequest['normalizedMessages'][] = []

  async *stream(request: ProviderStreamRequest): AsyncIterable<ProviderEvent> {
    this.calls += 1
    this.requests.push(structuredClone(request.normalizedMessages))

    if (this.calls === 1) {
      const args = { items: ['Inspect state'] }
      yield {
        type: 'completed',
        rawResponse: { id: 'plan-set' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-plan-set',
              type: 'function',
              function: {
                name: 'plan_set',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-plan-set' as CallId,
            toolId: 'plan_set',
            args,
            reason: 'Create the requested plan',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    if (this.calls === 2) {
      const args = { status: 'active' }
      yield {
        type: 'completed',
        rawResponse: { id: 'plan-active' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-plan-status',
              type: 'function',
              function: {
                name: 'plan_status',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-plan-status' as CallId,
            toolId: 'plan_status',
            args,
            reason: 'The plan is approved',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    if (this.calls === 3) {
      const args = {
        id: 'item:1',
        status: 'completed',
        result: 'Inspection completed',
        evidence: 'Observed the requested state',
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'plan-item-complete' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-plan-update',
              type: 'function',
              function: {
                name: 'plan_update',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-plan-update' as CallId,
            toolId: 'plan_update',
            args,
            reason: 'Mark the item complete',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'completed',
      rawResponse: { id: 'plan-complete-final' },
      turn: { role: 'assistant', content: 'Plan items done' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}
