<script setup lang="ts">
import { NProgress, NTag, type TagProps } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'

defineProps<{
  activeTitle: string
  projectName: string
}>()

const agent = useAgentStore()
const { t } = useI18n()

function usageTokens(value: typeof agent.latestUsage): number {
  if (!value) return 0
  return (
    value.totalTokens ??
    (value.promptTokens ?? 0) + (value.completionTokens ?? 0)
  )
}

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
      accumulator.total += usageTokens(item.usage)
      accumulator.cacheHit += item.usage.cacheHitTokens ?? 0
      accumulator.cacheMiss += item.usage.cacheMissTokens ?? 0
      accumulator.output += item.usage.completionTokens ?? 0
      return accumulator
    },
    { total: 0, cacheHit: 0, cacheMiss: 0, output: 0 },
  )

  return {
    usedContextTokens,
    contextWindowTokens,
    contextPercent,
    contextWindowSource: latestContextUsage.contextWindowSource,
    totals,
  }
})
</script>

<template>
  <header class="conversation-header">
    <div>
      <h1>{{ activeTitle }}</h1>
      <p v-if="agent.workspacePath">{{ projectName }}</p>
      <div v-if="usageMetrics" class="usage-summary">
        <div class="usage-progress-row">
          <span>
            {{
              t('app.usageContext', {
                used: usageMetrics.usedContextTokens.toLocaleString(),
                context: usageMetrics.contextWindowTokens.toLocaleString(),
                percent: usageMetrics.contextPercent,
                source: usageMetrics.contextWindowSource,
              })
            }}
          </span>
          <span>
            {{
              t('app.usageTotal', {
                total: usageMetrics.totals.total.toLocaleString(),
              })
            }}
          </span>
        </div>
        <NProgress
          class="usage-progress"
          type="line"
          :percentage="usageMetrics.contextPercent"
          :show-indicator="false"
          :height="5"
          :border-radius="999"
          :aria-label="
            t('app.usageContext', {
              used: usageMetrics.usedContextTokens.toLocaleString(),
              context: usageMetrics.contextWindowTokens.toLocaleString(),
              percent: usageMetrics.contextPercent,
              source: usageMetrics.contextWindowSource,
            })
          "
        />
        <p>
          {{
            t('app.usageCache', {
              hit: usageMetrics.totals.cacheHit.toLocaleString(),
              miss: usageMetrics.totals.cacheMiss.toLocaleString(),
              output: usageMetrics.totals.output.toLocaleString(),
            })
          }}
        </p>
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
