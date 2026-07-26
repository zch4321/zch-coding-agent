import { describe, expect, it, vi } from 'vitest'
import type { BackendNotificationEnvelope } from '../shared/notifications'
import { BackendNotificationBuffer } from './preload-notification-buffer'

function notification(index: number): BackendNotificationEnvelope {
  return {
    version: 1,
    id: `notification:${index}`,
    severity: 'warning',
    code: 'BACKEND_DIAGNOSTIC',
    message: `message ${index}`,
    occurredAt: '2026-07-26T00:00:00.000Z',
  }
}

describe('BackendNotificationBuffer', () => {
  it('replays a bounded pre-mount buffer with one overflow warning', () => {
    const buffer = new BackendNotificationBuffer({
      capacity: 2,
      now: () => '2026-07-26T01:00:00.000Z',
    })
    const listener = vi.fn()
    buffer.push(notification(1))
    buffer.push(notification(2))
    buffer.push(notification(3))

    buffer.subscribe(listener)

    expect(listener.mock.calls.map(([event]) => event.code)).toEqual([
      'NOTIFICATION_BUFFER_OVERFLOW',
      'BACKEND_DIAGNOSTIC',
      'BACKEND_DIAGNOSTIC',
    ])
    expect(listener.mock.calls.map(([event]) => event.id)).toEqual([
      'notification:preload-buffer-overflow',
      'notification:2',
      'notification:3',
    ])
  })

  it('isolates listeners and stops delivery after unsubscribe', () => {
    const buffer = new BackendNotificationBuffer({ capacity: 2 })
    const failed = vi.fn(() => {
      throw new Error('listener failure')
    })
    const delivered = vi.fn()
    const unsubscribeFailed = buffer.subscribe(failed)
    const unsubscribeDelivered = buffer.subscribe(delivered)

    buffer.push(notification(1))
    expect(failed).toHaveBeenCalledOnce()
    expect(delivered).toHaveBeenCalledOnce()

    unsubscribeFailed()
    unsubscribeDelivered()
    buffer.push(notification(2))
    expect(delivered).toHaveBeenCalledOnce()
  })
})
