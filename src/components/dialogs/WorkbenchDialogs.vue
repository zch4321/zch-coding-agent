<script setup lang="ts">
import { NAlert, NButton, NInput, NModal, NSpace } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ConfirmDialog from './ConfirmDialog.vue'

type MessageAction = 'edit' | 'fork' | 'retry'

const props = defineProps<{
  yoloOpen: boolean
  renameOpen: boolean
  renameValue: string
  deleteOpen: boolean
  revertOpen: boolean
  revertMessagePreview: string
  messageAction?: MessageAction
}>()
const emit = defineEmits<{
  'update:yoloOpen': [value: boolean]
  'update:renameOpen': [value: boolean]
  'update:renameValue': [value: string]
  'update:deleteOpen': [value: boolean]
  'update:revertOpen': [value: boolean]
  'confirm-yolo': []
  'confirm-rename': []
  'confirm-delete': []
  'confirm-revert': []
  'confirm-message-action': []
  'update:messageAction': [value: MessageAction | undefined]
}>()
const { t } = useI18n()
const messageActionTitle = computed(() => {
  switch (props.messageAction) {
    case 'retry':
      return t('dialogs.retryMessageTitle')
    case 'edit':
      return t('dialogs.editMessageTitle')
    case 'fork':
      return t('dialogs.forkMessageTitle')
    default:
      return ''
  }
})
const messageActionText = computed(() => {
  switch (props.messageAction) {
    case 'retry':
      return t('dialogs.retryMessageText')
    case 'edit':
      return t('dialogs.editMessageText')
    case 'fork':
      return t('dialogs.forkMessageText')
    default:
      return ''
  }
})
const messageActionPositiveText = computed(() => {
  switch (props.messageAction) {
    case 'retry':
      return t('dialogs.confirmRetry')
    case 'edit':
      return t('dialogs.confirmEdit')
    case 'fork':
      return t('dialogs.confirmFork')
    default:
      return ''
  }
})
</script>

<template>
  <NModal
    :show="yoloOpen"
    preset="card"
    style="width: min(620px, calc(100vw - 40px))"
    :title="t('dialogs.yoloTitle')"
    @update:show="emit('update:yoloOpen', $event)"
  >
    <NAlert type="error" :title="t('dialogs.yoloRisk')">
      {{ t('dialogs.yoloText') }}
    </NAlert>
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:yoloOpen', false)">{{
        t('common.cancel')
      }}</NButton>
      <NButton type="error" @click="emit('confirm-yolo')">
        {{ t('dialogs.enableYolo') }}
      </NButton>
    </NSpace>
  </NModal>

  <NModal
    :show="renameOpen"
    preset="card"
    style="width: min(460px, calc(100vw - 40px))"
    content-class="small-modal-content"
    :title="t('dialogs.renameTitle')"
    @update:show="emit('update:renameOpen', $event)"
  >
    <NInput
      :value="renameValue"
      maxlength="120"
      @update:value="emit('update:renameValue', $event)"
    />
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:renameOpen', false)">{{
        t('common.cancel')
      }}</NButton>
      <NButton type="primary" @click="emit('confirm-rename')">{{
        t('dialogs.rename')
      }}</NButton>
    </NSpace>
  </NModal>

  <ConfirmDialog
    :show="deleteOpen"
    :title="t('dialogs.deleteTitle')"
    :positive-text="t('common.delete')"
    :negative-text="t('common.cancel')"
    type="warning"
    positive-type="error"
    @update:show="emit('update:deleteOpen', $event)"
    @positive="emit('confirm-delete')"
  >
    {{ t('dialogs.deleteText') }}
  </ConfirmDialog>

  <ConfirmDialog
    :show="revertOpen"
    :title="t('dialogs.revertTitle')"
    :positive-text="t('dialogs.confirmRevert')"
    :negative-text="t('common.cancel')"
    type="warning"
    @update:show="emit('update:revertOpen', $event)"
    @positive="emit('confirm-revert')"
  >
    <p>{{ t('dialogs.revertText') }}</p>
    <p v-if="revertMessagePreview" class="revert-preview">
      {{ revertMessagePreview }}
    </p>
  </ConfirmDialog>

  <ConfirmDialog
    :show="Boolean(messageAction)"
    :title="messageActionTitle"
    :positive-text="messageActionPositiveText"
    :negative-text="t('common.cancel')"
    type="warning"
    @update:show="!$event && emit('update:messageAction', undefined)"
    @positive="emit('confirm-message-action')"
  >
    {{ messageActionText }}
  </ConfirmDialog>
</template>
