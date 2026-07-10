<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'

const emit = defineEmits<{ removed: [] }>()
const agent = useAgentStore()
const { t } = useI18n()
const projectBusy = computed(() =>
  agent.conversations
    .filter((conversation) => conversation.projectPath === agent.workspacePath)
    .some((conversation) => agent.conversationIsBusy(conversation.id)),
)

async function removeProject() {
  if (agent.workspacePath && window.confirm(t('settings.removeConfirm'))) {
    await agent.removeCurrentProject()
    emit('removed')
  }
}
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('settings.projectTitle') }}</h2>
      <p>{{ t('settings.projectHint') }}</p>
    </div>
    <div class="settings-field">
      <span>{{ t('settings.currentWorkspace') }}</span>
      <code>{{ agent.workspacePath || t('app.noWorkspace') }}</code>
    </div>
    <div class="settings-actions">
      <NButton type="primary" @click="agent.chooseWorkspace">
        {{ t('app.chooseWorkspace') }}
      </NButton>
      <NTooltip :disabled="!projectBusy">
        <template #trigger>
          <NButton
            secondary
            type="error"
            :disabled="!agent.workspacePath || projectBusy"
            @click="removeProject"
          >
            {{ t('settings.removeProject') }}
          </NButton>
        </template>
        {{ t('settings.removeProjectBusy') }}
      </NTooltip>
    </div>
    <p class="settings-footnote">
      {{ t('settings.removeHint') }}
    </p>
  </section>
</template>
