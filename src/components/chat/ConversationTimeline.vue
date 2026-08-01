<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'
import ApprovalCard from './ApprovalCard.vue'
import ConversationTurn from './ConversationTurn.vue'
import GoalPanel from './GoalPanel.vue'

defineProps<{ projectName: string }>()

const agent = useAgentStore()
const { t } = useI18n()
const emit = defineEmits<{
  revert: [messageId: string, preview: string]
  fork: [messageId: string]
  retry: [messageId: string, preview: string]
  edit: [messageId: string, preview: string]
}>()
const scrollElement = ref<HTMLElement>()
const bottomSentinel = ref<HTMLElement>()
const followingOutput = ref(true)
const loadingOlderMessages = ref(false)
const timelineTurns = computed(() => agent.timelineTurns)
let resizeObserver: ResizeObserver | undefined

function requestRevert(messageId: string, text: string) {
  const preview = text.replace(/\s+/g, ' ').slice(0, 80)
  emit('revert', messageId, preview)
}

function requestFork(messageId: string) {
  emit('fork', messageId)
}

function requestRetry(messageId: string, text: string) {
  emit('retry', messageId, text.replace(/\s+/g, ' ').slice(0, 80))
}

function requestEdit(messageId: string, text: string) {
  emit('edit', messageId, text.replace(/\s+/g, ' ').slice(0, 80))
}

const timelineRenderSignature = computed(() =>
  timelineTurns.value
    .map((turn) => {
      const tools = turn.tools
        .map((tool) => {
          const resultSize = tool.result
            ? JSON.stringify(tool.result).length
            : 0
          return `${tool.callId}:${tool.status}:${resultSize}`
        })
        .join(',')
      const reasoning = turn.reasoningSegments
        .map((segment) => `${segment.id}:${segment.text.length}`)
        .join(',')
      const messages = turn.messages
        .map((message) => `${message.id}:${message.text.length}`)
        .join(',')
      return `${turn.id}|${tools}|${reasoning}|${messages}`
    })
    .join(';'),
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

async function loadOlderMessages() {
  const element = scrollElement.value
  if (!element || loadingOlderMessages.value) return
  const previousHeight = element.scrollHeight
  const previousTop = element.scrollTop
  loadingOlderMessages.value = true
  followingOutput.value = false
  try {
    if (!(await agent.loadOlderMessages())) return
    await nextTick()
    await animationFrame()
    element.scrollTop =
      previousTop + Math.max(0, element.scrollHeight - previousHeight)
  } finally {
    loadingOlderMessages.value = false
  }
}

watch(
  () => [timelineRenderSignature.value, agent.pendingApproval?.callId],
  () => void scrollToBottom(),
)

watch(
  () => agent.activeConversationId,
  () => {
    followingOutput.value = true
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
      <NButton
        v-if="agent.selectedMessageHasMore"
        class="load-earlier"
        size="small"
        secondary
        :loading="loadingOlderMessages"
        @click="loadOlderMessages"
      >
        {{ t('chat.loadEarlierMessages') }}
      </NButton>

      <GoalPanel v-if="agent.goal" />

      <div class="conversation-turn-list">
        <ConversationTurn
          v-for="turn in timelineTurns"
          :key="turn.id"
          :turn="turn"
          :active-run-id="agent.activeRunId"
          :actions-disabled="
            Boolean(
              agent.startPending || agent.activeRunId || agent.pendingApproval,
            )
          "
          @revert="requestRevert"
          @fork="requestFork"
          @retry="requestRetry"
          @edit="requestEdit"
          @content-resized="onContentResized"
        />
      </div>

      <ApprovalCard
        v-if="agent.pendingApproval"
        :key="agent.pendingApproval.callId"
        :project-name="projectName"
      />

      <NEmpty
        v-if="timelineTurns.length === 0 && !agent.pendingApproval"
        class="conversation-empty"
        :description="
          agent.workspacePath ? t('chat.workQuestion') : t('chat.openWorkspace')
        "
      >
        <template #icon><UiIcon name="app" /></template>
        <template #extra>
          <div class="conversation-empty-extra">
            <p>
              {{
                agent.workspacePath
                  ? t('chat.workHint')
                  : t('chat.openWorkspaceHint')
              }}
            </p>
            <NButton
              v-if="!agent.workspacePath"
              type="primary"
              @click="agent.chooseWorkspace"
            >
              {{ t('app.chooseWorkspace') }}
            </NButton>
          </div>
        </template>
      </NEmpty>

      <NButton
        v-if="!followingOutput"
        class="back-to-bottom"
        circle
        secondary
        :aria-label="t('chat.backBottom')"
        @click="scrollToBottom(true)"
      >
        <UiIcon name="chevron-down" />
      </NButton>
      <span
        ref="bottomSentinel"
        class="conversation-bottom-sentinel"
        aria-hidden="true"
      ></span>
    </div>
  </section>
</template>
