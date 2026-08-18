import { Type, type Static } from '@sinclair/typebox'
import { CommandShellSelectionSchema } from '../command-shell'

export const TokenEstimationSchema = Type.Object(
  {
    mode: Type.Union([
      Type.Literal('conservative'),
      Type.Literal('custom-bytes'),
    ]),
    bytesPerToken: Type.Number({ minimum: 0.25, maximum: 32 }),
  },
  { additionalProperties: false },
)
export type TokenEstimationConfig = Static<typeof TokenEstimationSchema>

export const SubagentsConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    workerTimeoutMs: Type.Integer({
      minimum: 60_000,
      maximum: 86_400_000,
    }),
    maxAgentsPerSwarm: Type.Integer({ minimum: 1, maximum: 32 }),
  },
  { additionalProperties: false },
)
export type SubagentsConfig = Static<typeof SubagentsConfigSchema>

export const ExecutionEnvironmentConfigSchema = Type.Object(
  {
    commandShell: CommandShellSelectionSchema,
  },
  { additionalProperties: false },
)
export type ExecutionEnvironmentConfig = Static<
  typeof ExecutionEnvironmentConfigSchema
>

export const LimitsConfigSchema = Type.Object(
  {
    maxConcurrentRuns: Type.Integer({ minimum: 1, maximum: 32 }),
    // Zero disables the React-loop step limit. Positive values remain
    // available for bounded autonomous deployment profiles.
    maxStepsPerRun: Type.Integer({ minimum: 0, maximum: 1_000 }),
    maxToolOutputBytes: Type.Integer({
      minimum: 1_024,
      maximum: 100_000_000,
    }),
    maxContextTokens: Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
    maxAttachmentContextTokens: Type.Integer({
      minimum: 1_024,
      maximum: 1_000_000,
    }),
    autoCompactTriggerPercent: Type.Integer({ minimum: 50, maximum: 95 }),
    maxToolResultTokens: Type.Integer({
      minimum: 256,
      maximum: 1_000_000,
    }),
    tokenEstimation: TokenEstimationSchema,
    commandTimeoutMs: Type.Integer({ minimum: 100, maximum: 86_400_000 }),
    readFileSourceBytes: Type.Integer({
      minimum: 1_024,
      maximum: 100_000_000,
    }),
    readFileOutputBytes: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000,
    }),
    editableFileBytes: Type.Integer({
      minimum: 1_024,
      maximum: 100_000_000,
    }),
    writeFileBytes: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000,
    }),
    patchBytes: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000,
    }),
    diffChars: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000,
    }),
    fileChangeHistoryBytes: Type.Integer({
      minimum: 1_000_000,
      maximum: 10_000_000_000,
    }),
    approvalTimeoutMs: Type.Integer({
      minimum: 1_000,
      maximum: 86_400_000,
    }),
    autoApprovalTimeoutMs: Type.Integer({
      minimum: 1_000,
      maximum: 300_000,
    }),
    modelCatalogTimeoutMs: Type.Integer({
      minimum: 1_000,
      maximum: 300_000,
    }),
    terminalScrollbackBytes: Type.Integer({
      minimum: 1_024,
      maximum: 100_000_000,
    }),
    fetchResponseBytes: Type.Integer({
      minimum: 1_024,
      maximum: 10_000_000,
    }),
    fetchTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 60_000 }),
    fetchMaxRedirects: Type.Integer({ minimum: 0, maximum: 10 }),
  },
  { additionalProperties: false },
)
export type LimitsConfig = Static<typeof LimitsConfigSchema>
