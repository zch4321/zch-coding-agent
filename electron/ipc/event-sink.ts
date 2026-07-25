import type { WebContents } from 'electron'
import {
  AGENT_EVENT_CHANNEL,
  AgentEventEnvelopeSchema,
  DOMAIN_STATE_EVENT_CHANNEL,
  DomainStateDeliverySchema,
  TERMINAL_EVENT_CHANNEL,
  TerminalEventEnvelopeSchema,
  type AgentEventEnvelope,
  type DomainStateDelivery,
  type TerminalEventEnvelope,
} from '../../shared/ipc-contract'
import { compileSchema, formatSchemaErrors } from '../schema-validator'

const validateAgentEvent = compileSchema(AgentEventEnvelopeSchema)
const validateTerminalEvent = compileSchema(TerminalEventEnvelopeSchema)
const validateDomainStateDelivery = compileSchema(DomainStateDeliverySchema)

export function sendAgentEvent(
  webContents: WebContents,
  envelope: AgentEventEnvelope,
): void {
  if (!validateAgentEvent(envelope)) {
    throw new Error(formatSchemaErrors(validateAgentEvent.errors))
  }

  if (!webContents.isDestroyed()) {
    webContents.send(AGENT_EVENT_CHANNEL, envelope)
  }
}

export function sendTerminalEvent(
  webContents: WebContents,
  envelope: TerminalEventEnvelope,
): void {
  if (!validateTerminalEvent(envelope)) {
    throw new Error(formatSchemaErrors(validateTerminalEvent.errors))
  }

  if (!webContents.isDestroyed()) {
    webContents.send(TERMINAL_EVENT_CHANNEL, envelope)
  }
}

export function sendDomainStateEvent(
  webContents: WebContents,
  delivery: DomainStateDelivery,
): void {
  if (delivery.kind !== 'commit' || !validateDomainStateDelivery(delivery)) {
    throw new Error(formatSchemaErrors(validateDomainStateDelivery.errors))
  }
  if (!webContents.isDestroyed()) {
    webContents.send(DOMAIN_STATE_EVENT_CHANNEL, delivery.event)
  }
}
