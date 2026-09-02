<script setup lang="ts">
import {
  NCollapse,
  NCollapseItem,
  NDescriptions,
  NDescriptionsItem,
  NTag,
} from 'naive-ui'
import { nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  PendingApproval,
  ReviewedApproval,
  ToolActivity,
} from '../../stores/agent'
import type { UsageActivity } from '../../stores/agent-types'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'
import {
  formatToolResultDisplay,
  toolResultDisplayContent,
} from './tool-result-display'

defineProps<{ tool: ToolActivity }>()
const emit = defineEmits<{ 'content-resized': [] }>()

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

function notifyContentResized(): void {
  void nextTick(() => emit('content-resized'))
}
</script>

<template>
  <article class="tool-call-card">
    <NCollapse
      arrow-placement="right"
      @update:expanded-names="notifyContentResized"
    >
      <NCollapseItem :name="tool.callId">
        <template #header>
          <div class="tool-call-row" :title="tool.reason || tool.tool">
            <div class="tool-call-summary" :title="tool.reason || tool.tool">
              <span class="tool-call-muted">{{ t('chat.toolCall') }}</span>
              <strong>{{ tool.tool }}</strong>
              <NTag
                round
                size="small"
                :type="tool.status === 'completed' ? 'success' : 'info'"
              >
                {{ toolResultSummary(tool) }}
              </NTag>
            </div>
          </div>
        </template>

        <div class="tool-call-details">
          <div class="tool-detail-block">
            <strong>{{ t('chat.arguments') }}</strong>
            <pre class="tool-args-json">{{ stringifyJson(tool.args) }}</pre>
          </div>
          <div v-if="hasToolResult(tool)" class="tool-detail-block">
            <strong>{{ t('chat.result') }}</strong>
            <pre class="tool-result-json">{{
              formatToolResultDisplay(toolResultDisplayContent(tool.result))
            }}</pre>
          </div>
          <div v-if="hasApprovalDetails(tool)" class="tool-detail-block">
            <strong>{{ t('chat.approvalDetails') }}</strong>
            <NDescriptions
              v-if="tool.approval"
              class="tool-approval-meta"
              label-placement="left"
              :column="2"
              size="small"
            >
              <NDescriptionsItem :label="t('chat.approver')">
                {{ tool.approval.approver }}
              </NDescriptionsItem>
              <NDescriptionsItem :label="t('chat.approvalDecision')">
                {{ tool.approval.decision }}
              </NDescriptionsItem>
              <NDescriptionsItem :label="t('chat.approvalValid')">
                {{ tool.approval.valid ? t('common.yes') : t('common.no') }}
              </NDescriptionsItem>
              <NDescriptionsItem
                v-if="tool.approval.failure"
                :label="t('chat.approvalFailure')"
              >
                {{ tool.approval.failure }}
              </NDescriptionsItem>
            </NDescriptions>
            <p v-if="tool.approval?.reason" class="tool-approval-note">
              {{ tool.approval.reason }}
            </p>
            <NDescriptions
              v-if="pendingApprovalForTool(tool)"
              class="tool-approval-meta"
              label-placement="left"
              :column="2"
              size="small"
            >
              <NDescriptionsItem :label="t('chat.approvalRequired')">
                {{ pendingApprovalForTool(tool)?.kind }}
              </NDescriptionsItem>
              <NDescriptionsItem :label="t('chat.expires')">
                {{ pendingApprovalForTool(tool)?.expiresAt }}
              </NDescriptionsItem>
            </NDescriptions>
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
            <NDescriptions
              v-if="reviewedApprovalForTool(tool)"
              class="tool-approval-meta"
              label-placement="left"
              :column="2"
              size="small"
            >
              <NDescriptionsItem :label="t('chat.approvalDecision')">
                {{ reviewedApprovalForTool(tool)?.decision }}
              </NDescriptionsItem>
            </NDescriptions>
            <p
              v-if="reviewedApprovalForTool(tool)?.reason"
              class="tool-approval-note"
            >
              {{ reviewedApprovalForTool(tool)?.reason }}
            </p>
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
      </NCollapseItem>
    </NCollapse>
  </article>
</template>
