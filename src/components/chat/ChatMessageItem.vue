<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NCollapse, NCollapseItem, NTag, NTooltip } from 'naive-ui'
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
  retry: [messageId: string, text: string]
  edit: [messageId: string, text: string]
}>()
const { t } = useI18n()

function roleLabel(): string {
  if (props.message.role === 'user') return t('chat.you')
  if (props.message.role === 'orchestrator') return t('chat.orchestrator')
  if (props.message.role === 'interjection') return t('chat.interjection')
  return t('chat.agent')
}

const visibleRoleLabel = computed(() => {
  if (
    props.message.role !== 'orchestrator' &&
    props.message.role !== 'interjection'
  ) {
    return undefined
  }
  return roleLabel()
})

const isActiveAssistant = computed(
  () =>
    props.message.role === 'assistant' &&
    props.message.runId === props.activeRunId,
)

const showMetadata = computed(
  () =>
    Boolean(visibleRoleLabel.value) ||
    (isActiveAssistant.value && !props.message.reasoning),
)
</script>

<template>
  <article class="chat-message" :class="message.role" :aria-label="roleLabel()">
    <div v-if="showMetadata" class="message-meta">
      <strong v-if="visibleRoleLabel">{{ visibleRoleLabel }}</strong>
      <NTag
        v-if="isActiveAssistant"
        class="message-status"
        round
        size="small"
        type="info"
      >
        {{ t('chat.streaming') }}
      </NTag>
      <NTag
        v-else-if="
          message.role === 'interjection' &&
          message.interjectionStatus === 'queued'
        "
        class="message-status"
        round
        size="small"
        type="warning"
      >
        {{ t('chat.interjectionQueued') }}
      </NTag>
      <NTag
        v-else-if="
          message.role === 'interjection' &&
          message.interjectionStatus === 'injected'
        "
        class="message-status"
        round
        size="small"
        type="success"
      >
        {{ t('chat.interjectionInjected') }}
      </NTag>
      <NTag
        v-else-if="
          message.role === 'interjection' &&
          message.interjectionStatus === 'superseded'
        "
        class="message-status"
        round
        size="small"
      >
        {{ t('chat.interjectionSuperseded') }}
      </NTag>
      <NTag
        v-else-if="
          message.role === 'interjection' &&
          message.interjectionStatus === 'carryover'
        "
        class="message-status"
        round
        size="small"
        type="info"
      >
        {{ t('chat.interjectionCarryover') }}
      </NTag>
    </div>
    <div v-if="message.attachments?.length" class="message-attachments">
      <NTooltip
        v-for="attachment in message.attachments"
        :key="attachment.kind + ':' + attachment.path"
      >
        <template #trigger>
          <NTag class="context-chip" round size="small">
            <template #icon>
              <UiIcon
                :name="attachment.kind === 'directory' ? 'folder' : 'file'"
              />
            </template>
            <span>{{ attachment.path }}</span>
            <small>{{ attachment.source }}</small>
          </NTag>
        </template>
        {{ attachment.path }}
      </NTooltip>
    </div>
    <MarkdownBlock v-if="message.text.trim()" :content="message.text" />
    <NCollapse
      v-if="message.reasoning"
      class="reasoning-card"
      :class="{ 'reasoning-card-only': !message.text.trim() }"
      arrow-placement="right"
    >
      <NCollapseItem name="reasoning">
        <template #header>
          <div class="tool-call-row">
            <div class="tool-call-summary">
              <span class="tool-call-muted">{{ t('chat.reasoning') }}</span>
              <NTag v-if="isActiveAssistant" round size="small" type="info">
                {{ t('chat.streaming') }}
              </NTag>
            </div>
          </div>
        </template>
        <div class="tool-call-details reasoning-details">
          <pre class="reasoning-content">{{ message.reasoning }}</pre>
        </div>
      </NCollapseItem>
    </NCollapse>
    <div
      v-if="
        message.text && !actionsDisabled && message.durableKind !== 'stream'
      "
      class="message-actions"
    >
      <NTooltip v-if="message.retryable">
        <template #trigger>
          <NButton
            class="message-action"
            quaternary
            circle
            size="small"
            :aria-label="t('chat.retryMessage')"
            @click="emit('retry', message.id, message.text)"
          >
            <template #icon><UiIcon name="restore" /></template>
          </NButton>
        </template>
        {{ t('chat.retryMessageTitle') }}
      </NTooltip>
      <NTooltip v-if="message.editable">
        <template #trigger>
          <NButton
            class="message-action"
            quaternary
            circle
            size="small"
            :aria-label="t('chat.editMessage')"
            @click="emit('edit', message.id, message.text)"
          >
            <template #icon><UiIcon name="edit" /></template>
          </NButton>
        </template>
        {{ t('chat.editMessageTitle') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton
            class="message-action"
            quaternary
            circle
            size="small"
            :aria-label="t('chat.revertToHere')"
            @click="emit('revert', message.id, message.text)"
          >
            <template #icon><UiIcon name="undo" /></template>
          </NButton>
        </template>
        {{ t('chat.revertToHereTitle') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton
            class="message-action"
            quaternary
            circle
            size="small"
            :aria-label="t('chat.forkFromHere')"
            @click="emit('fork', message.id)"
          >
            <template #icon><UiIcon name="git-branch" /></template>
          </NButton>
        </template>
        {{ t('chat.forkFromHereTitle') }}
      </NTooltip>
    </div>
  </article>
</template>
