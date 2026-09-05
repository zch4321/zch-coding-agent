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
import BackgroundStopButton from './BackgroundStopButton.vue'
import BackgroundTerminalTail from './BackgroundTerminalTail.vue'
import { useBackgroundTaskStore } from '../../stores/background-tasks'
import {
  backgroundTaskKey,
  isBackgroundTaskActive,
} from '../../../shared/background-tasks'

const props = withDefaults(defineProps<{ active?: boolean }>(), {
  active: true,
})
const executions = useAgentExecutionStore()
const background = useBackgroundTaskStore()
const replica = useAgentReplicaStore()
const { t } = useI18n()
const expanded = ref<Array<string | number>>([])
const expandedChildren = ref<Record<string, Array<string | number>>>({})
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const records = computed(() => background.selectedRecords)
const sessionView = computed(() => background.selectedView)

function statusClass(summary: AgentExecutionSummary): string {
  return `status-${summary.status.replace(/_/g, '-')}`
}

function statusLabel(summary: AgentExecutionSummary): string {
  return t(`artifact.agentStatus.${summary.status}`)
}

function currentPhase(summary: AgentExecutionSummary): string {
  if (!isActiveAgentExecution(summary)) return statusLabel(summary)
  if (summary.stopRequested) return t('artifact.stopping')
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
  if (typeof value !== 'string' || value.startsWith('terminal:')) return
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
    if (sessionId) void background.load(sessionId)
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
            background.load(replica.selectedSessionId as SessionId, {
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
        :trigger-areas="['main', 'arrow']"
      >
        <NCollapseItem
          v-for="task in records"
          :key="backgroundTaskKey(task)"
          :name="backgroundTaskKey(task)"
          class="agent-execution-item"
        >
          <template #header>
            <div v-if="task.kind === 'agent'" class="agent-execution-header">
              <span
                class="agent-execution-status-dot"
                :class="statusClass(task.summary)"
              />
              <div class="agent-execution-heading">
                <strong>{{ task.summary.name }}</strong>
                <span>{{ currentPhase(task.summary) }}</span>
              </div>
            </div>
            <div v-else class="agent-execution-header">
              <UiIcon name="terminal" />
              <div class="agent-execution-heading">
                <strong>{{
                  t('artifact.terminalTitle', { id: task.terminalId })
                }}</strong>
                <span
                  >{{ t(`terminal.status.${task.status}`) }} ·
                  {{ task.shell.split(/[\\/]/).at(-1)
                  }}<template v-if="task.exitCode !== null">
                    ·
                    {{
                      t('artifact.terminalExitCode', { code: task.exitCode })
                    }}</template
                  ></span
                >
              </div>
            </div>
          </template>
          <template #header-extra>
            <BackgroundStopButton
              v-if="replica.selectedSessionId"
              :session-id="replica.selectedSessionId"
              :target="
                task.kind === 'agent'
                  ? { kind: task.summary.kind, executionId: task.summary.id }
                  : { kind: 'terminal', terminalId: task.terminalId }
              "
              :active="isBackgroundTaskActive(task)"
              :stopping="
                task.kind === 'agent'
                  ? task.summary.stopRequested
                  : task.status === 'closing'
              "
            />
          </template>
          <BackgroundTerminalTail
            v-if="
              task.kind === 'terminal' &&
              replica.selectedSessionId &&
              background.backendInstanceId
            "
            :terminal="task"
            :session-id="replica.selectedSessionId"
            :backend-instance-id="background.backendInstanceId"
            :visible="
              props.active && expanded.includes(backgroundTaskKey(task))
            "
          />
          <template v-if="task.kind === 'agent'">
            <AgentExecutionBody :summary="task.summary" :now="now" />
            <NCollapse
              v-if="
                task.summary.kind === 'swarm' &&
                executions.childrenFor(task.summary.id).length
              "
              v-model:expanded-names="expandedChildren[task.summary.id]"
              class="agent-execution-child-list"
              accordion
              arrow-placement="right"
              :trigger-areas="['main', 'arrow']"
              @update:expanded-names="loadExpandedChild"
            >
              <NCollapseItem
                v-for="child in executions.childrenFor(task.summary.id)"
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
                <template #header-extra>
                  <BackgroundStopButton
                    v-if="replica.selectedSessionId"
                    :session-id="replica.selectedSessionId"
                    :target="{ kind: 'subagent', executionId: child.id }"
                    :active="isActiveAgentExecution(child)"
                    :stopping="child.stopRequested"
                  />
                </template>
                <AgentExecutionBody :summary="child" :now="now" />
              </NCollapseItem>
            </NCollapse>
          </template>
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
          background.load(replica.selectedSessionId, { append: true })
        "
      >
        {{ t('artifact.agentLoadMore') }}
      </NButton>
      <NEmpty
        v-else-if="!records.length && !sessionView?.loading"
        class="artifact-empty"
        :description="t('artifact.noBackgroundTasks')"
      >
        <template #icon><UiIcon name="agents" /></template>
        <template #extra>
          <span class="artifact-empty-hint">{{
            t('artifact.noBackgroundTasksHint')
          }}</span>
        </template>
      </NEmpty>
    </section>
  </NScrollbar>
</template>
