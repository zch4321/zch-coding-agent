<script setup lang="ts">
import { computed } from 'vue'
import { NInput, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { PermissionMode } from '../../../shared/config'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

const emit = defineEmits<{
  mode: [value: PermissionMode]
  provider: []
}>()
const agent = useAgentStore()
const { t } = useI18n()
const modeOptions = computed(() => [
  { label: t('chat.readonly'), value: 'readonly' },
  { label: t('chat.auto'), value: 'auto' },
  { label: t('chat.confirm'), value: 'confirm' },
  { label: t('chat.yolo'), value: 'yolo' },
])
const inputDisabled = computed(
  () =>
    !agent.workspacePath ||
    !agent.activeConversationId ||
    Boolean(agent.activeRunId) ||
    Boolean(agent.pendingApproval),
)
const sendHint = computed(() => {
  if (!agent.workspacePath) return t('chat.chooseHint')
  if (!agent.credentialConfigured) return t('chat.apiKeyHint')
  if (!agent.providerNoticeAccepted) return t('chat.noticeHint')
  if (agent.pendingApproval) return t('chat.approvalHint')
  return t('chat.inputHint')
})

function handleKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  void agent.sendMessage()
}
</script>

<template>
  <footer class="message-input-area">
    <NInput
      v-model:value="agent.input"
      type="textarea"
      :autosize="{ minRows: 2, maxRows: 7 }"
      :placeholder="sendHint"
      :disabled="inputDisabled"
      @keydown="handleKeydown"
    />
    <div class="message-input-toolbar">
      <div class="input-selectors">
        <NSelect
          :value="agent.providerForm.model"
          class="composer-model-select"
          size="small"
          :options="agent.modelOptions"
          filterable
          tag
          @update:value="agent.setProviderModel"
        />
        <button
          class="provider-settings-button"
          type="button"
          :aria-label="t('chat.providerSettings')"
          :title="t('chat.providerSettings')"
          @click="emit('provider')"
        >
          <UiIcon name="settings" />
        </button>
        <NSelect
          :value="agent.mode"
          class="mode-select"
          size="small"
          :options="modeOptions"
          :disabled="Boolean(agent.activeRunId || agent.pendingApproval)"
          @update:value="emit('mode', $event as PermissionMode)"
        />
      </div>
      <button
        v-if="agent.activeRunId"
        class="send-button stop"
        type="button"
        :aria-label="t('chat.stop')"
        :title="t('chat.stop')"
        :disabled="agent.runStatus === 'cancelling'"
        @click="agent.interruptRun"
      >
        <UiIcon name="stop" />
      </button>
      <button
        v-else
        class="send-button"
        type="button"
        :aria-label="t('chat.send')"
        :title="t('chat.send')"
        :disabled="!agent.canSend"
        @click="agent.sendMessage"
      >
        <UiIcon name="send" />
      </button>
    </div>
  </footer>
</template>
