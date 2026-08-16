<script setup lang="ts">
import { NProgress, NTag, type TagProps } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'
import { cacheHitRatePercent, formatTokenCount } from './usage-format'

defineProps<{
  activeTitle: string
}>()

const agent = useAgentStore()
const { t } = useI18n()

const statusLabel = computed(() => {
  if (agent.pendingApproval) {
    return t('app.waitingApproval')
  }

  if (agent.runStatus === 'failed') {
    return t('app.failed')
  }

  if (agent.runStatus === 'cancelling') {
    return t('app.cancelling')
  }

  if (agent.activeRunId) {
    return t('app.running')
  }

  return ''
})

const statusType = computed<TagProps['type']>(() => {
  if (agent.pendingApproval) return 'warning'
  if (agent.runStatus === 'failed') return 'error'
  return 'info'
})

const captureStatus = computed(() => {
  const capture = agent.selectedTraceCapture
  if (!capture || capture.state === 'disabled') return undefined
  if (capture.state === 'active') {
    return { label: t('logging.captureActiveTitle'), type: 'success' as const }
  }
  if (capture.state === 'pending') {
    return { label: t('logging.capturePendingTitle'), type: 'warning' as const }
  }
  return {
    label: t('logging.captureDegradedTitle'),
    type: 'error' as const,
    title: capture.warning,
  }
})

const usageMetrics = computed(() => {
  const latestContextUsage = [...agent.usage]
    .reverse()
    .find((item) => item.usage.scope === 'main')?.usage
  if (!latestContextUsage) return undefined

  const usedContextTokens =
    latestContextUsage.promptTokens ??
    (latestContextUsage.cacheHitTokens ?? 0) +
      (latestContextUsage.cacheMissTokens ?? 0)
  const contextWindowTokens = latestContextUsage.contextWindowTokens
  const contextPercent =
    contextWindowTokens > 0
      ? Math.min(
          100,
          Math.round((usedContextTokens / contextWindowTokens) * 100),
        )
      : 0
  const totals = agent.usage.reduce(
    (accumulator, item) => {
      accumulator.cacheHit += item.usage.cacheHitTokens ?? 0
      accumulator.cacheMiss += item.usage.cacheMissTokens ?? 0
      accumulator.output += item.usage.completionTokens ?? 0
      return accumulator
    },
    { cacheHit: 0, cacheMiss: 0, output: 0 },
  )

  return {
    usedContextTokens,
    contextWindowTokens,
    contextPercent,
    contextWindowSource: latestContextUsage.contextWindowSource,
    totals,
  }
})

const contextTooltip = computed(() => {
  const metrics = usageMetrics.value
  if (!metrics) return ''
  return t('app.usageContext', {
    used: metrics.usedContextTokens.toLocaleString(),
    context: metrics.contextWindowTokens.toLocaleString(),
    percent: metrics.contextPercent,
    source: metrics.contextWindowSource,
  })
})

const contextCompactLabel = computed(() => {
  const metrics = usageMetrics.value
  if (!metrics) return ''
  return t('app.usageContextCompact', {
    used: formatTokenCount(metrics.usedContextTokens),
    context: formatTokenCount(metrics.contextWindowTokens),
    percent: metrics.contextPercent,
  })
})

const cacheLabel = computed(() => {
  const metrics = usageMetrics.value
  if (!metrics) return ''
  const base = t('app.usageCache', {
    hit: formatTokenCount(metrics.totals.cacheHit),
    miss: formatTokenCount(metrics.totals.cacheMiss),
    output: formatTokenCount(metrics.totals.output),
  })
  const rate = cacheHitRatePercent(
    metrics.totals.cacheHit,
    metrics.totals.cacheMiss,
  )
  return rate === undefined
    ? base
    : `${base} · ${t('app.usageCacheRate', { rate })}`
})
</script>

<template>
  <header class="conversation-header">
    <div>
      <h1>{{ activeTitle }}</h1>
      <div v-if="usageMetrics" class="usage-summary">
        <div class="usage-progress-row" :title="contextTooltip">
          <NProgress
            class="usage-progress"
            type="line"
            :percentage="usageMetrics.contextPercent"
            :show-indicator="false"
            :height="5"
            :border-radius="999"
            :aria-label="contextTooltip"
          />
          <span class="usage-progress-text">{{ contextCompactLabel }}</span>
        </div>
        <p>{{ cacheLabel }}</p>
      </div>
    </div>
    <div class="conversation-statuses">
      <NTag
        v-if="captureStatus"
        round
        size="small"
        :type="captureStatus.type"
        :title="captureStatus.title"
      >
        {{ captureStatus.label }}
      </NTag>
      <NTag
        v-if="statusLabel"
        class="run-status"
        round
        size="small"
        :type="statusType"
      >
        {{ statusLabel }}
      </NTag>
    </div>
  </header>
</template>
