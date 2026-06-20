<script setup lang="ts">
import { computed } from 'vue'
import { NInput, NSelect } from 'naive-ui'
import type { PermissionMode } from '../../../shared/config'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

const emit = defineEmits<{
  mode: [value: PermissionMode]
  provider: []
}>()
const agent = useAgentStore()
const modeOptions = [
  { label: 'ReadOnly', value: 'readonly' },
  { label: 'Auto', value: 'auto' },
  { label: 'Confirm', value: 'confirm' },
  { label: 'Yolo', value: 'yolo' },
]
const inputDisabled = computed(
  () =>
    !agent.workspacePath ||
    !agent.activeConversationId ||
    Boolean(agent.activeRunId) ||
    Boolean(agent.pendingApproval),
)
const sendHint = computed(() => {
  if (!agent.workspacePath) return 'Choose a workspace to begin'
  if (!agent.credentialConfigured)
    return 'Configure a Provider API key in Settings'
  if (!agent.providerNoticeAccepted) return 'Review the Provider data notice'
  if (agent.pendingApproval)
    return 'Resolve the pending approval before sending another message'
  return 'Ask about this workspace'
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
          aria-label="Open Provider settings"
          title="Provider settings"
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
        aria-label="Stop run"
        title="Stop"
        :disabled="agent.runStatus === 'cancelling'"
        @click="agent.interruptRun"
      >
        <UiIcon name="stop" />
      </button>
      <button
        v-else
        class="send-button"
        type="button"
        aria-label="Send message"
        title="Send"
        :disabled="!agent.canSend"
        @click="agent.sendMessage"
      >
        <UiIcon name="send" />
      </button>
    </div>
  </footer>
</template>
