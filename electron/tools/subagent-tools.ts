import { Type, type Static } from '@sinclair/typebox'
import type { SubagentExecutionPort } from '../subagent/contracts'
import type { ToolDefinition, ToolRegistrationPort, ToolResult } from './types'
import type { JsonValue } from '../../shared/json'
import { projectSubagentResult } from './tool-result-formatters'

const MAX_RAW_NAME_LENGTH = 256
const MAX_RAW_TASK_LENGTH = 65_536
const MAX_NAME_LENGTH = 64
const MAX_TASK_LENGTH = 32_768
const DANGEROUS_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

const SubagentRunArgsSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: MAX_RAW_NAME_LENGTH,
      description:
        'Short unique result name. Unicode is allowed; the trimmed value must contain at most 64 characters.',
    }),
    task: Type.String({
      minLength: 1,
      maxLength: MAX_RAW_TASK_LENGTH,
      description:
        'Self-contained investigation task. The trimmed text is submitted directly as the child Agent user message.',
    }),
  },
  { additionalProperties: false },
)
type SubagentRunArgs = Static<typeof SubagentRunArgsSchema>

function validateSubagentArgs(args: SubagentRunArgs): string | undefined {
  const name = args.name.trim()
  const task = args.task.trim()
  if (name.length < 1 || [...name].length > MAX_NAME_LENGTH) {
    return `subagent_run name must contain 1-${MAX_NAME_LENGTH} characters after trimming`
  }
  if (/[\p{Cc}\p{Cf}]/u.test(name)) {
    return 'subagent_run name must not contain control or formatting characters'
  }
  if (DANGEROUS_NAMES.has(name)) {
    return 'subagent_run name is reserved'
  }
  if (task.length < 1 || [...task].length > MAX_TASK_LENGTH) {
    return `subagent_run task must contain 1-${MAX_TASK_LENGTH} characters after trimming`
  }
  return undefined
}

/** Registers the single read-only Subagent delegation Tool. */
export function registerSubagentTools(
  registry: ToolRegistrationPort,
  execution: SubagentExecutionPort,
): void {
  registry.registerTool({
    id: 'subagent_run',
    description:
      'Run one read-only Subagent investigation. Provide a self-contained task because the child receives no parent conversation history. Ask the child to inspect with read-only tools and return its findings directly in its final assistant response; do not ask it to write the answer to a file.',
    inputSchema: SubagentRunArgsSchema,
    executionMode: 'parallel',
    effects: [],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 86_405_000,
    maxOutputBytes: 2_000_000,
    validateArgs: validateSubagentArgs,
    projectResultForModel: (result, args) =>
      projectSubagentResult(result, args.name.trim()),
    async execute(args, context): Promise<ToolResult> {
      const result = await execution.runOne(
        { name: args.name.trim(), task: args.task.trim() },
        {
          sessionId: context.sessionId,
          runId: context.runId,
          callId: context.approvedCall.callId,
          workspace: context.workspace.canonicalPath,
          signal: context.signal,
        },
      )
      return {
        status: 'ok',
        content: JSON.parse(JSON.stringify(result)) as JsonValue,
      }
    },
  } satisfies ToolDefinition<typeof SubagentRunArgsSchema>)
}
