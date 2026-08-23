import type { DiagnosticId, SessionId } from '../shared/ids'

export interface DiagnosticDelivery {
  audience: 'internal' | 'notification'
  severity?: 'warning' | 'error'
  code?: string
  message?: string
  sessionId?: SessionId
  diagnosticId?: DiagnosticId
}

/** Receives an internal diagnostic with optional explicit renderer delivery metadata. */
export type DiagnosticSink = (
  message: string,
  error?: unknown,
  delivery?: DiagnosticDelivery,
) => DiagnosticId | void
