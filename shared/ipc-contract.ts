/**
 * Backwards-compatible IPC contract facade.
 *
 * New shared code should import a domain contract or the registry directly.
 */
export {
  AGENT_EVENT_CHANNEL,
  AGENT_EXECUTION_EVENT_CHANNEL,
  APP_NOTIFICATION_CHANNEL,
  DOMAIN_STATE_EVENT_CHANNEL,
  IPC_VERSION,
  TERMINAL_EVENT_CHANNEL,
} from './channels'
export { IpcErrorSchema, type IpcError } from './ipc/common'
export {
  AgentEventEnvelopeSchema,
  AgentExecutionEventEnvelopeSchema,
  DomainStateDeliverySchema,
  TerminalEventEnvelopeSchema,
  type AgentEventEnvelope,
  type AgentExecutionEventEnvelope,
  type DomainStateDelivery,
  type TerminalEventEnvelope,
} from './ipc/events'
export {
  IPC_CONTRACTS,
  type IpcChannel,
  type IpcPayload,
  type IpcResult,
} from './ipc/registry'
export {
  BackendNotificationEnvelopeSchema,
  type BackendNotificationEnvelope,
} from './notifications'
