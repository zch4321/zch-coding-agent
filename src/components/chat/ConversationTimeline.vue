<script setup lang="ts">
import { computed, nextTick, onMounted, provide, ref, watch } from 'vue'
import { NButton, NEmpty, NScrollbar, type ScrollbarInst } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useScrollFollow } from '../../composables/use-scroll-follow'
import { conversationResumeKey } from './scroll-follow-context'
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
  continue: []
}>()
const scrollbar = ref<ScrollbarInst>()
const timelineContent = ref<HTMLElement>()
const resumeVersion = ref(0)
provide(conversationResumeKey, resumeVersion)
const follow = useScrollFollow({
  content: () => timelineContent.value,
  scroll: () => scrollbar.value?.scrollTo({ top: Number.MAX_SAFE_INTEGER }),
})
const followingOutput = follow.following
const loadingOlderMessages = ref(false)
const timelineTurns = computed(() =>
  agent.timelineTurns.filter(
    (turn) =>
      turn.sourceTurnId === agent.manualContinuationTarget?.rootUserMessageId ||
      turn.userMessage ||
      turn.tools.length > 0 ||
      turn.reasoningSegments.length > 0 ||
      turn.messages.length > 0 ||
      turn.runActivity,
  ),
)
const continuationTurnId = computed(() => {
  const rootUserMessageId = agent.manualContinuationTarget?.rootUserMessageId
  if (!rootUserMessageId) return undefined
  for (let index = timelineTurns.value.length - 1; index >= 0; index -= 1) {
    const turn = timelineTurns.value[index]
    if (turn?.sourceTurnId === rootUserMessageId) return turn.id
  }
  return undefined
})

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

function onContentResized(): void {
  follow.schedule()
}

function resumeOutput(): void {
  resumeVersion.value += 1
  follow.resume()
}

async function loadOlderMessages() {
  const content = timelineContent.value
  if (!content || loadingOlderMessages.value) return
  const previousHeight = content.scrollHeight
  const previousTop = follow.element.value?.scrollTop ?? 0
  const sessionId = agent.activeConversationId
  loadingOlderMessages.value = true
  follow.pause()
  try {
    if (!(await agent.loadOlderMessages())) return
    await nextTick()
    if (sessionId !== agent.activeConversationId) return
    const top = previousTop + Math.max(0, content.scrollHeight - previousHeight)
    scrollbar.value?.scrollTo({ top })
    follow.pause(top)
  } finally {
    loadingOlderMessages.value = false
  }
}

watch(() => agent.activeConversationId, resumeOutput)
onMounted(resumeOutput)
</script>

<template>
  <section
    class="conversation-timeline"
    @wheel.capture.passive="follow.onWheel"
    @keydown.capture="follow.onKeydown"
    @touchstart.capture.passive="follow.onTouchstart"
    @touchmove.capture.passive="follow.onTouchmove"
  >
    <NScrollbar
      ref="scrollbar"
      class="conversation-scroll"
      :aria-label="t('chat.messages')"
      @scroll="follow.onScroll"
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
            :continuable="turn.id === continuationTurnId"
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
            @continue="emit('continue')"
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
          @click="resumeOutput"
        >
          <UiIcon name="chevron-down" />
        </NButton>
        <span class="conversation-bottom-sentinel" aria-hidden="true"></span>
      </div>
    </NScrollbar>
  </section>
</template>
