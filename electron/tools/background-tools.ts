import { Type, type Static } from '@sinclair/typebox'
import type { JsonValue } from '../../shared/json'
import {
  BackgroundTaskError,
  type BackgroundTarget,
  type BackgroundTaskPort,
} from '../background/contracts'
import type { ToolDefinition, ToolRegistrationPort, ToolResult } from './types'

const BackgroundTypeSchema = Type.Union([
  Type.Literal('subagent'),
  Type.Literal('swarm'),
  Type.Literal('terminal'),
])
const BackgroundTargetSchema = Type.Object(
  {
    type: BackgroundTypeSchema,
    id: Type.String({
      minLength: 1,
      maxLength: 256,
      description:
        'Opaque Agent execution id or decimal Terminal id returned by a start tool.',
    }),
  },
  { additionalProperties: false },
)

const WaitSchema = Type.Object(
  {
    targets: Type.Array(BackgroundTargetSchema, {
      minItems: 1,
      maxItems: 64,
    }),
    mode: Type.Optional(
      Type.Union([Type.Literal('any'), Type.Literal('all')], {
        description:
          'Wake after any target or all targets finish. Defaults to any.',
      }),
    ),
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 300_000,
        description:
          'Maximum wait. Agent-only waits default to 5 minutes; any Terminal caps the whole wait at 60 seconds. Use 0 for an immediate snapshot.',
      }),
    ),
  },
  { additionalProperties: false },
)

const ListSchema = Type.Object(
  {
    types: Type.Optional(
      Type.Array(BackgroundTypeSchema, {
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
      }),
    ),
    status: Type.Optional(
      Type.Union([
        Type.Literal('active'),
        Type.Literal('finished'),
        Type.Literal('all'),
      ]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  },
  { additionalProperties: false },
)

const CancelSchema = Type.Object(
  {
    target: BackgroundTargetSchema,
    waitMs: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 60_000,
        description:
          'Optional convergence wait after requesting cancellation. Defaults to 0.',
      }),
    ),
  },
  { additionalProperties: false },
)

type WaitArgs = Static<typeof WaitSchema>
type ListArgs = Static<typeof ListSchema>
type CancelArgs = Static<typeof CancelSchema>

function errorResult(error: unknown): ToolResult {
  return {
    status: 'error',
    code:
      error instanceof BackgroundTaskError
        ? error.code
        : error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'BACKGROUND_TASK_FAILED',
    message:
      error instanceof Error
        ? error.message
        : 'Background task operation failed',
    retryable: false,
  }
}

function requestContext(context: Parameters<ToolDefinition['execute']>[1]): {
  parentSessionId: typeof context.sessionId
  sessionTemp: NonNullable<typeof context.sessionTemp>
  signal: AbortSignal
  outputLimits: {
    maxToolOutputBytes: number
    maxToolOutputLines: number
  }
} {
  if (!context.sessionTemp) {
    throw new BackgroundTaskError(
      'SESSION_TEMP_UNAVAILABLE',
      'Session temp is unavailable for background task artifacts',
    )
  }
  return {
    parentSessionId: context.ownerSessionId ?? context.sessionId,
    sessionTemp: context.sessionTemp,
    signal: context.signal,
    outputLimits: context.toolOutputLimits ?? {
      maxToolOutputBytes: 256 * 1_024,
      maxToolOutputLines: 500,
    },
  }
}

/** Registers unified background wait, discovery, and cancellation tools. */
export function registerBackgroundTools(
  registry: ToolRegistrationPort,
  tasks: BackgroundTaskPort,
): void {
  registry.registerTool({
    id: 'background_wait',
    executionMode: 'parallel',
    description:
      'Wait for any or all background Subagent, Swarm, and Terminal targets to finish. Ordinary output does not wake this tool. Timeouts are normal snapshots; use artifact paths with read_file for complete output.',
    inputSchema: WaitSchema,
    effects: ['terminal.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 305_000,
    validateArgs(args) {
      const includesTerminal = args.targets.some(
        (target) => target.type === 'terminal',
      )
      return includesTerminal && (args.timeoutMs ?? 60_000) > 60_000
        ? 'background_wait timeoutMs cannot exceed 60000 when a Terminal target is included'
        : undefined
    },
    async execute(args: WaitArgs, context): Promise<ToolResult> {
      try {
        const includesTerminal = args.targets.some(
          (target) => target.type === 'terminal',
        )
        return {
          status: 'ok',
          content: await tasks.wait({
            ...requestContext(context),
            targets: args.targets as BackgroundTarget[],
            mode: args.mode ?? 'any',
            timeoutMs: args.timeoutMs ?? (includesTerminal ? 60_000 : 300_000),
          }),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  } satisfies ToolDefinition<typeof WaitSchema>)

  registry.registerTool({
    id: 'background_list',
    executionMode: 'parallel',
    description:
      'List newest background standalone Subagents, Swarm roots, and Terminals for the current Session. Swarm children are available through the manifest instead of being flattened into this list.',
    inputSchema: ListSchema,
    effects: ['terminal.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 15_000,
    modelOutputPolicy: 'paged',
    async execute(args: ListArgs, context): Promise<ToolResult> {
      try {
        return {
          status: 'ok',
          content: await tasks.list({
            ...requestContext(context),
            types: args.types as BackgroundTarget['type'][] | undefined,
            status: args.status ?? 'all',
            limit: args.limit ?? 20,
            cursor: args.cursor,
          }),
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  } satisfies ToolDefinition<typeof ListSchema>)

  registry.registerTool({
    id: 'background_cancel',
    executionMode: 'serial',
    description:
      'Cancel one background target owned by the current Session. Cancelling a Swarm root cascades to unfinished children; cancelling one child causes its root to re-aggregate. This operation is idempotent and approval-free.',
    inputSchema: CancelSchema,
    effects: [],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 65_000,
    async execute(args: CancelArgs, context): Promise<ToolResult> {
      try {
        return {
          status: 'ok',
          content: (await tasks.cancel({
            ...requestContext(context),
            target: args.target as BackgroundTarget,
            waitMs: args.waitMs ?? 0,
          })) as JsonValue,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  } satisfies ToolDefinition<typeof CancelSchema>)
}
