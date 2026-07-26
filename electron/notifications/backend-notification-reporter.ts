import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { IPC_VERSION } from '../../shared/channels'
import type { SessionId } from '../../shared/ids'
import type { BackendNotificationEnvelope } from '../../shared/notifications'
import { sendBackendNotification } from '../ipc/event-sink'

const MAX_NOTIFICATION_MESSAGE_LENGTH = 1_024

export interface BackendNotificationReporterOptions {
  getWebContents: () => WebContents | undefined
  log?: (message: string, error?: unknown) => void
  now?: () => string
  createId?: () => string
}

/** Converts backend diagnostics into bounded, renderer-safe notifications. */
export class BackendNotificationReporter {
  readonly #getWebContents: () => WebContents | undefined
  readonly #log: (message: string, error?: unknown) => void
  readonly #now: () => string
  readonly #createId: () => string

  constructor(options: BackendNotificationReporterOptions) {
    this.#getWebContents = options.getWebContents
    this.#log =
      options.log ?? ((message, error) => console.error(message, error))
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#createId = options.createId ?? (() => `notification:${randomUUID()}`)
  }

  /** Logs a diagnostic and forwards it when another public channel does not. */
  readonly reportDiagnostic = (message: string, error?: unknown): void => {
    this.#log(message, error)
    if (isDeliveredElsewhere(message)) return
    this.notify({
      severity: 'warning',
      code: diagnosticCode(message),
      message: diagnosticMessage(message, error),
    })
  }

  /** Logs diagnostics that already have a request-response delivery path. */
  readonly reportInternal = (message: string, error?: unknown): void => {
    this.#log(message, error)
  }

  /** Publishes an explicitly classified safe notification when a window exists. */
  notify(input: {
    severity: BackendNotificationEnvelope['severity']
    code: string
    message: string
    sessionId?: SessionId
  }): void {
    const webContents = this.#getWebContents()
    if (!webContents || webContents.isDestroyed()) return
    const envelope: BackendNotificationEnvelope = {
      version: IPC_VERSION,
      id: this.#createId(),
      severity: input.severity,
      code: normalizeNotificationCode(input.code),
      message: sanitizeDiagnosticMessage(input.message),
      occurredAt: this.#now(),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }
    try {
      sendBackendNotification(webContents, envelope)
    } catch (error) {
      this.#log('Failed to publish backend notification', error)
    }
  }
}

/** Removes sensitive or unbounded diagnostic content before renderer delivery. */
export function sanitizeDiagnosticMessage(message: string): string {
  const firstLine = message.split(/\r?\n/u, 1)[0] ?? ''
  const redacted = firstLine
    .replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]')
    .replace(
      /\b(authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*[^\s,;"']+/giu,
      '$1=[redacted]',
    )
    .replace(/https?:\/\/[^\s"'<>]+/giu, '<url>')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+/gu, '<path>')
    .replace(
      /\/(?:Users|home|tmp|var|etc|opt|private|mnt|workspace)(?:\/[^\s"'<>:]+)+/gu,
      '<path>',
    )
    .replace(/\s+/gu, ' ')
    .trim()
  const bounded = redacted || 'A backend operation reported an error.'
  if (bounded.length <= MAX_NOTIFICATION_MESSAGE_LENGTH) return bounded
  return `${bounded.slice(0, MAX_NOTIFICATION_MESSAGE_LENGTH - 1)}…`
}

function diagnosticMessage(message: string, error?: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  if (!detail || detail === message) return sanitizeDiagnosticMessage(message)
  return sanitizeDiagnosticMessage(`${message}: ${detail}`)
}

function isDeliveredElsewhere(message: string): boolean {
  return (
    /^IPC handler /u.test(message) ||
    /^Run .* ended unexpectedly$/u.test(message) ||
    message === 'Provider completion validation failed' ||
    /^(?:Failed to (?:start|close|dispose) trace capture|Trace capture failed)/u.test(
      message,
    ) ||
    /^Failed to trace /u.test(message) ||
    /^SQLite migration /u.test(message)
  )
}

function diagnosticCode(message: string): string {
  if (/^MCP /u.test(message)) return 'MCP_BACKGROUND_FAILURE'
  if (/Durable commit/u.test(message)) return 'DURABLE_PUBLICATION_FAILURE'
  if (
    /runtime context|runtime cleanup|partially loaded Session/u.test(message)
  ) {
    return 'SESSION_RUNTIME_DEGRADED'
  }
  if (/file change|FileChange|File was reverted/u.test(message)) {
    return 'FILE_CHANGE_AUDIT_WARNING'
  }
  if (/Plugin /u.test(message)) return 'PLUGIN_HOOK_FAILURE'
  if (/trace directory|trace /u.test(message))
    return 'TRACE_MAINTENANCE_FAILURE'
  return 'BACKEND_DIAGNOSTIC'
}

function normalizeNotificationCode(code: string): string {
  const normalized = code
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 128)
  return /^[A-Z]/u.test(normalized) ? normalized : 'BACKEND_DIAGNOSTIC'
}
