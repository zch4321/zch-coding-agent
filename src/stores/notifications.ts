import { defineStore } from 'pinia'
import type { SessionId } from '../../shared/ids'

export type UiNotificationSeverity = 'warning' | 'error'

export interface UiNotificationInput {
  id?: string
  severity: UiNotificationSeverity
  code: string
  message: string
  sessionId?: SessionId
}

export interface UiNotification extends UiNotificationInput {
  id: string
  dedupeKey: string
}

const MAX_PENDING_NOTIFICATIONS = 128
let notificationSequence = 0

function normalizedCode(code: string): string {
  return code.trim().slice(0, 128) || 'OPERATION_FAILED'
}

function normalizedMessage(message: string): string {
  return message.trim().slice(0, 1_024) || 'The operation failed.'
}

function notificationKey(input: UiNotificationInput): string {
  return [
    normalizedCode(input.code),
    input.sessionId ?? '',
    normalizedMessage(input.message),
  ].join('\u0000')
}

/** Owns transient renderer notifications without adding them to durable state. */
export const useNotificationStore = defineStore('notifications', {
  state: () => ({
    pending: [] as UiNotification[],
    activeKeys: [] as string[],
  }),
  actions: {
    /** Queues a bounded notification unless an identical item is visible or queued. */
    enqueue(input: UiNotificationInput): boolean {
      const dedupeKey = notificationKey(input)
      if (
        this.activeKeys.includes(dedupeKey) ||
        this.pending.some((item) => item.dedupeKey === dedupeKey)
      ) {
        return false
      }
      const notification: UiNotification = {
        id: input.id ?? `ui-notification-${++notificationSequence}`,
        severity: input.severity,
        code: normalizedCode(input.code),
        message: normalizedMessage(input.message),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        dedupeKey,
      }
      if (this.pending.length >= MAX_PENDING_NOTIFICATIONS) {
        const warningIndex = this.pending.findIndex(
          (item) => item.severity === 'warning',
        )
        this.pending.splice(warningIndex >= 0 ? warningIndex : 0, 1)
      }
      this.pending.push(notification)
      return true
    },
    /** Queues a transient warning. */
    warning(input: Omit<UiNotificationInput, 'severity'>): boolean {
      return this.enqueue({ ...input, severity: 'warning' })
    },
    /** Queues a persistent error. */
    error(input: Omit<UiNotificationInput, 'severity'>): boolean {
      return this.enqueue({ ...input, severity: 'error' })
    },
    /** Moves the oldest queued notification into the active set. */
    take(): UiNotification | undefined {
      const notification = this.pending.shift()
      if (notification) this.activeKeys.push(notification.dedupeKey)
      return notification
    },
    /** Releases one closed notification so an identical future failure can surface. */
    release(dedupeKey: string): void {
      this.activeKeys = this.activeKeys.filter((key) => key !== dedupeKey)
    },
    /** Clears renderer-only notification state. */
    clear(): void {
      this.pending = []
      this.activeKeys = []
    },
  },
})
