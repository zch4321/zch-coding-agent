import { Type, type Static } from '@sinclair/typebox'

const Sha256Schema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: '^[a-f0-9]{64}$',
})

export const RuntimeIdentitySchema = Type.Object(
  {
    schemaVersion: Type.Literal(5),
    sourceCommit: Type.String({ minLength: 1, maxLength: 128 }),
    sourceTree: Type.Union([
      Type.Literal('clean'),
      Type.Literal('dirty'),
      Type.Literal('unknown'),
    ]),
    runtimeImageDigest: Type.String({ minLength: 1, maxLength: 256 }),
    taskDigest: Sha256Schema,
    configHash: Sha256Schema,
    toolsHash: Sha256Schema,
    promptResources: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 256 }),
          version: Type.String({ minLength: 1, maxLength: 128 }),
          sha256: Sha256Schema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 256 },
    ),
    provider: Type.Object(
      {
        id: Type.String({ minLength: 1, maxLength: 128 }),
        providerType: Type.String({ minLength: 1, maxLength: 128 }),
        model: Type.String({ minLength: 1, maxLength: 256 }),
        reasoning: Type.String({ minLength: 1, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
    budgets: Type.Object(
      {
        maxStepsPerRun: Type.Integer({ minimum: 0 }),
        maxContextTokens: Type.Integer({ minimum: 1 }),
        maxToolResultTokens: Type.Integer({ minimum: 1 }),
        maxToolOutputBytes: Type.Integer({ minimum: 1 }),
        commandTimeoutMs: Type.Integer({ minimum: 1 }),
        subagentWorkerTimeoutMs: Type.Integer({
          minimum: 60_000,
          maximum: 86_400_000,
        }),
      },
      { additionalProperties: false },
    ),
    capabilities: Type.Object(
      {
        platform: Type.String({ minLength: 1, maxLength: 64 }),
        arch: Type.String({ minLength: 1, maxLength: 64 }),
        nodeVersion: Type.String({ minLength: 1, maxLength: 64 }),
        permissionMode: Type.Literal('yolo'),
        skillsEnabled: Type.Boolean(),
        subagentsEnabled: Type.Boolean(),
        swarmsEnabled: Type.Boolean(),
        mcpServerIds: Type.Array(
          Type.String({ minLength: 1, maxLength: 128 }),
          {
            maxItems: 32,
          },
        ),
        mcpServers: Type.Array(
          Type.Object(
            {
              id: Type.String({ minLength: 1, maxLength: 128 }),
              state: Type.String({ minLength: 1, maxLength: 64 }),
              trusted: Type.Boolean(),
              toolCount: Type.Integer({ minimum: 0, maximum: 1_000 }),
              revision: Type.Optional(Sha256Schema),
            },
            { additionalProperties: false },
          ),
          { maxItems: 32 },
        ),
        toolNames: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
          maxItems: 512,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type RuntimeIdentity = Static<typeof RuntimeIdentitySchema>
