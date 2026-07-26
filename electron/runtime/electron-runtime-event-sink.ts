import type { WebContents } from 'electron'
import { IPC_VERSION } from '../../shared/channels'
import type { AgentEvent, TerminalEvent } from '../../shared/agent-events'
import { sendAgentEvent, sendTerminalEvent } from '../ipc/event-sink'
import type { RuntimeEventListener } from './runtime-events'

/** Creates electron runtime event listener. */
export function createElectronRuntimeEventListener(
  getWebContents: () => WebContents | undefined,
): RuntimeEventListener {
  return {
    onAgentEvent: (event: AgentEvent) => {
      const webContents = getWebContents()
      if (!webContents) return
      sendAgentEvent(webContents, { version: IPC_VERSION, event })
    },
    onTerminalEvent: (event: TerminalEvent) => {
      const webContents = getWebContents()
      if (!webContents) return
      sendTerminalEvent(webContents, { version: IPC_VERSION, event })
    },
  }
}
