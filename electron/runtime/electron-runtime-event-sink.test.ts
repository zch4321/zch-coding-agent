import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { AGENT_EVENT_CHANNEL } from '../../shared/channels'
import type { AgentEvent } from '../../shared/agent-events'
import type { RunId, SessionId } from '../../shared/ids'
import { createElectronRuntimeEventListener } from './electron-runtime-event-sink'

const event: AgentEvent = {
  schemaVersion: 1,
  seq: 1,
  ts: new Date().toISOString(),
  type: 'run.status',
  sessionId: 'session:electron-runtime' as SessionId,
  runId: 'run:electron-runtime' as RunId,
  status: 'completed',
}

describe('Electron runtime event listener', () => {
  it('wraps runtime events for the current WebContents', () => {
    const send = vi.fn()
    const listener = createElectronRuntimeEventListener(
      () =>
        ({
          isDestroyed: () => false,
          send,
        }) as unknown as WebContents,
    )

    listener.onAgentEvent?.(event)

    expect(send).toHaveBeenCalledWith(
      AGENT_EVENT_CHANNEL,
      expect.objectContaining({ event }),
    )
  })

  it('does not require a renderer to accept a runtime event', () => {
    const listener = createElectronRuntimeEventListener(() => undefined)
    expect(() => listener.onAgentEvent?.(event)).not.toThrow()
  })
})
