import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { APP_NOTIFICATION_CHANNEL } from '../../shared/channels'
import {
  BackendNotificationReporter,
  sanitizeDiagnosticMessage,
} from './backend-notification-reporter'

function webContents() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents
}

describe('BackendNotificationReporter', () => {
  it('logs raw diagnostics but sends only bounded redacted messages', () => {
    const target = webContents()
    const log = vi.fn()
    const reporter = new BackendNotificationReporter({
      getWebContents: () => target,
      log,
      now: () => '2026-07-26T00:00:00.000Z',
      createId: () => 'notification:diagnostic',
    })
    const error = new Error(
      'Bearer top-secret at C:\\Users\\alice\\workspace\\secret.txt\nstack line',
    )

    reporter.reportDiagnostic('MCP server transport error', error)

    expect(log).toHaveBeenCalledWith('MCP server transport error', error)
    expect(target.send).toHaveBeenCalledWith(
      APP_NOTIFICATION_CHANNEL,
      expect.objectContaining({
        id: 'notification:diagnostic',
        severity: 'warning',
        code: 'MCP_BACKGROUND_FAILURE',
        message: expect.not.stringContaining('top-secret'),
      }),
    )
    const payload = vi.mocked(target.send).mock.calls[0]?.[1]
    expect(JSON.stringify(payload)).not.toContain('stack line')
    expect(JSON.stringify(payload)).not.toContain('alice')
  })

  it('does not duplicate diagnostics already delivered by request or run events', () => {
    const target = webContents()
    const reporter = new BackendNotificationReporter({
      getWebContents: () => target,
      log: vi.fn(),
    })
    reporter.reportDiagnostic('IPC handler session:get failed', new Error())
    reporter.reportDiagnostic('Run run:1 ended unexpectedly', new Error())
    reporter.reportDiagnostic('Trace capture failed for session:1', new Error())
    expect(target.send).not.toHaveBeenCalled()
  })

  it('publishes explicit errors and tolerates a missing window', () => {
    const target = webContents()
    const reporter = new BackendNotificationReporter({
      getWebContents: () => target,
      createId: () => 'notification:explicit',
      now: () => '2026-07-26T00:00:00.000Z',
    })
    reporter.notify({
      severity: 'error',
      code: 'persistence-failure',
      message: 'Request failed with api_key=secret-value',
    })
    expect(target.send).toHaveBeenCalledWith(
      APP_NOTIFICATION_CHANNEL,
      expect.objectContaining({
        severity: 'error',
        code: 'PERSISTENCE_FAILURE',
        message: 'Request failed with api_key=[redacted]',
      }),
    )

    const headless = new BackendNotificationReporter({
      getWebContents: () => undefined,
      log: vi.fn(),
    })
    expect(() =>
      headless.reportDiagnostic('Background cleanup failed', new Error()),
    ).not.toThrow()
  })

  it('removes URLs, paths, newlines and excessive content', () => {
    const safe = sanitizeDiagnosticMessage(
      `Failed at https://example.test/path?token=secret in /home/alice/workspace/file ${'x'.repeat(2_000)}\nstack`,
    )
    expect(safe).toContain('<url>')
    expect(safe).toContain('<path>')
    expect(safe).not.toContain('secret')
    expect(safe).not.toContain('alice')
    expect(safe).not.toContain('stack')
    expect(safe.length).toBeLessThanOrEqual(1_024)
  })
})
