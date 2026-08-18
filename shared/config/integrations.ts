import { Type, type Static } from '@sinclair/typebox'
import { McpServerConfigSchema } from '../mcp'

export const SkillsConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    maxSummaryChars: Type.Integer({ minimum: 128, maximum: 100_000 }),
  },
  { additionalProperties: false },
)
export type SkillsConfig = Static<typeof SkillsConfigSchema>

export const WebSearchConfigSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal('brave')]),
    credentialConfigured: Type.Boolean(),
    credentialSource: Type.Union([
      Type.Literal('safe-storage'),
      Type.Literal('environment'),
      Type.Literal('none'),
    ]),
    count: Type.Integer({ minimum: 1, maximum: 20 }),
  },
  { additionalProperties: false },
)
export type WebSearchConfig = Static<typeof WebSearchConfigSchema>

export const McpServersConfigSchema = Type.Array(McpServerConfigSchema, {
  maxItems: 32,
})
export type McpServersConfig = Static<typeof McpServersConfigSchema>
