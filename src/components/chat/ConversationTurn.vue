<script setup lang="ts">
import type { ConversationTurn } from '../../stores/agent-types'
import ChatMessageItem from './ChatMessageItem.vue'
import ReasoningGroup from './ReasoningGroup.vue'
import ToolCallGroup from './ToolCallGroup.vue'

defineProps<{
  turn: ConversationTurn
  actionsDisabled: boolean
}>()
const emit = defineEmits<{
  revert: [messageId: string, text: string]
  fork: [messageId: string]
  retry: [messageId: string, text: string]
  edit: [messageId: string, text: string]
  'content-resized': []
}>()
</script>

<template>
  <section class="conversation-turn" :data-turn-id="turn.id">
    <ChatMessageItem
      v-if="turn.userMessage"
      :message="turn.userMessage"
      :actions-disabled="actionsDisabled"
      @revert="emit('revert', $event, turn.userMessage!.text)"
      @fork="emit('fork', $event)"
      @retry="emit('retry', $event, turn.userMessage!.text)"
      @edit="emit('edit', $event, turn.userMessage!.text)"
    />

    <ReasoningGroup
      v-if="turn.reasoningSegments.length || turn.runActivity"
      :segments="turn.reasoningSegments"
      :activity="turn.runActivity"
      @content-resized="emit('content-resized')"
    />

    <ToolCallGroup
      v-if="turn.tools.length"
      :tools="turn.tools"
      @content-resized="emit('content-resized')"
    />

    <ChatMessageItem
      v-for="message in turn.messages"
      :key="message.id"
      :message="message"
      :actions-disabled="actionsDisabled"
      :show-actions="
        message.role !== 'assistant' ||
        message.id === turn.finalAssistantMessageId
      "
      @revert="emit('revert', $event, message.text)"
      @fork="emit('fork', $event)"
      @retry="emit('retry', $event, message.text)"
      @edit="emit('edit', $event, message.text)"
    />
  </section>
</template>
