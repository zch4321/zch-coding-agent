<script setup lang="ts">
import { NCollapse, NCollapseItem, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { RunId } from '../../../shared/ids'
import type { ChatMessage } from '../../stores/agent-types'
import MarkdownBlock from '../MarkdownBlock.vue'
import UiIcon from '../UiIcon.vue'

const props = defineProps<{
  message: ChatMessage
  activeRunId?: RunId
  actionsDisabled: boolean
}>()
const emit = defineEmits<{
  revert: [messageId: string, text: string]
  fork: [messageId: string]
}>()
const { t } = useI18n()

function roleLabel(): string {
  if (props.message.role === 'user') return t('chat.you')
  if (props.message.role === 'orchestrator') return t('chat.orchestrator')
  if (props.message.role === 'interjection') return t('chat.interjection')
  return t('chat.agent')
}
</script>

<template>
  <article class="chat-message" :class="message.role">
    <div class="message-meta">
      <strong>{{ roleLabel() }}</strong>
      <span
        v-if="message.role === 'assistant' && message.runId === activeRunId"
      >
        {{ t('chat.streaming') }}
      </span>
      <span
        v-else-if="
          message.role === 'interjection' &&
          message.interjectionStatus === 'queued'
        "
        class="interjection-status"
      >
        {{ t('chat.interjectionQueued') }}
      </span>
      <span
        v-else-if="
          message.role === 'interjection' &&
          message.interjectionStatus === 'injected'
        "
        class="interjection-status"
      >
        {{ t('chat.interjectionInjected') }}
      </span>
      <span
        v-else-if="
          message.role === 'interjection' &&
          message.interjectionStatus === 'superseded'
        "
        class="interjection-status superseded"
      >
        {{ t('chat.interjectionSuperseded') }}
      </span>
      <span
        v-else-if="
          message.role === 'interjection' &&
          message.interjectionStatus === 'carryover'
        "
        class="interjection-status carryover"
      >
        {{ t('chat.interjectionCarryover') }}
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
      v-if="message.role === 'assistant' && message.text && !actionsDisabled"
      class="message-actions"
    >
      <NTooltip>
        <template #trigger>
          <button
            type="button"
            class="message-action"
            :aria-label="t('chat.revertToHere')"
            @click="emit('revert', message.id, message.text)"
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
            @click="emit('fork', message.id)"
          >
            <UiIcon name="git-branch" />
          </button>
        </template>
        {{ t('chat.forkFromHereTitle') }}
      </NTooltip>
    </div>
  </article>
</template>
