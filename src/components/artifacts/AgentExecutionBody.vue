<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NButton, NSpace, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
  AgentExecutionActivity,
  AgentExecutionSummary,
} from '../../../shared/agent-execution'
import { useAgentExecutionStore } from '../../stores/agent-executions'
import MarkdownBlock from '../MarkdownBlock.vue'

const props = defineProps<{
  summary: AgentExecutionSummary
  now: number
}>()

const executions = useAgentExecutionStore()
const { t } = useI18n()
const detailView = computed(() => executions.details[props.summary.id])
const children = computed(() => executions.childrenFor(props.summary.id))
const live = computed(() => executions.live[props.summary.id])
const approval = computed(() => live.value?.approval)

function elapsed(): string {
  const end = props.summary.completedAt
    ? new Date(props.summary.completedAt).getTime()
    : props.now
  const start = new Date(props.summary.createdAt).getTime()
  const seconds = Math.max(0, Math.floor((end - start) / 1_000))
  if (seconds < 60) {
    return t('artifact.agentDurationSeconds', { count: seconds })
  }
  return t('artifact.agentDurationMinutes', {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  })
}

function usageLabel(): string | undefined {
  return props.summary.usage
    ? t('artifact.agentTokens', { count: props.summary.usage.totalTokens })
    : undefined
}

function agentCountLabel(): string | undefined {
  if (props.summary.kind !== 'swarm') return undefined
  const counts = props.summary.agentCounts
  const completed = children.value.length
    ? children.value.filter((child) => child.status === 'completed').length
    : (counts?.completed ?? 0)
  const total = children.value.length || counts?.total
  return total === undefined
    ? undefined
    : t('artifact.swarmAgentCount', { completed, total })
}

function messages(): Array<
  Extract<AgentExecutionActivity, { type: 'message' }>
> {
  return executions
    .activitiesFor(props.summary.id)
    .filter(
      (
        activity,
      ): activity is Extract<AgentExecutionActivity, { type: 'message' }> =>
        activity.type === 'message',
    )
}
</script>

<template>
  <div class="agent-execution-detail">
    <div v-if="detailView?.error" class="artifact-error">
      {{ detailView.error }}
    </div>
    <NSpin v-if="detailView?.loading && !detailView.loaded" size="small" />
    <template v-else>
      <NAlert
        v-if="approval"
        type="warning"
        :title="`${t('chat.approvalRequired')} · ${approval.tool}`"
      >
        <p>{{ approval.reason }}</p>
        <pre>{{ JSON.stringify(approval.arguments, null, 2) }}</pre>
        <NSpace>
          <NButton
            size="small"
            type="primary"
            :loading="live?.approvalSubmitting"
            @click.stop="executions.decideApproval(summary.id, 'allow')"
          >
            {{ t('common.approve') }}
          </NButton>
          <NButton
            size="small"
            :disabled="live?.approvalSubmitting"
            @click.stop="executions.decideApproval(summary.id, 'deny')"
          >
            {{ t('common.deny') }}
          </NButton>
        </NSpace>
      </NAlert>
      <dl class="agent-execution-stats">
        <div class="agent-execution-stat">
          <dt>{{ t('artifact.agentRunTime') }}</dt>
          <dd>{{ elapsed() }}</dd>
        </div>
        <div class="agent-execution-stat agent-execution-tool-count">
          <dt>{{ t('artifact.agentToolCalls') }}</dt>
          <dd>{{ detailView?.detail?.statistics.toolCallCount ?? '—' }}</dd>
        </div>
        <div class="agent-execution-stat">
          <dt>{{ t('artifact.agentExecutionStatus') }}</dt>
          <dd>{{ t(`artifact.agentStatus.${summary.status}`) }}</dd>
        </div>
        <div v-if="agentCountLabel()" class="agent-execution-stat">
          <dt>{{ t('artifact.swarmAgents') }}</dt>
          <dd>{{ agentCountLabel() }}</dd>
        </div>
        <div v-if="usageLabel()" class="agent-execution-stat">
          <dt>{{ t('artifact.agentTokenUsage') }}</dt>
          <dd>{{ usageLabel() }}</dd>
        </div>
        <div
          v-if="summary.providerId && summary.model"
          class="agent-execution-stat agent-execution-stat-wide"
        >
          <dt>{{ t('artifact.agentModel') }}</dt>
          <dd>{{ summary.providerId }} · {{ summary.model }}</dd>
        </div>
      </dl>
      <div v-if="summary.kind !== 'swarm'" class="agent-execution-messages">
        <strong class="agent-execution-output-heading">
          {{ t('artifact.agentOutput') }}
        </strong>
        <article
          v-for="message in messages()"
          :key="message.id"
          class="agent-execution-message"
        >
          <MarkdownBlock :content="message.text" />
        </article>
        <p v-if="messages().length === 0" class="agent-execution-no-output">
          {{ t('artifact.agentNoOutput') }}
        </p>
      </div>
      <p v-if="summary.error" class="agent-execution-error">
        {{ summary.error.message }}
      </p>
      <NButton
        v-if="detailView?.detail?.activityPage.hasMore"
        size="small"
        secondary
        :loading="detailView.loading"
        @click.stop="executions.loadDetail(summary.id, { older: true })"
      >
        {{ t('artifact.agentLoadMore') }}
      </NButton>
    </template>
  </div>
</template>
