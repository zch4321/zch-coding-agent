<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ToolActivity } from '../../stores/agent'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'
import ApprovalCard from './ApprovalCard.vue'
import ChatMessageItem from './ChatMessageItem.vue'
import GoalPanel from './GoalPanel.vue'
import ToolCallCard from './ToolCallCard.vue'

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

      <GoalPanel v-if="agent.goal" :style="{ order: 0 }" />

      <ChatMessageItem
        v-for="message in visibleMessages"
        :key="message.id"
        :message="message"
        :active-run-id="agent.activeRunId"
        :actions-disabled="Boolean(agent.activeRunId || agent.pendingApproval)"
        :style="{ order: message.order ?? 0 }"
        @revert="requestRevert"
        @fork="requestFork"
      />

      <ToolCallCard
        v-for="tool in chronologicalTools"
        :key="tool.callId"
        :tool="tool"
        :expanded="isToolDetailsExpanded(tool)"
        :style="{ order: tool.order ?? 0 }"
        @toggle="toggleToolDetails(tool)"
      />

      <ApprovalCard v-if="agent.pendingApproval" :project-name="projectName" />

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
