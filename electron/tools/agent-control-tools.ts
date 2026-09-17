import { Type } from '@sinclair/typebox'
import {
  BackgroundTaskError,
  type BackgroundTaskPort,
} from '../background/contracts'
import type { ToolDefinition, ToolRegistrationPort } from './types'

const TargetSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('subagent'), Type.Literal('swarm')]),
    id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
)

/** Registers parent-only text messaging and cooperative pause/resume controls. */
export function registerAgentControlTools(
  registry: ToolRegistrationPort,
  tasks: BackgroundTaskPort,
): void {
  for (const action of ['send', 'pause', 'resume'] as const) {
    const schema = Type.Object(
      {
        target: TargetSchema,
        ...(action === 'send'
          ? { message: Type.String({ minLength: 1, maxLength: 32768 }) }
          : {}),
      },
      { additionalProperties: false },
    )
    registry.registerTool({
      id: action === 'send' ? 'subagent_send_message' : `background_${action}`,
      description:
        action === 'send'
          ? 'Send text to a child target, including a Swarm child. Running children receive an interjection; paused children resume; finished children continue the same conversation in a new Run. Prefer a new Swarm for new assignments; follow up on a Swarm child only when its existing context is useful.'
          : action === 'pause'
            ? 'Request a safe pause for a child or every member of a Swarm. Returns immediately; the current model response and complete tool batch finish before pausing.'
            : 'Continue a paused child Run, or all paused members of a Swarm, preserving its commands and progress. Running children are unchanged; finished children require subagent_send_message.',
      inputSchema: schema,
      executionMode: 'parallel',
      effects: [],
      defaultRisk: 'low',
      supportsAbort: true,
      defaultTimeoutMs: 30000,
      async execute(args, context) {
        if (
          context.ownerSessionId &&
          context.ownerSessionId !== context.sessionId
        )
          throw new BackgroundTaskError(
            'BACKGROUND_CONTROL_FORBIDDEN',
            'Child agents cannot control the orchestration tree',
          )
        if (!tasks.control)
          throw new BackgroundTaskError(
            'BACKGROUND_CONTROL_UNAVAILABLE',
            'Agent controls are unavailable',
          )
        return {
          status: 'ok',
          content: await tasks.control({
            action,
            target: args.target,
            message:
              typeof args.message === 'string' ? args.message : undefined,
            parent: {
              sessionId: context.sessionId,
              runId: context.runId,
              callId: context.approvedCall.callId,
              workspace: context.workspace.canonicalPath,
              signal: context.signal,
              sessionTemp: context.sessionTemp,
              maxSubagents: context.maxSubagents,
            },
          }),
        }
      },
    } satisfies ToolDefinition<typeof schema>)
  }
}
