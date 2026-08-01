<script setup lang="ts">
import { computed } from 'vue'
import type { RunId } from '../../../shared/ids'
import type { ConversationTurn } from '../../stores/agent-types'
import ChatMessageItem from './ChatMessageItem.vue'
import ReasoningGroup from './ReasoningGroup.vue'
import ToolCallGroup from './ToolCallGroup.vue'

const props = defineProps<{
  turn: ConversationTurn
  activeRunId?: RunId
  actionsDisabled: boolean
}>()
const emit = defineEmits<{
  revert: [messageId: string, text: string]
  fork: [messageId: string]
  retry: [messageId: string, text: string]
  edit: [messageId: string, text: string]
  'content-resized': []
}>()

const reasoningStreaming = computed(
  () =>
    props.turn.reasoningSegments.some((segment) => segment.live) &&
    !props.turn.messages.some(
      (message) => message.role === 'assistant' && message.live,
    ),
)
</script>

<template>
  <section class="conversation-turn" :data-turn-id="turn.id">
    <ChatMessageItem
      v-if="turn.userMessage"
      :message="turn.userMessage"
      :active-run-id="activeRunId"
      :actions-disabled="actionsDisabled"
      @revert="emit('revert', $event, turn.userMessage!.text)"
      @fork="emit('fork', $event)"
      @retry="emit('retry', $event, turn.userMessage!.text)"
      @edit="emit('edit', $event, turn.userMessage!.text)"
    />

    <ToolCallGroup
      v-if="turn.tools.length"
      :tools="turn.tools"
      @content-resized="emit('content-resized')"
    />

    <ReasoningGroup
      v-if="turn.reasoningSegments.length"
      :segments="turn.reasoningSegments"
      :streaming="reasoningStreaming"
      @content-resized="emit('content-resized')"
    />

    <ChatMessageItem
      v-for="message in turn.messages"
      :key="message.id"
      :message="message"
      :active-run-id="activeRunId"
      :actions-disabled="actionsDisabled"
      @revert="emit('revert', $event, message.text)"
      @fork="emit('fork', $event)"
      @retry="emit('retry', $event, message.text)"
      @edit="emit('edit', $event, message.text)"
    />
  </section>
</template>
