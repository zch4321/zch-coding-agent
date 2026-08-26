<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NButton,
  NCollapse,
  NCollapseItem,
  NEmpty,
  NScrollbar,
  NSpin,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { AgentExecutionSummary } from '../../../shared/agent-execution'
import type { AgentExecutionId, SessionId } from '../../../shared/ids'
import {
  useAgentExecutionStore,
  isActiveAgentExecution,
} from '../../stores/agent-executions'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import UiIcon from '../UiIcon.vue'
import AgentExecutionBody from './AgentExecutionBody.vue'

const executions = useAgentExecutionStore()
const replica = useAgentReplicaStore()
const { t } = useI18n()
const expanded = ref<Array<string | number>>([])
const expandedChildren = ref<Record<string, Array<string | number>>>({})
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
  if (summary.status === 'queued' || summary.status === 'preparing') {
    return statusLabel(summary)
  }
  if (summary.kind === 'swarm') {
    const children = executions.childrenFor(summary.id)
    const counts = summary.agentCounts
    const completed = children.length
      ? children.filter((child) => child.status === 'completed').length
      : (counts?.completed ?? 0)
    const active = children.length
      ? children.filter(isActiveAgentExecution).length
      : (counts?.queued ?? 0) + (counts?.running ?? 0)
    const total = children.length || counts?.total || active
    return t('artifact.swarmProgress', { completed, total, active })
  }
  const live = executions.live[summary.id]
  if (live?.providerRetry) {
    return t('artifact.agentRetrying', live.providerRetry)
  }
  if (live?.phase === 'awaiting_approval') {
    return t('chat.runActivity.awaiting_approval')
  }
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

async function loadExpanded(values: Array<string | number>): Promise<void> {
  const value = values[0]
  if (typeof value !== 'string') return
  await executions.loadDetail(value as AgentExecutionId)
}

async function loadExpandedChild(
  values: Array<string | number>,
): Promise<void> {
  const value = values[0]
  if (typeof value !== 'string') return
  await executions.loadDetail(value as AgentExecutionId)
}

watch(
  () => replica.selectedSessionId,
  (sessionId) => {
    expanded.value = []
    expandedChildren.value = {}
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
  <NScrollbar class="artifact-content agent-executions-view">
    <section class="agent-executions-content">
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
          <AgentExecutionBody :summary="summary" :now="now" />
          <NCollapse
            v-if="
              summary.kind === 'swarm' &&
              executions.childrenFor(summary.id).length
            "
            v-model:expanded-names="expandedChildren[summary.id]"
            class="agent-execution-child-list"
            accordion
            arrow-placement="right"
            @update:expanded-names="loadExpandedChild"
          >
            <NCollapseItem
              v-for="child in executions.childrenFor(summary.id)"
              :key="child.id"
              :name="child.id"
              class="agent-execution-child-item"
            >
              <template #header>
                <div class="agent-execution-header">
                  <span
                    class="agent-execution-status-dot"
                    :class="statusClass(child)"
                  />
                  <div class="agent-execution-heading">
                    <strong>{{ child.name }}</strong>
                    <span>{{ currentPhase(child) }}</span>
                  </div>
                </div>
              </template>
              <AgentExecutionBody :summary="child" :now="now" />
            </NCollapseItem>
          </NCollapse>
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
  </NScrollbar>
</template>
