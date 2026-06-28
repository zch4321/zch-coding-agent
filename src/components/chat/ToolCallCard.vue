<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type {
  PendingApproval,
  ReviewedApproval,
  ToolActivity,
} from '../../stores/agent'
import type { UsageActivity } from '../../stores/agent-types'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

defineProps<{
  tool: ToolActivity
  expanded: boolean
}>()
const emit = defineEmits<{
  toggle: []
}>()

const agent = useAgentStore()
const { t } = useI18n()

function toolResultSummary(tool: ToolActivity): string {
  const result = tool.result

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return tool.status === 'proposed' ? t('chat.proposed') : t('chat.completed')
  }

  if ('status' in result && result.status !== 'ok') {
    return String(result.status)
  }

  return t('chat.completed')
}

function toolDetailsName(tool: ToolActivity): string {
  return `${tool.callId}:details`
}

function stringifyJson(value: unknown, space = 2): string {
  try {
    return JSON.stringify(value, null, space) ?? String(value)
  } catch {
    return String(value)
  }
}

function hasToolResult(tool: ToolActivity): boolean {
  return tool.result !== undefined
}

function pendingApprovalForTool(
  tool: ToolActivity,
): PendingApproval | undefined {
  return agent.pendingApproval?.callId === tool.callId
    ? agent.pendingApproval
    : undefined
}

function reviewedApprovalForTool(
  tool: ToolActivity,
): ReviewedApproval | undefined {
  return agent.latestReviewedApproval?.callId === tool.callId
    ? agent.latestReviewedApproval
    : undefined
}

function approvalUsageForTool(tool: ToolActivity): UsageActivity | undefined {
  return agent.usage.find(
    (item) => item.callId === tool.callId && item.usage.scope === 'approval',
  )
}

function hasApprovalDetails(tool: ToolActivity): boolean {
  return Boolean(
    tool.approval ||
    pendingApprovalForTool(tool) ||
    reviewedApprovalForTool(tool) ||
    approvalUsageForTool(tool),
  )
}

function approvalUsageSummary(usage: UsageActivity): string {
  const values = [
    usage.usage.providerLabel,
    usage.usage.model,
    usage.usage.totalTokens !== undefined
      ? `${usage.usage.totalTokens} tokens`
      : undefined,
  ].filter(Boolean)

  return values.join(' · ')
}

function approvalUsageSummaryForTool(tool: ToolActivity): string {
  const usage = approvalUsageForTool(tool)
  return usage ? approvalUsageSummary(usage) : ''
}
</script>

<template>
  <article class="tool-call-card">
    <button
      type="button"
      class="tool-call-row"
      :title="tool.reason || tool.tool"
      :aria-controls="toolDetailsName(tool)"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <div class="tool-call-summary" :title="tool.reason || tool.tool">
        <span class="tool-call-muted">{{ t('chat.toolCall') }}</span>
        <strong>{{ tool.tool }}</strong>
        <span
          class="tool-status"
          :class="tool.status === 'completed' ? 'complete' : ''"
        >
          {{ toolResultSummary(tool) }}
        </span>
      </div>
      <span class="tool-details-toggle" aria-hidden="true">
        <UiIcon :name="expanded ? 'chevron-down' : 'chevron-right'" />
      </span>
    </button>
    <div v-if="expanded" :id="toolDetailsName(tool)" class="tool-call-details">
      <div class="tool-detail-block">
        <strong>{{ t('chat.arguments') }}</strong>
        <pre class="tool-args-json">{{ stringifyJson(tool.args) }}</pre>
      </div>
      <div v-if="hasToolResult(tool)" class="tool-detail-block">
        <strong>{{ t('chat.result') }}</strong>
        <pre class="tool-result-json">{{ stringifyJson(tool.result) }}</pre>
      </div>
      <div v-if="hasApprovalDetails(tool)" class="tool-detail-block">
        <strong>{{ t('chat.approvalDetails') }}</strong>
        <dl v-if="tool.approval" class="tool-approval-meta">
          <div>
            <dt>{{ t('chat.approver') }}</dt>
            <dd>{{ tool.approval.approver }}</dd>
          </div>
          <div>
            <dt>{{ t('chat.approvalDecision') }}</dt>
            <dd>{{ tool.approval.decision }}</dd>
          </div>
          <div>
            <dt>{{ t('chat.approvalValid') }}</dt>
            <dd>
              {{ tool.approval.valid ? t('common.yes') : t('common.no') }}
            </dd>
          </div>
          <div v-if="tool.approval.failure">
            <dt>{{ t('chat.approvalFailure') }}</dt>
            <dd>{{ tool.approval.failure }}</dd>
          </div>
        </dl>
        <p v-if="tool.approval?.reason" class="tool-approval-note">
          {{ tool.approval.reason }}
        </p>
        <dl v-if="pendingApprovalForTool(tool)" class="tool-approval-meta">
          <div>
            <dt>{{ t('chat.approvalRequired') }}</dt>
            <dd>{{ pendingApprovalForTool(tool)?.kind }}</dd>
          </div>
          <div>
            <dt>{{ t('chat.expires') }}</dt>
            <dd>{{ pendingApprovalForTool(tool)?.expiresAt }}</dd>
          </div>
        </dl>
        <p
          v-if="pendingApprovalForTool(tool)?.reason"
          class="tool-approval-note"
        >
          {{ pendingApprovalForTool(tool)?.reason }}
        </p>
        <ul
          v-if="pendingApprovalForTool(tool)?.signals.length"
          class="policy-signals compact"
        >
          <li
            v-for="signal in pendingApprovalForTool(tool)?.signals"
            :key="signal.code + signal.detail"
          >
            <UiIcon name="warning" />{{ signal.detail }}
          </li>
        </ul>
        <pre
          v-if="pendingApprovalForTool(tool)?.diff"
          class="tool-approval-json"
          >{{ pendingApprovalForTool(tool)?.diff }}</pre
        >
        <dl v-if="reviewedApprovalForTool(tool)" class="tool-approval-meta">
          <div>
            <dt>{{ t('chat.approvalDecision') }}</dt>
            <dd>{{ reviewedApprovalForTool(tool)?.decision }}</dd>
          </div>
          <div v-if="reviewedApprovalForTool(tool)?.diffHash">
            <dt>{{ t('chat.diffHash') }}</dt>
            <dd>{{ reviewedApprovalForTool(tool)?.diffHash }}</dd>
          </div>
        </dl>
        <p
          v-if="reviewedApprovalForTool(tool)?.reason"
          class="tool-approval-note"
        >
          {{ reviewedApprovalForTool(tool)?.reason }}
        </p>
        <pre
          v-if="reviewedApprovalForTool(tool)?.diff"
          class="tool-approval-json"
          >{{ reviewedApprovalForTool(tool)?.diff }}</pre
        >
        <div v-if="approvalUsageForTool(tool)" class="tool-approval-usage">
          <span>{{ t('chat.approvalUsage') }}</span>
          <p>{{ approvalUsageSummaryForTool(tool) }}</p>
          <pre
            v-if="approvalUsageForTool(tool)?.usage.raw"
            class="tool-approval-json"
            >{{ stringifyJson(approvalUsageForTool(tool)?.usage.raw) }}</pre
          >
        </div>
      </div>
    </div>
  </article>
</template>
