import { Type, type Static } from '@sinclair/typebox'

export const HttpProxyConfigSchema = Type.Union([
  Type.Object({ mode: Type.Literal('off') }, { additionalProperties: false }),
  Type.Object(
    { mode: Type.Literal('system') },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      mode: Type.Literal('manual'),
      url: Type.String({ minLength: 1, maxLength: 2048 }),
    },
    { additionalProperties: false },
  ),
])
export type HttpProxyConfig = Static<typeof HttpProxyConfigSchema>

export const NetworkConfigSchema = Type.Object(
  {
    httpProxy: HttpProxyConfigSchema,
  },
  { additionalProperties: false },
)
export type NetworkConfig = Static<typeof NetworkConfigSchema>
