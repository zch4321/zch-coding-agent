<script setup lang="ts">
import { NDescriptions, NDescriptionsItem } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { UsageTotals } from '../../../shared/session-usage'

defineProps<{ totals: UsageTotals }>()
const { t } = useI18n()
const metrics = [
  'promptTokens',
  'completionTokens',
  'cacheHitTokens',
  'cacheMissTokens',
  'reasoningTokens',
  'calls',
] as const
</script>

<template>
  <NDescriptions
    :column="2"
    size="small"
    label-placement="top"
    class="usage-metrics"
  >
    <NDescriptionsItem
      v-for="metric in metrics"
      :key="metric"
      :label="t(`usage.metrics.${metric}`)"
    >
      <span>{{ totals[metric]?.toLocaleString() ?? '—' }}</span>
    </NDescriptionsItem>
  </NDescriptions>
</template>

<style scoped>
.usage-metrics {
  font-variant-numeric: tabular-nums;
}
</style>
