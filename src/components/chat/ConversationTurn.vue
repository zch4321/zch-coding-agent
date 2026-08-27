<script setup lang="ts">
import { NButton, NTooltip } from 'naive-ui'
import { computed } from 'vue'
import type { ConversationTurn } from '../../stores/agent-types'
import UiIcon from '../UiIcon.vue'
import ChatMessageItem from './ChatMessageItem.vue'
import ReasoningGroup from './ReasoningGroup.vue'
import ToolCallGroup from './ToolCallGroup.vue'

const props = defineProps<{
  turn: ConversationTurn
  actionsDisabled: boolean
  continuable?: boolean
}>()
const emit = defineEmits<{
  revert: [messageId: string, text: string]
  fork: [messageId: string]
  retry: [messageId: string, text: string]
  edit: [messageId: string, text: string]
  continue: []
  'content-resized': []
}>()

const continuationActionMessageId = computed(() => {
  if (!props.continuable) return undefined
  const latestActionable = [...props.turn.messages]
    .reverse()
    .find(
      (message) =>
        message.text &&
        (message.role !== 'assistant' ||
          message.id === props.turn.finalAssistantMessageId),
    )
  return latestActionable?.id ?? props.turn.userMessage?.id
})
</script>

<template>
  <section class="conversation-turn" :data-turn-id="turn.id">
    <ChatMessageItem
      v-if="turn.userMessage"
      :message="turn.userMessage"
      :actions-disabled="actionsDisabled"
      :continuable="turn.userMessage.id === continuationActionMessageId"
      @revert="emit('revert', $event, turn.userMessage!.text)"
      @fork="emit('fork', $event)"
      @retry="emit('retry', $event, turn.userMessage!.text)"
      @edit="emit('edit', $event, turn.userMessage!.text)"
      @continue="emit('continue')"
    />

    <ReasoningGroup
      v-if="turn.reasoningSegments.length || turn.runActivity"
      :segments="turn.reasoningSegments"
      :activity="turn.runActivity"
      :provider-retry="turn.providerRetry"
      @content-resized="emit('content-resized')"
    />

    <ToolCallGroup
      v-if="turn.tools.length"
      :tools="turn.tools"
      @content-resized="emit('content-resized')"
    />

    <div
      v-if="continuable && !continuationActionMessageId && !actionsDisabled"
      class="message-actions"
    >
      <NTooltip>
        <template #trigger>
          <NButton
            class="message-action"
            quaternary
            circle
            size="small"
            :aria-label="$t('chat.continueConversation')"
            @click="emit('continue')"
          >
            <template #icon><UiIcon name="chevron-right" /></template>
          </NButton>
        </template>
        {{ $t('chat.continueConversationTitle') }}
      </NTooltip>
    </div>

    <ChatMessageItem
      v-for="message in turn.messages"
      :key="message.id"
      :message="message"
      :actions-disabled="actionsDisabled"
      :continuable="message.id === continuationActionMessageId"
      :show-actions="
        message.role !== 'assistant' ||
        message.id === turn.finalAssistantMessageId
      "
      @revert="emit('revert', $event, message.text)"
      @fork="emit('fork', $event)"
      @retry="emit('retry', $event, message.text)"
      @edit="emit('edit', $event, message.text)"
      @continue="emit('continue')"
    />
  </section>
</template>
