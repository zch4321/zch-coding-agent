import type { WebContents } from 'electron'
import {
  APP_NOTIFICATION_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AgentEventEnvelopeSchema,
  DOMAIN_STATE_EVENT_CHANNEL,
  DomainStateDeliverySchema,
  TERMINAL_EVENT_CHANNEL,
  TerminalEventEnvelopeSchema,
  type AgentEventEnvelope,
  type BackendNotificationEnvelope,
  type DomainStateDelivery,
  type TerminalEventEnvelope,
} from '../../shared/ipc-contract'
import { BackendNotificationEnvelopeSchema } from '../../shared/notifications'
import { compileSchema, formatSchemaErrors } from '../schema-validator'

const validateAgentEvent = compileSchema(AgentEventEnvelopeSchema)
const validateTerminalEvent = compileSchema(TerminalEventEnvelopeSchema)
const validateDomainStateDelivery = compileSchema(DomainStateDeliverySchema)
const validateBackendNotification = compileSchema(
  BackendNotificationEnvelopeSchema,
)

/** Sends one validated, user-safe backend notification to the renderer. */
export function sendBackendNotification(
  webContents: WebContents,
  envelope: BackendNotificationEnvelope,
): void {
  if (!validateBackendNotification(envelope)) {
    throw new Error(formatSchemaErrors(validateBackendNotification.errors))
  }
  if (!webContents.isDestroyed()) {
    webContents.send(APP_NOTIFICATION_CHANNEL, envelope)
  }
}

/** Sends agent event. */
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

/** Sends terminal event. */
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

/** Sends domain state event. */
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
