<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NCollapse, NCollapseItem, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ToolActivity } from '../../stores/agent'
import { useAgentStore } from '../../stores/agent'
import MarkdownBlock from '../MarkdownBlock.vue'
import UiIcon from '../UiIcon.vue'

defineProps<{ projectName: string }>()

type CollapseHeaderClickInfo = {
  name: string | number
  expanded: boolean
}

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
const expandedToolDetails = ref<string[]>([])
let resizeObserver: ResizeObserver | undefined

function requestRevert(messageId: string, text: string) {
  const preview = text.replace(/\s+/g, ' ').slice(0, 80)
  emit('revert', messageId, preview)
}

function requestFork(messageId: string) {
  emit('fork', messageId)
}

function okContent(tool: ToolActivity): unknown {
  const result = tool.result

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined
  }

  return 'status' in result && result.status === 'ok' && 'content' in result
    ? result.content
    : undefined
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

function toolDetailsTitle(tool: ToolActivity): string {
  return okContent(tool) ? t('chat.result') : t('chat.arguments')
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

function updateToolDetailsFromHeader(
  tool: ToolActivity,
  info: CollapseHeaderClickInfo,
) {
  if (String(info.name) !== toolDetailsName(tool)) return
  setToolDetailsExpanded(tool, info.expanded)
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
      return `${tool.callId}:${tool.status}:${resultStatus}:${resultSize}`
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
    agent.messages.length,
    agent.messages.at(-1)?.text.length ?? 0,
    agent.messages.at(-1)?.reasoning.length ?? 0,
    agent.tools.length,
    toolRenderSignature.value,
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
        v-for="message in agent.messages"
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
        <MarkdownBlock :content="message.text || '...'" />
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
        <div class="tool-call-header">
          <div>
            <span class="tool-kicker">{{ t('chat.toolCall') }}</span>
            <strong>{{ tool.tool }}</strong>
          </div>
          <span
            class="tool-status"
            :class="tool.status === 'completed' ? 'complete' : ''"
          >
            {{ toolResultSummary(tool) }}
          </span>
        </div>
        <NTooltip v-if="tool.reason">
          <template #trigger>
            <p class="tool-reason">{{ tool.reason }}</p>
          </template>
          {{ tool.reason }}
        </NTooltip>
        <NCollapse
          :expanded-names="
            isToolDetailsExpanded(tool) ? [toolDetailsName(tool)] : []
          "
          @item-header-click="(info) => updateToolDetailsFromHeader(tool, info)"
        >
          <NCollapseItem
            :title="toolDetailsTitle(tool)"
            :name="toolDetailsName(tool)"
          >
            <template v-if="isToolDetailsExpanded(tool)">
              <div class="tool-detail-block">
                <strong>{{ t('chat.arguments') }}</strong>
                <pre class="tool-args-json">{{
                  JSON.stringify(tool.args, null, 2)
                }}</pre>
              </div>
              <div v-if="okContent(tool)" class="tool-detail-block">
                <strong>{{ t('chat.result') }}</strong>
                <pre class="tool-result-json">{{
                  JSON.stringify(tool.result, null, 2)
                }}</pre>
              </div>
            </template>
          </NCollapseItem>
        </NCollapse>
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
          agent.messages.length === 0 &&
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
