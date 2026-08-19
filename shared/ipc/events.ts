import { Type, type Static } from '@sinclair/typebox'
import { AgentEventSchema, TerminalEventSchema } from '../agent-events'
import {
  AgentExecutionEventEnvelopeSchema,
  type AgentExecutionEventEnvelope,
} from '../agent-execution'
import { IPC_VERSION } from '../channels'
import { DomainStateEventSchema } from '../domain-state-api'

export const AgentEventEnvelopeSchema = Type.Object(
  {
    version: Type.Literal(IPC_VERSION),
    event: AgentEventSchema,
  },
  { additionalProperties: false },
)
export type AgentEventEnvelope = Static<typeof AgentEventEnvelopeSchema>

export { AgentExecutionEventEnvelopeSchema }
export type { AgentExecutionEventEnvelope }

export const TerminalEventEnvelopeSchema = Type.Object(
  {
    version: Type.Literal(IPC_VERSION),
    event: TerminalEventSchema,
  },
  { additionalProperties: false },
)
export type TerminalEventEnvelope = Static<typeof TerminalEventEnvelopeSchema>

export const DomainStateDeliverySchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('commit'),
      event: DomainStateEventSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('buffer_overflow') },
    { additionalProperties: false },
  ),
])
export type DomainStateDelivery = Static<typeof DomainStateDeliverySchema>
