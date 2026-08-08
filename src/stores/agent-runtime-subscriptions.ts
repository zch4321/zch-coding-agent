import type { AgentApi } from '../../shared/agent-api'
import type { AgentEvent } from '../../shared/agent-events'
import type { DomainStateDelivery } from '../../shared/ipc-contract'
import type { SessionOverlay } from './agent-runtime-helpers'
import type { useAgentExecutionStore } from './agent-executions'
import type { useAgentReplicaStore } from './agent-replica'
import type { useAgentShellStore } from './agent-shell'
import { useNotificationStore } from './notifications'

type AgentExecutionStore = ReturnType<typeof useAgentExecutionStore>
type AgentReplicaStore = ReturnType<typeof useAgentReplicaStore>
type AgentShellStore = ReturnType<typeof useAgentShellStore>

/** Supplies the stores and callbacks needed by runtime IPC subscriptions. */
export interface RuntimeSubscriptionContext {
  api: AgentApi
  shell: AgentShellStore
  replica: AgentReplicaStore
  executions: AgentExecutionStore
  overlays: Record<string, SessionOverlay>
  handleAgentEvent: (event: AgentEvent) => void
}

function reconcileDomainDelivery(
  delivery: DomainStateDelivery,
  context: RuntimeSubscriptionContext,
): void {
  const { executions, overlays, replica } = context
  if (delivery.kind === 'buffer_overflow') {
    void replica.bootstrap(replica.selectedProject?.path)
    return
  }

  const commit = delivery.event.commit
  void replica.reconcile(commit).then((outcome) => {
    if (outcome !== 'duplicate' && commit.topic === 'session.removed') {
      delete overlays[commit.change.sessionId]
      executions.removeSession(commit.change.sessionId)
    }
    if (outcome !== 'duplicate' && commit.topic === 'session.changed') {
      const overlay = overlays[commit.change.session.id]
      if (overlay) {
        overlay.goal = commit.change.session.goal
          ? structuredClone(commit.change.session.goal)
          : undefined
        overlay.plan = commit.change.session.plan
          ? structuredClone(commit.change.session.plan)
          : undefined
      }
    }
    if (
      outcome !== 'duplicate' &&
      commit.topic === 'session.changed' &&
      commit.change.messageChange.mode === 'upsert'
    ) {
      const overlay = overlays[commit.change.session.id]
      if (!overlay) return
      if (
        commit.change.messageChange.records.some(
          (record) =>
            record.kind === 'assistant_turn' && record.visibility === 'visible',
        )
      ) {
        overlay.text = ''
        overlay.reasoning = ''
      }
      const durableInterjectionIds = new Set(
        commit.change.messageChange.records.flatMap((record) =>
          record.kind === 'interjection' && record.metadata?.interjectionId
            ? [record.metadata.interjectionId]
            : [],
        ),
      )
      overlay.interjections = overlay.interjections.filter(
        (interjection) => !durableInterjectionIds.has(interjection.id),
      )
    }
  })
}

/** Replaces every runtime IPC subscription with handlers for the current stores. */
export function registerRuntimeSubscriptions(
  context: RuntimeSubscriptionContext,
): void {
  const { api, executions, shell } = context
  shell.disposeSubscriptions()
  shell.registerUnsubscriber(
    api.onDomainStateEvent((delivery) => {
      reconcileDomainDelivery(delivery, context)
    }),
  )
  shell.registerUnsubscriber(
    api.onAgentEvent((envelope) => {
      context.handleAgentEvent(envelope.event)
    }),
  )
  shell.registerUnsubscriber(
    api.onAgentExecutionEvent((envelope) => {
      executions.handleEvent(envelope.event)
    }),
  )
  shell.registerUnsubscriber(
    api.onBackendNotification((notification) => {
      useNotificationStore().enqueue(notification)
    }),
  )
}
