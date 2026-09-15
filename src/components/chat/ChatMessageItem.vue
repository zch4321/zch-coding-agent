<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTag, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ChatMessage } from '../../stores/agent-types'
import MarkdownBlock from '../MarkdownBlock.vue'
import UiIcon from '../UiIcon.vue'
import AttachmentPreviewList from './AttachmentPreviewList.vue'
import type { Attachment } from '../../../shared/attachments'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { selectedDraftTarget } from '../../stores/composer-draft-view'
import { useAttachmentInputsStore } from '../../stores/attachment-inputs'
import { appendMissingContextReferences } from '../../context-references'

const props = withDefaults(
  defineProps<{
    message: ChatMessage
    actionsDisabled: boolean
    showActions?: boolean
    continuable?: boolean
  }>(),
  { showActions: true, continuable: false },
)
const emit = defineEmits<{
  revert: [messageId: string, text: string]
  fork: [messageId: string]
  retry: [messageId: string, text: string]
  edit: [messageId: string, text: string]
  continue: []
}>()
const { t } = useI18n()

function reattach(attachment: Attachment): void {
  const target = selectedDraftTarget(useAgentReplicaStore())
  if (target)
    void useAttachmentInputsStore().reattach({ ...target }, attachment)
}

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

const showMetadata = computed(() => Boolean(visibleRoleLabel.value))
const visibleText = computed(() =>
  props.message.role === 'user'
    ? appendMissingContextReferences(
        props.message.text,
        props.message.attachments ?? [],
      )
    : props.message.text,
)
</script>

<template>
  <article class="chat-message" :class="message.role" :aria-label="roleLabel()">
    <div v-if="showMetadata" class="message-meta">
      <strong v-if="visibleRoleLabel">{{ visibleRoleLabel }}</strong>
      <NTag
        v-if="
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
    <MarkdownBlock
      v-if="visibleText.trim()"
      :content="visibleText"
      :context-references="message.role === 'user'"
      :streaming="message.durableKind === 'stream'"
    />
    <AttachmentPreviewList
      v-if="message.assets?.length"
      :attachments="message.assets"
      reattachable
      :disabled="actionsDisabled"
      @reattach="reattach"
    />
    <div
      v-if="
        (message.text || message.assets?.length) &&
        showActions !== false &&
        !actionsDisabled &&
        message.durableKind !== 'stream'
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
      <NTooltip v-if="continuable">
        <template #trigger>
          <NButton
            class="message-action"
            quaternary
            circle
            size="small"
            :aria-label="t('chat.continueConversation')"
            @click="emit('continue')"
          >
            <template #icon><UiIcon name="chevron-right" /></template>
          </NButton>
        </template>
        {{ t('chat.continueConversationTitle') }}
      </NTooltip>
    </div>
  </article>
</template>
