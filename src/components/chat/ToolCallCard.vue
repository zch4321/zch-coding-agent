<script setup lang="ts">
import {
  NCollapse,
  NCollapseItem,
  NDescriptions,
  NDescriptionsItem,
  NTag,
} from 'naive-ui'
import { computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolActivity, UsageActivity } from '../../stores/agent-types'
import { useAgentRuntimeStore } from '../../stores/agent-runtime'
import UiIcon from '../UiIcon.vue'
import {
  formatToolResultDisplay,
  toolResultDisplayContent,
} from './tool-result-display'

const props = defineProps<{ tool: ToolActivity }>()
const emit = defineEmits<{ 'content-resized': [] }>()

const agent = useAgentRuntimeStore()
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

const argumentsText = computed(() => stringifyJson(props.tool.args))
const resultText = computed(() =>
  formatToolResultDisplay(toolResultDisplayContent(props.tool.result)),
)
const pendingApproval = computed(() =>
  agent.pendingApproval?.callId === props.tool.callId
    ? agent.pendingApproval
    : undefined,
)
const reviewedApproval = computed(() =>
  agent.latestReviewedApproval?.callId === props.tool.callId
    ? agent.latestReviewedApproval
    : undefined,
)
const approvalUsage = computed(() =>
  agent.approvalUsageByCallId.get(props.tool.callId),
)
const approvalRaw = computed(() =>
  stringifyJson(approvalUsage.value?.usage.raw),
)
const hasApprovalDetails = computed(() =>
  Boolean(
    props.tool.approval ||
    pendingApproval.value ||
    reviewedApproval.value ||
    approvalUsage.value,
  ),
)

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

const approvalSummary = computed(() =>
  approvalUsage.value ? approvalUsageSummary(approvalUsage.value) : '',
)

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
            <pre class="tool-args-json">{{ argumentsText }}</pre>
          </div>
          <div v-if="tool.result !== undefined" class="tool-detail-block">
            <strong>{{ t('chat.result') }}</strong>
            <pre class="tool-result-json">{{ resultText }}</pre>
          </div>
          <div v-if="hasApprovalDetails" class="tool-detail-block">
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
              v-if="pendingApproval"
              class="tool-approval-meta"
              label-placement="left"
              :column="2"
              size="small"
            >
              <NDescriptionsItem :label="t('chat.approvalRequired')">
                {{ pendingApproval?.kind }}
              </NDescriptionsItem>
              <NDescriptionsItem :label="t('chat.expires')">
                {{ pendingApproval?.expiresAt }}
              </NDescriptionsItem>
            </NDescriptions>
            <p v-if="pendingApproval?.reason" class="tool-approval-note">
              {{ pendingApproval?.reason }}
            </p>
            <ul
              v-if="pendingApproval?.signals.length"
              class="policy-signals compact"
            >
              <li
                v-for="signal in pendingApproval?.signals"
                :key="signal.code + signal.detail"
              >
                <UiIcon name="warning" />{{ signal.detail }}
              </li>
            </ul>
            <NDescriptions
              v-if="reviewedApproval"
              class="tool-approval-meta"
              label-placement="left"
              :column="2"
              size="small"
            >
              <NDescriptionsItem :label="t('chat.approvalDecision')">
                {{ reviewedApproval?.decision }}
              </NDescriptionsItem>
            </NDescriptions>
            <p v-if="reviewedApproval?.reason" class="tool-approval-note">
              {{ reviewedApproval?.reason }}
            </p>
            <div v-if="approvalUsage" class="tool-approval-usage">
              <span>{{ t('chat.approvalUsage') }}</span>
              <p>{{ approvalSummary }}</p>
              <pre v-if="approvalUsage?.usage.raw" class="tool-approval-json">{{
                approvalRaw
              }}</pre>
            </div>
          </div>
        </div>
      </NCollapseItem>
    </NCollapse>
  </article>
</template>
