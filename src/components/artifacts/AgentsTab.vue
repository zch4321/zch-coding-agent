<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NCollapse, NCollapseItem, NEmpty, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
  AgentExecutionActivity,
  AgentExecutionSummary,
} from '../../../shared/agent-execution'
import type { AgentExecutionId, SessionId } from '../../../shared/ids'
import {
  useAgentExecutionStore,
  isActiveAgentExecution,
} from '../../stores/agent-executions'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import UiIcon from '../UiIcon.vue'
import MarkdownBlock from '../MarkdownBlock.vue'

const executions = useAgentExecutionStore()
const replica = useAgentReplicaStore()
const { t } = useI18n()
const expanded = ref<Array<string | number>>([])
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const records = computed(() => executions.selectedExecutions)
const sessionView = computed(() => executions.selectedSessionView)

function statusClass(summary: AgentExecutionSummary): string {
  return `status-${summary.status.replace(/_/g, '-')}`
}

function statusLabel(summary: AgentExecutionSummary): string {
  return t(`artifact.agentStatus.${summary.status}`)
}

function currentPhase(summary: AgentExecutionSummary): string {
  if (!isActiveAgentExecution(summary)) return statusLabel(summary)
  const live = executions.live[summary.id]
  const activities = executions.activitiesFor(summary.id)
  const lastTool = [...activities]
    .reverse()
    .find((activity) => activity.type === 'tool')
  if (lastTool?.type === 'tool' && lastTool.status === 'proposed') {
    return t('artifact.agentCallingTool', { tool: lastTool.tool })
  }
  if (live?.text.trim()) return t('artifact.agentOutputting')
  if (live?.phase === 'calling_llm' || live?.reasoning.trim()) {
    return t('artifact.agentThinking')
  }
  return t('artifact.agentRunning')
}

function elapsed(summary: AgentExecutionSummary): string {
  const end = summary.completedAt
    ? new Date(summary.completedAt).getTime()
    : now.value
  const start = new Date(summary.createdAt).getTime()
  const seconds = Math.max(0, Math.floor((end - start) / 1_000))
  if (seconds < 60)
    return t('artifact.agentDurationSeconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return t('artifact.agentDurationMinutes', {
    minutes,
    seconds: remainder,
  })
}

function usageLabel(summary: AgentExecutionSummary): string | undefined {
  return summary.usage
    ? t('artifact.agentTokens', { count: summary.usage.totalTokens })
    : undefined
}

function toolCallCount(summary: AgentExecutionSummary): number | undefined {
  return executions.details[summary.id]?.detail?.statistics.toolCallCount
}

function messagesFor(
  summary: AgentExecutionSummary,
): Array<Extract<AgentExecutionActivity, { type: 'message' }>> {
  return executions
    .activitiesFor(summary.id)
    .filter(
      (
        activity,
      ): activity is Extract<AgentExecutionActivity, { type: 'message' }> =>
        activity.type === 'message',
    )
}

async function loadExpanded(values: Array<string | number>): Promise<void> {
  const value = values[0]
  if (typeof value !== 'string') return
  await executions.loadDetail(value as AgentExecutionId)
}

watch(
  () => replica.selectedSessionId,
  (sessionId) => {
    expanded.value = []
    if (sessionId) void executions.loadSession(sessionId)
  },
  { immediate: true },
)

watch(expanded, (value) => void loadExpanded(value))

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1_000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <section class="artifact-content agent-executions-view">
    <NSpin
      v-if="sessionView?.loading && !sessionView.loaded"
      class="agent-execution-loader"
    />
    <div
      v-else-if="sessionView?.error && !records.length"
      class="artifact-error"
    >
      <p>{{ sessionView.error }}</p>
      <NButton
        v-if="replica.selectedSessionId"
        size="small"
        @click="
          executions.loadSession(replica.selectedSessionId as SessionId, {
            force: true,
          })
        "
      >
        {{ t('artifact.agentRetry') }}
      </NButton>
    </div>
    <NCollapse
      v-else-if="records.length"
      v-model:expanded-names="expanded"
      class="agent-execution-list"
      accordion
      arrow-placement="right"
    >
      <NCollapseItem
        v-for="summary in records"
        :key="summary.id"
        :name="summary.id"
        class="agent-execution-item"
      >
        <template #header>
          <div class="agent-execution-header">
            <span
              class="agent-execution-status-dot"
              :class="statusClass(summary)"
            />
            <div class="agent-execution-heading">
              <strong>{{ summary.name }}</strong>
              <span>{{ currentPhase(summary) }}</span>
            </div>
          </div>
        </template>
        <div class="agent-execution-detail">
          <div
            v-if="executions.details[summary.id]?.error"
            class="artifact-error"
          >
            {{ executions.details[summary.id]?.error }}
          </div>
          <NSpin
            v-if="
              executions.details[summary.id]?.loading &&
              !executions.details[summary.id]?.loaded
            "
            size="small"
          />
          <template v-else>
            <dl class="agent-execution-stats">
              <div class="agent-execution-stat">
                <dt>{{ t('artifact.agentRunTime') }}</dt>
                <dd>{{ elapsed(summary) }}</dd>
              </div>
              <div class="agent-execution-stat agent-execution-tool-count">
                <dt>{{ t('artifact.agentToolCalls') }}</dt>
                <dd>{{ toolCallCount(summary) ?? '—' }}</dd>
              </div>
              <div class="agent-execution-stat">
                <dt>{{ t('artifact.agentExecutionStatus') }}</dt>
                <dd>{{ statusLabel(summary) }}</dd>
              </div>
              <div v-if="usageLabel(summary)" class="agent-execution-stat">
                <dt>{{ t('artifact.agentTokenUsage') }}</dt>
                <dd>{{ usageLabel(summary) }}</dd>
              </div>
              <div
                v-if="summary.providerId && summary.model"
                class="agent-execution-stat agent-execution-stat-wide"
              >
                <dt>{{ t('artifact.agentModel') }}</dt>
                <dd>{{ summary.providerId }} · {{ summary.model }}</dd>
              </div>
            </dl>
            <div class="agent-execution-messages">
              <strong class="agent-execution-output-heading">
                {{ t('artifact.agentOutput') }}
              </strong>
              <article
                v-for="message in messagesFor(summary)"
                :key="message.id"
                class="agent-execution-message"
              >
                <MarkdownBlock :content="message.text" />
              </article>
              <p
                v-if="messagesFor(summary).length === 0"
                class="agent-execution-no-output"
              >
                {{ t('artifact.agentNoOutput') }}
              </p>
            </div>
            <p v-if="summary.error" class="agent-execution-error">
              {{ summary.error.message }}
            </p>
            <NButton
              v-if="
                executions.details[summary.id]?.detail?.activityPage.hasMore
              "
              size="small"
              secondary
              :loading="executions.details[summary.id]?.loading"
              @click.stop="executions.loadDetail(summary.id, { older: true })"
            >
              {{ t('artifact.agentLoadMore') }}
            </NButton>
          </template>
        </div>
      </NCollapseItem>
    </NCollapse>
    <NButton
      v-if="records.length && sessionView?.hasMore"
      class="agent-execution-load-more"
      size="small"
      secondary
      :loading="sessionView.loading"
      @click="
        replica.selectedSessionId &&
        executions.loadSession(replica.selectedSessionId, { append: true })
      "
    >
      {{ t('artifact.agentLoadMore') }}
    </NButton>
    <NEmpty
      v-else-if="!records.length && !sessionView?.loading"
      class="artifact-empty"
      :description="t('artifact.noAgents')"
    >
      <template #icon><UiIcon name="agents" /></template>
      <template #extra>
        <span class="artifact-empty-hint">{{
          t('artifact.noAgentsHint')
        }}</span>
      </template>
    </NEmpty>
  </section>
</template>
