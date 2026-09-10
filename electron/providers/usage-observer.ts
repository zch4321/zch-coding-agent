import type { PublicConfig } from '../../shared/config'
import type { LlmUsageRecord } from '../../shared/usage'
import type { UsageCallInput } from '../persistence/session-usage-repository'
import type { SessionUsagePort } from '../application/session-usage-service'
import type { ResolvedModelRoute } from './model-route-resolver'
import { normalizeLlmUsage } from './usage'
import { providerFailureUsage } from './provider-failure-usage'
import { normalizeChatUsage } from './chat-completions-shared'
import { responseUsage } from './generic-responses-provider'
import {
  normalizedAnthropicUsage,
  normalizedAnthropicCompactUsage,
} from './anthropic-usage'
import {
  ProviderCompletionError,
  ProviderCompactUnsupportedError,
  type ProviderEvent,
  type ProviderCompactEvent,
  type ProviderUsage,
} from './provider'

/** Binds a source-call identity and frozen model route to the durable accounting sink. */
export function usageRecorder(input: {
  sink?: SessionUsagePort
  sessionId: UsageCallInput['sessionId']
  runId: UsageCallInput['runId']
  callId: string
  scope: LlmUsageRecord['scope']
  config: PublicConfig
  binding: ResolvedModelRoute
}): (usage: ProviderUsage) => Promise<void> {
  return async (value) => {
    if (!input.sink) return
    const usage = normalizeLlmUsage({
      scope: input.scope,
      config: input.config,
      provider: input.binding.provider,
      model: input.binding.snapshot.model,
      modelProfile: input.binding.modelProfile,
      usage: value,
    })
    if (usage)
      await input.sink.record({
        sessionId: input.sessionId,
        runId: input.runId,
        callId: input.callId,
        usage,
      })
  }
}

/** Records usage on receipt, including billed completions rejected by subsequent validation. */
export async function* observeProviderUsage<
  Event extends ProviderEvent | ProviderCompactEvent,
>(
  events: AsyncIterable<Event>,
  providerType: string,
  record?: (usage: ProviderUsage) => Promise<void>,
): AsyncIterable<Event> {
  let recorded = false
  try {
    for await (const event of events) {
      if (!recorded && event.type === 'completed') {
        await record?.('turn' in event ? event.turn.usage : event.compact.usage)
        recorded = true
      }
      yield event
    }
  } catch (error) {
    const received = providerFailureUsage(error)
    if (!recorded && received) {
      await record?.(received)
      recorded = true
    }
    if (
      !recorded &&
      (error instanceof ProviderCompletionError ||
        error instanceof ProviderCompactUnsupportedError) &&
      error.diagnostics
    ) {
      const raw = error.diagnostics.usage
      const usage =
        providerType === 'generic.responses'
          ? responseUsage(raw)
          : providerType === 'generic.anthropic'
            ? raw &&
              typeof raw === 'object' &&
              !Array.isArray(raw) &&
              'message_start' in raw
              ? normalizedAnthropicUsage(
                  raw.message_start ?? null,
                  raw.message_delta ?? null,
                )
              : normalizedAnthropicCompactUsage(raw)
            : normalizeChatUsage(raw)
      await record?.(usage)
    }
    throw error
  }
}
