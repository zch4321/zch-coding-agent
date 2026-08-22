<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NScrollbar, type ScrollbarInst } from 'naive-ui'
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
const scrollbar = ref<ScrollbarInst>()
const scrollElement = ref<HTMLElement>()
const timelineContent = ref<HTMLElement>()
const bottomSentinel = ref<HTMLElement>()
const followingOutput = ref(true)
const loadingOlderMessages = ref(false)
const timelineTurns = computed(() =>
  agent.timelineTurns.filter(
    (turn) =>
      turn.userMessage ||
      turn.tools.length > 0 ||
      turn.reasoningSegments.length > 0 ||
      turn.messages.length > 0 ||
      turn.runActivity,
  ),
)
const hasVisibleTodo = computed(() =>
  Boolean(agent.currentTodo?.items.some((item) => item.status !== 'completed')),
)
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
      return `${turn.id}|${turn.runActivity ?? ''}|${tools}|${reasoning}|${messages}`
    })
    .join(';'),
)

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 48
}

function handleScroll(event: Event) {
  const element = event.target
  if (!(element instanceof HTMLElement)) return
  scrollElement.value = element
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

  if (
    bottomSentinel.value &&
    typeof bottomSentinel.value.scrollIntoView === 'function'
  ) {
    bottomSentinel.value.scrollIntoView({ block: 'end' })
  }

  scrollbar.value?.scrollTo({ top: Number.MAX_SAFE_INTEGER })

  followingOutput.value = true
}

async function loadOlderMessages() {
  const content = timelineContent.value
  if (!content || loadingOlderMessages.value) return
  const previousHeight = content.scrollHeight
  const previousTop = scrollElement.value?.scrollTop ?? 0
  loadingOlderMessages.value = true
  followingOutput.value = false
  try {
    if (!(await agent.loadOlderMessages())) return
    await nextTick()
    await animationFrame()
    scrollbar.value?.scrollTo({
      top: previousTop + Math.max(0, content.scrollHeight - previousHeight),
    })
  } finally {
    loadingOlderMessages.value = false
  }
}

watch(
  () => [
    timelineRenderSignature.value,
    agent.pendingApproval?.callId,
    hasVisibleTodo.value,
  ],
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
  const content = timelineContent.value

  if (content && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(onContentResized)
    resizeObserver.observe(content)
  }
  void scrollToBottom(true)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = undefined
})
</script>

<template>
  <section class="conversation-timeline">
    <NScrollbar
      ref="scrollbar"
      class="conversation-scroll"
      :aria-label="t('chat.messages')"
      @scroll="handleScroll"
    >
      <div ref="timelineContent" class="conversation-scroll-content">
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
            :actions-disabled="
              Boolean(
                agent.startPending ||
                agent.activeRunId ||
                agent.pendingApproval,
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
            agent.workspacePath
              ? t('chat.workQuestion')
              : t('chat.openWorkspace')
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
    </NScrollbar>
  </section>
</template>
