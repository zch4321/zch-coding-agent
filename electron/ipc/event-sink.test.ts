import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { APP_NOTIFICATION_CHANNEL } from '../../shared/channels'
import type { BackendNotificationEnvelope } from '../../shared/notifications'
import { sendBackendNotification, sendDomainStateEvent } from './event-sink'

const validNotification: BackendNotificationEnvelope = {
  version: 1,
  id: 'notification:event-sink',
  severity: 'error',
  code: 'PERSISTENCE_FAILURE',
  message: 'The request failed.',
  occurredAt: '2026-07-26T00:00:00.000Z',
}

function webContents(destroyed = false): WebContents {
  return {
    isDestroyed: () => destroyed,
    send: vi.fn(),
  } as unknown as WebContents
}

describe('backend notification event sink', () => {
  it('validates and sends safe envelopes', () => {
    const target = webContents()
    sendBackendNotification(target, validNotification)
    expect(target.send).toHaveBeenCalledWith(
      APP_NOTIFICATION_CHANNEL,
      validNotification,
    )
  })

  it('rejects unknown diagnostic fields and skips destroyed windows', () => {
    expect(() =>
      sendBackendNotification(webContents(), {
        ...validNotification,
        stack: 'must not cross IPC',
      } as BackendNotificationEnvelope),
    ).toThrow()
    const destroyed = webContents(true)
    sendBackendNotification(destroyed, validNotification)
    expect(destroyed.send).not.toHaveBeenCalled()
  })

  it('rejects non-commit domain deliveries with a stable error', () => {
    expect(() =>
      sendDomainStateEvent(webContents(), { kind: 'buffer_overflow' }),
    ).toThrow('Domain-state renderer delivery only accepts commits')
  })
})
