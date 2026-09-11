import { Type, type Static } from '@sinclair/typebox'
import { delay } from '../../shared/async/delay'
import type { PublicConfig } from '../../shared/config'
import type { ToolRegistrationPort, ToolResult } from './types'
import type { CommandSessionManager } from '../process/command-sessions'
import type { CommandShellService } from '../process/command-shell'
import { registerExecCommandTool } from './exec-command-tool'
import { projectDelayResult } from './tool-result-formatters'
import { clampToolWaitTime } from '../tooling/input-normalizer'
const MAX_DELAY_MS = 60_000
const DelaySchema = Type.Object(
  {
    durationMs: Type.Integer({
      minimum: 1,
      maximum: MAX_DELAY_MS,
      description:
        'Milliseconds to wait. Prefer exec_command sessionId or background_wait for process and Agent completion.',
    }),
  },
  { additionalProperties: false },
)
type DelayArgs = Static<typeof DelaySchema>
/** Registers Run-scoped command sessions and the independent bounded delay tool. */
export function registerProcessTools(
  registry: ToolRegistrationPort,
  getConfig: () => PublicConfig,
  sessions: CommandSessionManager,
  shells?: Pick<CommandShellService, 'resolve' | 'invocation'>,
): void {
  registerExecCommandTool(registry, getConfig, sessions, shells)
  registry.registerTool({
    id: 'delay',
    executionMode: 'parallel',
    description:
      'Wait for a short bounded interval. Prefer background_wait when waiting for Terminal or Agent task completion.',
    inputSchema: DelaySchema,
    normalizeArgs: (args) =>
      clampToolWaitTime(args, 'durationMs', MAX_DELAY_MS),
    effects: [],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: MAX_DELAY_MS + 5_000,
    projectResultForModel: projectDelayResult,
    async execute(args: DelayArgs, context): Promise<ToolResult> {
      const startedAt = performance.now()
      await delay(args.durationMs, context.signal)
      return {
        status: 'ok',
        content: {
          waitedMs: Math.round(performance.now() - startedAt),
        },
      }
    },
  })
}
