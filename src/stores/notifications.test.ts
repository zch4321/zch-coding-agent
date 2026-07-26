import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '../../shared/ids'
import { useNotificationStore } from './notifications'

describe('renderer notification store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('deduplicates the same code, Session, and message while queued or active', () => {
    const notifications = useNotificationStore()
    const input = {
      code: 'RUN_FAILED',
      message: 'Try again.',
      sessionId: 'session:notification' as SessionId,
    }

    expect(notifications.error(input)).toBe(true)
    expect(notifications.error(input)).toBe(false)
    const active = notifications.take()
    expect(active).toBeDefined()
    expect(notifications.error(input)).toBe(false)

    notifications.release(active!.dedupeKey)
    expect(notifications.error(input)).toBe(true)
  })

  it('bounds pending items and preserves errors ahead of disposable warnings', () => {
    const notifications = useNotificationStore()
    notifications.error({ code: 'PERSISTENT', message: 'Keep me.' })
    for (let index = 0; index < 128; index += 1) {
      notifications.warning({
        code: `WARNING_${index}`,
        message: `Warning ${index}`,
      })
    }

    expect(notifications.pending).toHaveLength(128)
    expect(
      notifications.pending.some((item) => item.code === 'PERSISTENT'),
    ).toBe(true)
    expect(
      notifications.pending.some((item) => item.code === 'WARNING_0'),
    ).toBe(false)
  })

  it('bounds renderer text and normalizes empty metadata', () => {
    const notifications = useNotificationStore()
    notifications.warning({ code: ' ', message: 'x'.repeat(2_000) })
    const item = notifications.pending[0]!

    expect(item.code).toBe('OPERATION_FAILED')
    expect(item.message).toHaveLength(1_024)
  })
})
