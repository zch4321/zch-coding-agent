import { Type, type Static } from '@sinclair/typebox'

export const McpServerIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
})

const McpEnvironmentSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 256 }),
  Type.String({ maxLength: 16_384 }),
  { maxProperties: 128 },
)

export const McpLaunchTrustSchema = Type.Object(
  {
    fingerprint: Type.String({ minLength: 64, maxLength: 64 }),
    trustedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
)
export type McpLaunchTrust = Static<typeof McpLaunchTrustSchema>

export const McpServerConfigSchema = Type.Object(
  {
    id: McpServerIdSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ minLength: 1, maxLength: 2_048 }),
    enabled: Type.Boolean(),
    scope: Type.Union([Type.Literal('global'), Type.Literal('workspace')]),
    transport: Type.Literal('stdio'),
    command: Type.String({ minLength: 1, maxLength: 4_096 }),
    args: Type.Array(Type.String({ maxLength: 16_384 }), { maxItems: 256 }),
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    env: Type.Optional(McpEnvironmentSchema),
    envFromHost: Type.Optional(McpEnvironmentSchema),
    startupTimeoutMs: Type.Integer({ minimum: 100, maximum: 300_000 }),
    toolTimeoutMs: Type.Integer({ minimum: 100, maximum: 86_400_000 }),
    launchTrust: Type.Optional(McpLaunchTrustSchema),
  },
  { additionalProperties: false },
)
export type McpServerConfig = Static<typeof McpServerConfigSchema>

export const McpServerStateSchema = Type.Union([
  Type.Literal('untrusted'),
  Type.Literal('disabled'),
  Type.Literal('stopped'),
  Type.Literal('starting'),
  Type.Literal('ready'),
  Type.Literal('error'),
  Type.Literal('restarting'),
  Type.Literal('draining'),
])
export type McpServerState = Static<typeof McpServerStateSchema>

export const McpServerStatusSchema = Type.Object(
  {
    id: McpServerIdSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ maxLength: 2_048 }),
    enabled: Type.Boolean(),
    scope: Type.Union([Type.Literal('global'), Type.Literal('workspace')]),
    state: McpServerStateSchema,
    trusted: Type.Boolean(),
    launchFingerprint: Type.String({ minLength: 64, maxLength: 64 }),
    launchPreview: Type.String({ maxLength: 65_536 }),
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
    toolCount: Type.Integer({ minimum: 0, maximum: 1_000 }),
    revision: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
    stderrTail: Type.String({ maxLength: 8_192 }),
    lastError: Type.Optional(Type.String({ maxLength: 4_096 })),
    workspace: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
  },
  { additionalProperties: false },
)
export type McpServerStatus = Static<typeof McpServerStatusSchema>

export const McpSettingsSnapshotSchema = Type.Object(
  {
    servers: Type.Array(McpServerStatusSchema, { maxItems: 1_024 }),
  },
  { additionalProperties: false },
)
export type McpSettingsSnapshot = Static<typeof McpSettingsSnapshotSchema>
