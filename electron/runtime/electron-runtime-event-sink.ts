import type { WebContents } from 'electron'
import { IPC_VERSION } from '../../shared/channels'
import type { AgentEvent, TerminalEvent } from '../../shared/agent-events'
import type { AgentExecutionEvent } from '../../shared/agent-execution'
import {
  sendAgentEvent,
  sendAgentExecutionEvent,
  sendTerminalEvent,
  sendBackgroundTaskEvent,
} from '../ipc/event-sink'
import type { RuntimeEventListener } from './runtime-events'

/** Bridges runtime events to the renderer WebContents currently supplied by the host. */
export function createElectronRuntimeEventListener(
  getWebContents: () => WebContents | undefined,
): RuntimeEventListener {
  return {
    onBackgroundTaskEvent: (event) => {
      const webContents = getWebContents()
      if (webContents) sendBackgroundTaskEvent(webContents, event)
    },
    onAgentEvent: (event: AgentEvent) => {
      const webContents = getWebContents()
      if (!webContents) return
      sendAgentEvent(webContents, { version: IPC_VERSION, event })
    },
    onAgentExecutionEvent: (event: AgentExecutionEvent) => {
      const webContents = getWebContents()
      if (!webContents) return
      sendAgentExecutionEvent(webContents, { version: IPC_VERSION, event })
    },
    onTerminalEvent: (event: TerminalEvent) => {
      const webContents = getWebContents()
      if (!webContents) return
      sendTerminalEvent(webContents, { version: IPC_VERSION, event })
    },
  }
}
