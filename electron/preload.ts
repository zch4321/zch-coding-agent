import { contextBridge, ipcRenderer } from 'electron'
import { BACKGROUND_TASK_EVENT_CHANNEL } from '../shared/channels'
import {
  BackgroundTaskEventSchema,
  type BackgroundTaskEvent,
} from '../shared/background-tasks'
import {
  createAgentApi,
  type AgentApiSubscriptionAdapters,
  type IpcInvoke,
} from '../shared/agent-api'
import {
  APP_NOTIFICATION_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_EXECUTION_EVENT_CHANNEL,
  DOMAIN_STATE_EVENT_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
} from '../shared/channels'
import type {
  AgentEventEnvelope,
  AgentExecutionEventEnvelope,
  BackendNotificationEnvelope,
  DomainStateDelivery,
  TerminalEventEnvelope,
} from '../shared/ipc-contract'
import { BackendNotificationEnvelopeSchema } from '../shared/notifications'
import type { DomainStateEvent } from '../shared/domain-state-api'
import { compileSchema } from './schema-validator'
import { BackendNotificationBuffer } from './preload-notification-buffer'

const invoke: IpcInvoke = (channel, payload) =>
  ipcRenderer.invoke(channel, payload)

const validateBackendNotification = compileSchema(
  BackendNotificationEnvelopeSchema,
)
const backendNotifications = new BackendNotificationBuffer({ capacity: 64 })
const validateBackgroundTask = compileSchema(BackgroundTaskEventSchema)

ipcRenderer.on(APP_NOTIFICATION_CHANNEL, (_event, payload: unknown) => {
  if (!validateBackendNotification(payload)) {
    console.error('Rejected invalid backend notification')
    return
  }
  backendNotifications.push(payload as BackendNotificationEnvelope)
})

function subscribe<Event>(
  channel: string,
  listener: (event: Event) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: Event) => {
    listener(payload)
  }

  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const MAX_BUFFERED_DOMAIN_EVENTS = 256
const domainListeners = new Set<(event: DomainStateDelivery) => void>()
const bufferedDomainEvents: DomainStateEvent[] = []
let domainBufferOverflowed = false

ipcRenderer.on(
  DOMAIN_STATE_EVENT_CHANNEL,
  (_event, event: DomainStateEvent) => {
    if (domainListeners.size > 0) {
      for (const listener of domainListeners) {
        listener({ kind: 'commit', event })
      }
      return
    }
    if (bufferedDomainEvents.length >= MAX_BUFFERED_DOMAIN_EVENTS) {
      bufferedDomainEvents.length = 0
      domainBufferOverflowed = true
      return
    }
    if (!domainBufferOverflowed) bufferedDomainEvents.push(event)
  },
)

function subscribeDomainState(
  listener: (event: DomainStateDelivery) => void,
): () => void {
  domainListeners.add(listener)
  if (domainBufferOverflowed) {
    domainBufferOverflowed = false
    bufferedDomainEvents.length = 0
    listener({ kind: 'buffer_overflow' })
  } else {
    for (const event of bufferedDomainEvents.splice(0)) {
      listener({ kind: 'commit', event })
    }
  }
  return () => domainListeners.delete(listener)
}

const subscriptionAdapters: AgentApiSubscriptionAdapters = {
  backgroundTaskEvent: (listener) =>
    subscribe<BackgroundTaskEvent>(BACKGROUND_TASK_EVENT_CHANNEL, (event) => {
      if (validateBackgroundTask(event)) listener(event)
    }),
  agentEvent: (listener) =>
    subscribe<AgentEventEnvelope>(AGENT_EVENT_CHANNEL, listener),
  agentExecutionEvent: (listener) =>
    subscribe<AgentExecutionEventEnvelope>(
      AGENT_EXECUTION_EVENT_CHANNEL,
      listener,
    ),
  backendNotification: (listener) => backendNotifications.subscribe(listener),
  terminalEvent: (listener) =>
    subscribe<TerminalEventEnvelope>(TERMINAL_EVENT_CHANNEL, listener),
  domainState: subscribeDomainState,
}

const agentApi = Object.freeze(createAgentApi(invoke, subscriptionAdapters))

contextBridge.exposeInMainWorld('agentApi', agentApi)
