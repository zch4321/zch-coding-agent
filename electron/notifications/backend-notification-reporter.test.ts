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

    reporter.reportDiagnostic('MCP server transport error', error, {
      audience: 'notification',
      code: 'MCP_BACKGROUND_FAILURE',
    })

    expect(log).toHaveBeenCalledWith('MCP server transport error', error, {
      audience: 'notification',
      code: 'MCP_BACKGROUND_FAILURE',
    })
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

  it('does not duplicate diagnostics explicitly classified as internal', () => {
    const target = webContents()
    const reporter = new BackendNotificationReporter({
      getWebContents: () => target,
      log: vi.fn(),
    })
    reporter.reportDiagnostic('IPC handler session:get failed', new Error(), {
      audience: 'internal',
    })
    reporter.reportDiagnostic('Run run:1 ended unexpectedly', new Error(), {
      audience: 'internal',
    })
    reporter.reportDiagnostic(
      'Trace capture failed for session:1',
      new Error(),
      {
        audience: 'internal',
      },
    )
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

  it('forwards the operational diagnostic ID to renderer notifications', () => {
    const target = webContents()
    const log = vi.fn(
      () => 'diagnostic:shared' as import('../../shared/ids').DiagnosticId,
    )
    const reporter = new BackendNotificationReporter({
      getWebContents: () => target,
      log,
    })

    reporter.reportDiagnostic('Provider failed', new Error('network'), {
      audience: 'notification',
      severity: 'error',
      code: 'PROVIDER_NETWORK_ERROR',
      message: 'Provider request failed.',
    })

    expect(target.send).toHaveBeenCalledWith(
      APP_NOTIFICATION_CHANNEL,
      expect.objectContaining({ diagnosticId: 'diagnostic:shared' }),
    )
    expect(log).toHaveBeenCalledOnce()
  })

  it('removes URLs, paths, newlines and excessive content', () => {
    const safe = sanitizeDiagnosticMessage(
      `Failed at https://example.test/path?token=secret in /srv/alice/workspace/file ${'x'.repeat(2_000)}\nstack`,
    )
    expect(safe).toContain('<url>')
    expect(safe).toContain('<path>')
    expect(safe).not.toContain('secret')
    expect(safe).not.toContain('alice')
    expect(safe).not.toContain('stack')
    expect(safe.length).toBeLessThanOrEqual(1_024)
    expect(
      sanitizeDiagnosticMessage(
        'Provider rejected {"api_key":"quoted-secret","token": "other-secret"}',
      ),
    ).not.toContain('quoted-secret')
  })
})
