<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCollapse, NCollapseItem, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
  PendingApproval,
  ReviewedApproval,
  ToolActivity,
} from '../../stores/agent'
import type { UsageActivity } from '../../stores/agent-types'
import { useAgentStore } from '../../stores/agent'
import MarkdownBlock from '../MarkdownBlock.vue'
import UiIcon from '../UiIcon.vue'

defineProps<{ projectName: string }>()

const agent = useAgentStore()
const { t } = useI18n()
const emit = defineEmits<{
  revert: [messageId: string, preview: string]
  fork: [messageId: string]
}>()
const scrollElement = ref<HTMLElement>()
const bottomSentinel = ref<HTMLElement>()
const followingOutput = ref(true)
const chronologicalTools = computed(() => [...agent.tools].reverse())
const visibleMessages = computed(() =>
  agent.messages.filter(
    (message) =>
      message.role !== 'assistant' ||
      message.text.trim().length > 0 ||
      message.reasoning.trim().length > 0,
  ),
)
const expandedToolDetails = ref<string[]>([])
let resizeObserver: ResizeObserver | undefined

function requestRevert(messageId: string, text: string) {
  const preview = text.replace(/\s+/g, ' ').slice(0, 80)
  emit('revert', messageId, preview)
}

function requestFork(messageId: string) {
  emit('fork', messageId)
}

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

function isToolDetailsExpanded(tool: ToolActivity): boolean {
  return expandedToolDetails.value.includes(toolDetailsName(tool))
}

function setToolDetailsExpanded(tool: ToolActivity, expanded: boolean) {
  const name = toolDetailsName(tool)
  const next = new Set(expandedToolDetails.value)

  if (expanded) {
    next.add(name)
  } else {
    next.delete(name)
  }

  expandedToolDetails.value = [...next]
  onContentResized()
}

function toggleToolDetails(tool: ToolActivity) {
  setToolDetailsExpanded(tool, !isToolDetailsExpanded(tool))
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

const toolRenderSignature = computed(() =>
  agent.tools
    .map((tool) => {
      const result =
        tool.result &&
        typeof tool.result === 'object' &&
        !Array.isArray(tool.result)
          ? tool.result
          : undefined
      const resultStatus =
        result && 'status' in result ? String(result.status) : 'pending'
      const resultSize = result ? JSON.stringify(result).length : 0
      const approval = tool.approval
        ? `${tool.approval.decision}:${tool.approval.reason}`
        : ''
      return `${tool.callId}:${tool.status}:${resultStatus}:${resultSize}:${approval}`
    })
    .join('|'),
)

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48
}

function handleScroll() {
  const element = scrollElement.value
  if (!element) return
  followingOutput.value = isNearBottom(element)
}

function onContentResized() {
  const element = scrollElement.value
  if (!element || !followingOutput.value) return
  void scrollToBottom()
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve())
    } else {
      window.setTimeout(resolve, 0)
    }
  })
}

async function scrollToBottom(force = false) {
  if (!followingOutput.value && !force) return
  await nextTick()
  await animationFrame()
  const element = scrollElement.value

  if (
    bottomSentinel.value &&
    typeof bottomSentinel.value.scrollIntoView === 'function'
  ) {
    bottomSentinel.value.scrollIntoView({ block: 'end' })
  } else if (element) {
    element.scrollTop = element.scrollHeight
  }

  await nextTick()

  if (element) {
    element.scrollTop = element.scrollHeight
  }

  followingOutput.value = true
}

watch(
  () => [
    visibleMessages.value.length,
    visibleMessages.value.at(-1)?.text.length ?? 0,
    visibleMessages.value.at(-1)?.reasoning.length ?? 0,
    agent.tools.length,
    toolRenderSignature.value,
    agent.usage.length,
    agent.pendingApproval?.callId,
  ],
  () => void scrollToBottom(),
)

watch(
  () => agent.activeConversationId,
  () => {
    followingOutput.value = true
    expandedToolDetails.value = []
    void scrollToBottom(true)
  },
)

onMounted(() => {
  const element = scrollElement.value

  if (element && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(onContentResized)
    resizeObserver.observe(element)
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = undefined
})
</script>

<template>
  <section class="conversation-timeline">
    <div
      ref="scrollElement"
      class="conversation-scroll"
      :aria-label="t('chat.messages')"
      @scroll.passive="handleScroll"
    >
      <NAlert
        v-if="!agent.bridgeAvailable && agent.initialized"
        type="warning"
        :title="t('chat.bridgeUnavailable')"
        class="inline-alert"
      >
        {{ t('chat.bridgeHint') }}
      </NAlert>
      <NAlert
        v-if="agent.bridgeAvailable && !agent.providerNoticeAccepted"
        type="info"
        :title="t('chat.providerNotice')"
        class="inline-alert"
      >
        {{ t('chat.providerNoticeText') }}
        <div class="notice-action">
          <NButton
            size="small"
            type="primary"
            @click="agent.acceptProviderNotice"
          >
            {{ t('chat.understand') }}
          </NButton>
        </div>
      </NAlert>
      <NAlert
        v-if="agent.agentEventGap"
        type="warning"
        :title="t('chat.eventGap')"
        class="inline-alert"
        closable
        @close="agent.agentEventGap = ''"
      >
        {{ agent.agentEventGap }}
      </NAlert>
      <section
        v-if="agent.goal || agent.plan"
        class="orchestration-panel"
        :style="{ order: 0 }"
      >
        <article v-if="agent.goal" class="orchestration-card">
          <div class="orchestration-card-header">
            <span>{{ t('chat.goal') }}</span>
            <strong>{{ agent.goal.status }}</strong>
          </div>
          <p>{{ agent.goal.objective }}</p>
          <small v-if="agent.goal.summary">{{ agent.goal.summary }}</small>
          <small v-else-if="agent.goal.blockReason">
            {{ agent.goal.blockReason }}
          </small>
        </article>
        <article v-if="agent.plan" class="orchestration-card">
          <div class="orchestration-card-header">
            <span>{{ t('chat.plan') }}</span>
            <strong>{{ agent.plan.items.length }}</strong>
          </div>
          <p>{{ agent.plan.objective }}</p>
          <ol v-if="agent.plan.items.length" class="plan-item-list">
            <li v-for="item in agent.plan.items" :key="item.id">
              <span>{{ item.title }}</span>
              <em>{{ item.status }}</em>
            </li>
          </ol>
          <small v-if="agent.plan.warning">{{ agent.plan.warning }}</small>
        </article>
      </section>

      <article
        v-for="message in visibleMessages"
        :key="message.id"
        class="chat-message"
        :class="message.role"
        :style="{ order: message.order ?? 0 }"
      >
        <div class="message-meta">
          <strong>{{
            message.role === 'user'
              ? t('chat.you')
              : message.role === 'orchestrator'
                ? t('chat.orchestrator')
                : t('chat.agent')
          }}</strong>
          <span
            v-if="
              message.role === 'assistant' &&
              message.runId === agent.activeRunId
            "
          >
            {{ t('chat.streaming') }}
          </span>
        </div>
        <div v-if="message.attachments?.length" class="message-attachments">
          <NTooltip
            v-for="attachment in message.attachments"
            :key="attachment.kind + ':' + attachment.path"
          >
            <template #trigger>
              <span class="context-chip">
                <UiIcon
                  :name="attachment.kind === 'directory' ? 'folder' : 'file'"
                />
                <span>{{ attachment.path }}</span>
                <small>{{ attachment.source }}</small>
              </span>
            </template>
            {{ attachment.path }}
          </NTooltip>
        </div>
        <MarkdownBlock v-if="message.text.trim()" :content="message.text" />
        <NCollapse v-if="message.reasoning" class="reasoning">
          <NCollapseItem :title="t('chat.reasoning')" name="reasoning">
            <pre>{{ message.reasoning }}</pre>
          </NCollapseItem>
        </NCollapse>
        <div
          v-if="
            message.role === 'assistant' &&
            message.text &&
            !agent.activeRunId &&
            !agent.pendingApproval
          "
          class="message-actions"
        >
          <NTooltip>
            <template #trigger>
              <button
                type="button"
                class="message-action"
                :aria-label="t('chat.revertToHere')"
                @click="requestRevert(message.id, message.text)"
              >
                <UiIcon name="undo" />
              </button>
            </template>
            {{ t('chat.revertToHereTitle') }}
          </NTooltip>
          <NTooltip>
            <template #trigger>
              <button
                type="button"
                class="message-action"
                :aria-label="t('chat.forkFromHere')"
                @click="requestFork(message.id)"
              >
                <UiIcon name="git-branch" />
              </button>
            </template>
            {{ t('chat.forkFromHereTitle') }}
          </NTooltip>
        </div>
      </article>

      <article
        v-for="tool in chronologicalTools"
        :key="tool.callId"
        class="tool-call-card"
        :style="{ order: tool.order ?? 0 }"
      >
        <button
          type="button"
          class="tool-call-row"
          :title="tool.reason || tool.tool"
          :aria-controls="toolDetailsName(tool)"
          :aria-expanded="isToolDetailsExpanded(tool)"
          @click="toggleToolDetails(tool)"
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
            <UiIcon
              :name="
                isToolDetailsExpanded(tool) ? 'chevron-down' : 'chevron-right'
              "
            />
          </span>
        </button>
        <div
          v-if="isToolDetailsExpanded(tool)"
          :id="toolDetailsName(tool)"
          class="tool-call-details"
        >
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

      <article
        v-if="agent.pendingApproval"
        class="approval-card"
        :style="{ order: agent.pendingApproval.order }"
      >
        <div class="approval-header">
          <div>
            <span class="tool-kicker">{{ t('chat.approvalRequired') }}</span>
            <strong>{{ agent.pendingApproval.tool }}</strong>
          </div>
          <span>{{ agent.pendingApproval.kind }}</span>
        </div>
        <p>{{ agent.pendingApproval.reason }}</p>
        <dl class="approval-meta">
          <div>
            <dt>{{ t('chat.workspaceScope') }}</dt>
            <dd>{{ projectName }}</dd>
          </div>
          <div>
            <dt>{{ t('chat.expires') }}</dt>
            <dd>{{ agent.pendingApproval.expiresAt }}</dd>
          </div>
        </dl>
        <pre class="approval-args">{{
          JSON.stringify(agent.pendingApproval.args, null, 2)
        }}</pre>
        <ul class="policy-signals">
          <li
            v-for="signal in agent.pendingApproval.signals"
            :key="signal.code + signal.detail"
          >
            <UiIcon name="warning" />{{ signal.detail }}
          </li>
        </ul>
        <pre v-if="agent.pendingApproval.diff" class="approval-diff">{{
          agent.pendingApproval.diff
        }}</pre>
        <div
          v-if="agent.pendingApproval.rememberArgConstraints"
          class="approval-remember-preview"
        >
          <strong>{{ t('chat.rememberedScope') }}</strong>
          <pre>{{
            JSON.stringify(
              agent.pendingApproval.rememberArgConstraints,
              null,
              2,
            )
          }}</pre>
        </div>
        <div class="approval-actions">
          <NButton
            type="primary"
            :loading="agent.approvalSubmitting"
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('allow')"
          >
            {{
              agent.pendingApproval.kind === 'context'
                ? t('chat.allowContext')
                : t('common.approve')
            }}
          </NButton>
          <NButton
            v-if="agent.pendingApproval.rememberable"
            secondary
            type="primary"
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('allow', true)"
          >
            {{ t('chat.approveRemember') }}
          </NButton>
          <NButton
            secondary
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('deny')"
          >
            {{
              agent.pendingApproval.kind === 'context'
                ? t('chat.withholdContext')
                : t('common.deny')
            }}
          </NButton>
        </div>
      </article>

      <div
        v-if="
          visibleMessages.length === 0 &&
          chronologicalTools.length === 0 &&
          !agent.pendingApproval
        "
        class="conversation-empty"
      >
        <span class="empty-icon"><UiIcon name="app" /></span>
        <template v-if="!agent.workspacePath">
          <h2>{{ t('chat.openWorkspace') }}</h2>
          <p>{{ t('chat.openWorkspaceHint') }}</p>
          <NButton type="primary" @click="agent.chooseWorkspace">
            {{ t('app.chooseWorkspace') }}
          </NButton>
        </template>
        <template v-else>
          <h2>{{ t('chat.workQuestion') }}</h2>
          <p>{{ t('chat.workHint') }}</p>
        </template>
      </div>

      <button
        v-if="!followingOutput"
        class="back-to-bottom"
        type="button"
        @click="scrollToBottom(true)"
      >
        {{ t('chat.backBottom') }}
      </button>
      <span
        ref="bottomSentinel"
        class="conversation-bottom-sentinel"
        aria-hidden="true"
      ></span>
    </div>
    <NAlert
      v-if="agent.error"
      type="error"
      :title="t('chat.requestFailed')"
      class="conversation-error-overlay"
      closable
      @close="agent.error = ''"
    >
      {{ agent.error }}
    </NAlert>
  </section>
</template>
