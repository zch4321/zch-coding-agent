<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NSelect, type SelectOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { FileChangeSummary } from '../../../shared/file-change'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

type ChangeStatusFilter = 'all' | 'active' | 'reverted'

const agent = useAgentStore()
const { t } = useI18n()

const selectedChangeId = ref<string>()
const filterCallId = ref<string | undefined>(undefined)
const filterPath = ref<string | undefined>(undefined)
const filterStatus = ref<ChangeStatusFilter>('all')

const selectedChange = computed(
  () =>
    agent.changes.find((change) => change.id === selectedChangeId.value) ??
    filteredChanges.value[0],
)
const callOptions = computed<SelectOption[]>(() => {
  const calls = new Map<string, number>()
  for (const change of agent.changes) {
    calls.set(change.callId, (calls.get(change.callId) ?? 0) + 1)
  }
  return [
    { label: t('artifact.filterAll'), value: undefined },
    ...[...calls.entries()].map(([callId, count]) => ({
      label: `${callId} (${count})`,
      value: callId,
    })),
  ]
})
const pathOptions = computed<SelectOption[]>(() => {
  const paths = new Map<string, number>()
  for (const change of agent.changes) {
    paths.set(change.path, (paths.get(change.path) ?? 0) + 1)
  }
  return [
    { label: t('artifact.filterAll'), value: undefined },
    ...[...paths.entries()].map(([path, count]) => ({
      label: `${path} (${count})`,
      value: path,
    })),
  ]
})
const statusOptions = computed<SelectOption[]>(
  () =>
    [
      { label: t('artifact.filterAll'), value: 'all' },
      { label: t('artifact.filterActive'), value: 'active' },
      { label: t('artifact.filterReverted'), value: 'reverted' },
    ] as SelectOption[],
)
const filteredChanges = computed(() =>
  agent.changes.filter((change) => {
    if (filterCallId.value && change.callId !== filterCallId.value) return false
    if (filterPath.value && change.path !== filterPath.value) return false
    if (filterStatus.value === 'active' && change.revertedAt) return false
    if (filterStatus.value === 'reverted' && !change.revertedAt) return false
    return true
  }),
)

async function revertChange(change: FileChangeSummary) {
  if (!window.confirm(t('artifact.revertConfirm', { path: change.path }))) {
    return
  }
  await agent.revertChange(change.id)
}

watch(
  () => [agent.activeConversationId, agent.workspacePath] as const,
  () => {
    filterCallId.value = undefined
    filterPath.value = undefined
    filterStatus.value = 'all'
    void agent.loadConversationChanges()
  },
  { immediate: true },
)

watch(
  () => agent.changes,
  (changes) => {
    if (!changes.some((change) => change.id === selectedChangeId.value)) {
      selectedChangeId.value = changes[0]?.id
    }
  },
  { deep: true },
)
</script>

<template>
  <section class="artifact-content diff-view">
    <template v-if="agent.pendingApproval?.diff">
      <div class="diff-summary">
        <span>{{ t('artifact.pendingChange') }}</span>
        <strong>{{ agent.pendingApproval.tool }}</strong>
        <p>{{ agent.pendingApproval.reason }}</p>
        <code v-if="agent.pendingApproval.diffHash">
          {{ agent.pendingApproval.diffHash }}
        </code>
      </div>
      <pre class="diff-content">{{ agent.pendingApproval.diff }}</pre>
      <div class="diff-actions">
        <NButton
          type="primary"
          :loading="agent.approvalSubmitting"
          :disabled="agent.approvalSubmitting"
          @click="
            agent.decideApproval({
              decision: 'allow',
            })
          "
        >
          {{ t('common.approve') }}
        </NButton>
        <NButton
          secondary
          :disabled="agent.approvalSubmitting"
          @click="
            agent.decideApproval({
              decision: 'deny',
            })
          "
        >
          {{ t('common.deny') }}
        </NButton>
      </div>
    </template>
    <template v-else-if="agent.changes.length && selectedChange">
      <div class="change-history-header">
        <div>
          <strong>{{ t('artifact.changeHistory') }}</strong>
          <span>{{
            t('artifact.changeCount', { count: agent.changes.length })
          }}</span>
          <span v-if="agent.selectedFileChangeHasMore">
            {{ t('artifact.historyTruncated') }}
          </span>
        </div>
        <span v-if="agent.changesLoading">{{ t('common.loading') }}</span>
      </div>
      <div class="change-filters">
        <NSelect
          v-model:value="filterCallId"
          :options="callOptions"
          :placeholder="t('artifact.filterByToolCall')"
          size="small"
          filterable
          class="change-filter-select"
        />
        <NSelect
          v-model:value="filterPath"
          :options="pathOptions"
          :placeholder="t('artifact.filterByFile')"
          size="small"
          filterable
          class="change-filter-select"
        />
        <NSelect
          v-model:value="filterStatus"
          :options="statusOptions"
          :placeholder="t('artifact.filterByStatus')"
          size="small"
          class="change-filter-select"
        />
      </div>
      <div
        v-if="filteredChanges.length"
        class="change-history-list"
        role="list"
      >
        <button
          v-for="change in filteredChanges"
          :key="change.id"
          type="button"
          :class="{ active: change.id === selectedChange.id }"
          role="listitem"
          @click="selectedChangeId = change.id"
        >
          <span>{{ change.path }}</span>
          <small>
            {{ t(`artifact.operation.${change.operation}`) }} ·
            {{ new Date(change.createdAt).toLocaleString() }}
          </small>
          <em v-if="change.revertedAt">{{ t('artifact.reverted') }}</em>
        </button>
      </div>
      <p v-else class="artifact-message">
        {{ t('artifact.noFilteredChanges') }}
      </p>
      <div v-if="agent.selectedFileChangeHasMore" class="change-load-more">
        <NButton
          size="small"
          secondary
          :loading="agent.changesLoading"
          @click="agent.loadOlderConversationChanges()"
        >
          {{ t('artifact.loadMoreChanges') }}
        </NButton>
      </div>
      <div class="diff-summary">
        <span>{{ t(`artifact.operation.${selectedChange.operation}`) }}</span>
        <span v-if="selectedChange.diffTruncated">
          {{ t('artifact.truncated') }}
        </span>
        <strong>{{ selectedChange.path }}</strong>
        <code v-if="selectedChange.diffHash">{{
          selectedChange.diffHash
        }}</code>
      </div>
      <pre class="diff-content">{{ selectedChange.diff }}</pre>
      <div class="diff-actions">
        <NButton
          type="warning"
          :loading="agent.revertingChangeId === selectedChange.id"
          :disabled="
            Boolean(selectedChange.revertedAt) ||
            Boolean(agent.revertingChangeId) ||
            Boolean(agent.activeRunId) ||
            Boolean(agent.pendingApproval)
          "
          @click="revertChange(selectedChange)"
        >
          {{
            selectedChange.revertedAt
              ? t('artifact.reverted')
              : t('artifact.revert')
          }}
        </NButton>
        <small>{{ t('artifact.revertSafetyHint') }}</small>
      </div>
    </template>
    <template v-else-if="agent.latestReviewedApproval?.diff">
      <div class="diff-summary">
        <span>
          {{
            t('artifact.reviewed', {
              decision: agent.latestReviewedApproval.decision,
            })
          }}
        </span>
        <strong>{{ agent.latestReviewedApproval.tool }}</strong>
        <p>{{ agent.latestReviewedApproval.reason }}</p>
      </div>
      <pre class="diff-content">{{ agent.latestReviewedApproval.diff }}</pre>
    </template>
    <div v-else class="artifact-empty">
      <UiIcon name="diff" />
      <h2>{{ t('artifact.noDiff') }}</h2>
      <p>{{ t('artifact.noDiffHint') }}</p>
    </div>
  </section>
</template>
