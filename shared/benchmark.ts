import { Type, type Static } from '@sinclair/typebox'

const BenchmarkIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$',
})
const RelativePathSchema = Type.String({ minLength: 1, maxLength: 1_024 })

export const BenchmarkCommandSchema = Type.Object(
  {
    executable: Type.String({ minLength: 1, maxLength: 256 }),
    args: Type.Array(Type.String({ maxLength: 8_192 }), { maxItems: 128 }),
    cwd: Type.Optional(RelativePathSchema),
    timeoutMs: Type.Integer({ minimum: 100, maximum: 300_000 }),
    maxOutputBytes: Type.Integer({ minimum: 1_024, maximum: 4_194_304 }),
  },
  { additionalProperties: false },
)
export type BenchmarkCommand = Static<typeof BenchmarkCommandSchema>

export const BenchmarkAgentCaseSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    caseId: BenchmarkIdSchema,
    suiteId: BenchmarkIdSchema,
    suiteRevision: BenchmarkIdSchema,
    task: Type.String({ minLength: 1, maxLength: 65_536 }),
    publicChecks: Type.Array(
      Type.Object(
        {
          id: BenchmarkIdSchema,
          title: Type.String({ minLength: 1, maxLength: 256 }),
          acceptanceGroupId: BenchmarkIdSchema,
          command: BenchmarkCommandSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
    modificationScope: Type.Object(
      {
        allowedPaths: Type.Array(RelativePathSchema, {
          minItems: 1,
          maxItems: 64,
        }),
        deniedPaths: Type.Array(RelativePathSchema, { maxItems: 64 }),
        maxChangedFiles: Type.Integer({ minimum: 1, maximum: 10_000 }),
        maxPatchBytes: Type.Integer({ minimum: 1_024, maximum: 16_777_216 }),
      },
      { additionalProperties: false },
    ),
    resources: Type.Object(
      {
        wallTimeMs: Type.Integer({ minimum: 1_000, maximum: 86_400_000 }),
        cpus: Type.Number({ minimum: 0.1, maximum: 16 }),
        memoryBytes: Type.Integer({
          minimum: 134_217_728,
          maximum: 68_719_476_736,
        }),
        pids: Type.Integer({ minimum: 16, maximum: 4_096 }),
        diskBytes: Type.Integer({
          minimum: 16_777_216,
          maximum: 68_719_476_736,
        }),
        maxAgentSteps: Type.Integer({ minimum: 1, maximum: 512 }),
        maxContextTokens: Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type BenchmarkAgentCase = Static<typeof BenchmarkAgentCaseSchema>
