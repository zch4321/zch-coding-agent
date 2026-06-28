<script setup lang="ts">
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
        <div
          class="usage-progress"
          :aria-label="
            t('app.usageContext', {
              used: usageMetrics.usedContextTokens.toLocaleString(),
              context: usageMetrics.contextWindowTokens.toLocaleString(),
              percent: usageMetrics.contextPercent,
              source: usageMetrics.contextWindowSource,
            })
          "
        >
          <span
            :style="{
              width: usageMetrics.contextPercent + '%',
            }"
          ></span>
        </div>
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
    <span
      v-if="statusLabel"
      class="run-status"
      :class="agent.pendingApproval ? 'approval' : agent.runStatus"
    >
      <span></span>{{ statusLabel }}
    </span>
  </header>
</template>
