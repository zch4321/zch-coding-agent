import type { SessionId } from '../shared/ids'

export interface DiagnosticDelivery {
  audience: 'internal' | 'notification'
  severity?: 'warning' | 'error'
  code?: string
  message?: string
  sessionId?: SessionId
}

/** Receives an internal diagnostic with optional explicit renderer delivery metadata. */
export type DiagnosticSink = (
  message: string,
  error?: unknown,
  delivery?: DiagnosticDelivery,
) => void
