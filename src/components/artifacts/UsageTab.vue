<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NCollapse,
  NCollapseItem,
  NDivider,
  NEmpty,
  NRadioButton,
  NRadioGroup,
  NScrollbar,
  NSpin,
  NText,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useAgentRuntimeStore } from '../../stores/agent-runtime'
import { useSessionUsageStore } from '../../stores/session-usage'
import type {
  ContextCategory,
  ContextEntry,
} from '../../../shared/session-usage'
import UsageMetrics from './UsageMetrics.vue'

const props = withDefaults(defineProps<{ active?: boolean }>(), {
  active: true,
})
const { t } = useI18n()
const replica = useAgentReplicaStore()
const runtime = useAgentRuntimeStore()
const usage = useSessionUsageStore()
const period = ref<'all' | 'run'>('all')
const snapshot = computed(() =>
  replica.selectedSessionId
    ? usage.snapshots[replica.selectedSessionId]
    : undefined,
)
const context = computed(() => snapshot.value?.context)
const summary = computed(() =>
  period.value === 'all'
    ? snapshot.value?.all
    : snapshot.value?.currentRun?.summary,
)
const colors: Record<ContextCategory, string> = {
  system: '#9b8afb',
  user: '#61a9fa',
  orchestration: '#e8b458',
  assistant: '#63bda5',
  toolDefinitions: '#d78cbe',
  toolCalls: '#78c4d2',
  toolResults: '#a6afbc',
}
const scopes = ['main', 'subagent', 'approval', 'compression', 'title'] as const
const groups = computed(() =>
  scopes.flatMap(
    (scope) =>
      summary.value?.scopes.filter((group) => group.scope === scope) ?? [],
  ),
)

/** Formats the share of one current-context category. */
function percent(bytes: number): string {
  return context.value?.totalBytes
    ? ((bytes / context.value.totalBytes) * 100).toFixed(1)
    : '0.0'
}

/** Labels source entries without exposing message bodies or internal Session identifiers. */
function entryLabel(entry: ContextEntry): string {
  return entry.source || t(`usage.kinds.${entry.kind}`)
}

watch(
  () => [props.active, replica.selectedSessionId] as const,
  ([active, sessionId]) => {
    if (active && sessionId) void usage.refresh(sessionId)
  },
  { immediate: true },
)
</script>

<template>
  <NScrollbar
    class="usage-tab"
    data-testid="usage-tab"
    :content-style="{ padding: '16px' }"
  >
    <NEmpty
      v-if="!replica.selectedSessionId"
      :description="t('usage.selectSession')"
    />
    <NSpin
      v-else
      :show="!snapshot && !!usage.loading[replica.selectedSessionId]"
    >
      <section :aria-label="t('usage.context')">
        <div class="usage-section-title">
          <h3>{{ t('usage.context') }}</h3>
          <NText depth="3">{{ context?.model }}</NText>
        </div>
        <div class="usage-context-total">
          <strong>{{ context?.totalBytes.toLocaleString() ?? '—' }}</strong>
          <NText depth="3">bytes</NText>
        </div>
        <div
          v-if="context"
          class="usage-context-bar"
          role="img"
          :aria-label="t('usage.context')"
        >
          <span
            v-for="group in context.categories"
            :key="group.category"
            :style="{
              width: `${percent(group.bytes)}%`,
              background: colors[group.category],
            }"
            :title="`${t(`usage.categories.${group.category}`)} ${group.bytes.toLocaleString()} bytes · ${percent(group.bytes)}%`"
          />
        </div>
        <NCollapse v-if="context" class="usage-context-groups">
          <NCollapseItem
            v-for="group in context.categories"
            :key="group.category"
            :name="group.category"
            :disabled="!group.entries.length"
          >
            <template #header>
              <span class="usage-category-label"
                ><i :style="{ background: colors[group.category] }" />{{
                  t(`usage.categories.${group.category}`)
                }}</span
              >
            </template>
            <template #header-extra>
              <span
                class="usage-category-number"
                :title="`${group.bytes.toLocaleString()} bytes`"
                >{{ group.bytes.toLocaleString() }}
                <NText depth="3">{{ percent(group.bytes) }}%</NText></span
              >
            </template>
            <div
              v-for="entry in group.entries"
              :key="entry.id"
              class="usage-entry"
            >
              <NText
                class="usage-entry-label"
                depth="3"
                :title="entryLabel(entry)"
                >{{ entry.seq ? `#${entry.seq} ` : ''
                }}{{ entryLabel(entry) }}</NText
              >
              <span :title="`${entry.bytes.toLocaleString()} bytes`">{{
                entry.bytes.toLocaleString()
              }}</span>
            </div>
          </NCollapseItem>
        </NCollapse>
      </section>
      <NDivider />
      <section :aria-label="t('usage.details')">
        <div class="usage-section-title">
          <h3>{{ t('usage.details') }}</h3>
        </div>
        <NRadioGroup
          v-model:value="period"
          size="small"
          :aria-label="t('usage.period')"
          class="usage-period"
        >
          <NRadioButton value="all">{{ t('usage.all') }}</NRadioButton>
          <NRadioButton value="run">{{
            runtime.activeRunId ? t('usage.currentRun') : t('usage.latestRun')
          }}</NRadioButton>
        </NRadioGroup>
        <UsageMetrics :totals="summary?.totals ?? { calls: 0 }" />
        <NCollapse class="usage-scopes">
          <NCollapseItem
            v-for="group in groups"
            :key="group.scope"
            :name="group.scope"
            :title="t(`usage.scopes.${group.scope}`)"
          >
            <template #header-extra
              ><NText depth="3">{{
                t('usage.callCount', { count: group.totals.calls })
              }}</NText></template
            >
            <UsageMetrics :totals="group.totals" />
            <NCollapse>
              <NCollapseItem
                v-if="group.models.length"
                name="models"
                :title="t('usage.models')"
              >
                <div
                  v-for="model in group.models"
                  :key="`${model.providerId}:${model.model}`"
                  class="usage-detail-card"
                >
                  <div class="usage-model-title">
                    {{ model.model }}
                    <NText depth="3">{{ model.providerLabel }}</NText>
                  </div>
                  <UsageMetrics :totals="model.totals" />
                </div>
              </NCollapseItem>
              <NCollapseItem
                v-if="group.tasks.length"
                name="tasks"
                :title="t('usage.tasks')"
              >
                <NCollapse>
                  <NCollapseItem
                    v-for="task in group.tasks"
                    :key="task.executionId"
                    :name="task.executionId"
                    :title="task.name"
                  >
                    <UsageMetrics :totals="task.totals" />
                  </NCollapseItem>
                </NCollapse>
              </NCollapseItem>
            </NCollapse>
          </NCollapseItem>
        </NCollapse>
      </section>
    </NSpin>
  </NScrollbar>
</template>

<style scoped>
.usage-tab {
  height: 100%;
}
.usage-section-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.usage-section-title h3 {
  margin: 0 0 12px;
  font-size: 14px;
}
.usage-section-title :deep(.n-text) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}
.usage-context-total {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
  font-variant-numeric: tabular-nums;
}
.usage-context-total strong {
  font-size: 24px;
  font-weight: 600;
}
.usage-context-total :deep(.n-text) {
  font-size: 12px;
}
.usage-context-bar {
  display: flex;
  height: 8px;
  overflow: hidden;
  border-radius: 4px;
  gap: 1px;
  margin-bottom: 20px;
}
.usage-context-bar span {
  min-width: 0;
}
.usage-category-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
}
.usage-category-label i {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex-shrink: 0;
}
.usage-category-number {
  font-size: 12px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.usage-category-number :deep(.n-text) {
  display: inline-block;
  min-width: 44px;
  text-align: right;
}
.usage-entry {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.usage-entry-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-period {
  margin: 0 0 16px;
}
.usage-scopes {
  margin-top: 12px;
}
.usage-detail-card + .usage-detail-card {
  margin-top: 12px;
}
.usage-model-title {
  margin-bottom: 8px;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.usage-model-title :deep(.n-text) {
  font-size: 11px;
}
</style>
