import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { IPC_VERSION } from '../../shared/channels'
import type { SessionId } from '../../shared/ids'
import type { BackendNotificationEnvelope } from '../../shared/notifications'
import { sendBackendNotification } from '../ipc/event-sink'
import type { DiagnosticSink } from '../diagnostics'

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

  /** Logs a diagnostic and publishes it unless the producer marks it internal. */
  readonly reportDiagnostic: DiagnosticSink = (message, error, delivery) => {
    this.#log(message, error)
    if (delivery?.audience === 'internal') return
    this.notify({
      severity: delivery?.severity ?? 'warning',
      code: delivery?.code ?? 'BACKEND_DIAGNOSTIC',
      message: delivery?.message ?? diagnosticMessage(message, error),
      ...(delivery?.sessionId ? { sessionId: delivery.sessionId } : {}),
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
      /(["'])(authorization|api[-_ ]?key|token|secret|password)\1\s*:\s*(["'])[^"']*\3/giu,
      '$1$2$1: $3[redacted]$3',
    )
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

function normalizeNotificationCode(code: string): string {
  const normalized = code
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 128)
  return /^[A-Z]/u.test(normalized) ? normalized : 'BACKEND_DIAGNOSTIC'
}
