import { computed, type ComputedRef } from 'vue'
import type { MessageRecord } from '../../shared/message'
import type { ConversationTurn } from './agent-types'
import { blankOverlay, type SessionOverlay } from './agent-runtime-helpers'
import {
  projectConversationHistory,
  projectConversationOverlay,
} from './conversation-timeline'

interface Sources {
  records(): readonly MessageRecord[]
  overlay(): SessionOverlay | undefined
}

interface CachedView {
  source: object
  owner?: SessionOverlay
  view: object
}

function shallowEqual(left: object, right: object): boolean {
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) =>
      Object.is(Reflect.get(left, key), Reflect.get(right, key)),
    )
  )
}

function reuseArray<T>(next: T[], previous?: T[]): T[] {
  return previous?.length === next.length &&
    next.every((item, index) => item === previous[index])
    ? previous
    : next
}

/** Keeps history and item identities stable while live text is read by its owning component. */
export function createConversationTimeline(
  sources: Sources,
): ComputedRef<ConversationTurn[]> {
  const history = computed(() => projectConversationHistory(sources.records()))
  const hasText = computed(() => Boolean(sources.overlay()?.text.trim()))
  const hasReasoning = computed(() =>
    Boolean(sources.overlay()?.reasoning.trim()),
  )
  let previous: ConversationTurn[] = []
  let cache = new Map<string, CachedView>()

  return computed(() => {
    const overlay = sources.overlay()
    // Read only structural dependencies here. Text getters below are consumed by
    // individual message/reasoning components, never by this projection.
    const structuralOverlay = overlay
      ? {
          ...blankOverlay(),
          runId: overlay.runId,
          status: overlay.status,
          streamActivity: overlay.streamActivity,
          providerRetry: overlay.providerRetry,
          tools: overlay.tools,
          interjections: overlay.interjections,
          todo: overlay.todo,
          approval: overlay.approval,
          terminalReloadRunId: overlay.terminalReloadRunId,
          text: hasText.value ? 'live' : '',
          reasoning: hasReasoning.value ? 'live' : '',
        }
      : undefined
    const projected = projectConversationOverlay(
      history.value,
      structuralOverlay,
    )
    const nextCache = new Map<string, CachedView>()
    const reuse = <T extends object>(
      key: string,
      source: T,
      live = false,
    ): T => {
      const owner = live ? overlay : undefined
      const old = cache.get(key)
      if (old && old.owner === owner && shallowEqual(old.source, source)) {
        nextCache.set(key, old)
        return old.view as T
      }
      const view =
        live && owner
          ? {
              ...source,
              get text() {
                return key.startsWith('reasoning:')
                  ? owner.reasoning
                  : owner.text
              },
            }
          : source
      nextCache.set(key, { source, owner, view })
      return view
    }
    const previousTurns = new Map(previous.map((turn) => [turn.id, turn]))
    const next = projected.map((turn) => {
      const old = previousTurns.get(turn.id)
      const messages = turn.messages.map((message) =>
        reuse(
          `message:${message.id}`,
          message,
          message.durableKind === 'stream',
        ),
      )
      const reasoning = turn.reasoningSegments.map((segment) =>
        reuse(`reasoning:${segment.id}`, segment, segment.live),
      )
      const tools = turn.tools.map((tool) => reuse(`tool:${tool.callId}`, tool))
      return reuse(`turn:${turn.id}`, {
        ...turn,
        userMessage: turn.userMessage
          ? reuse(`message:${turn.userMessage.id}`, turn.userMessage)
          : undefined,
        messages: reuseArray(messages, old?.messages),
        reasoningSegments: reuseArray(reasoning, old?.reasoningSegments),
        tools: reuseArray(tools, old?.tools),
      })
    })
    cache = nextCache
    previous = reuseArray(next, previous)
    return previous
  })
}
