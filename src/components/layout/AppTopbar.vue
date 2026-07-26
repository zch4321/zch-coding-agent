<script setup lang="ts">
import { NButton, NTooltip } from 'naive-ui'
import { IPC_VERSION } from '../../../shared/channels'
import { useAgentStore } from '../../stores/agent'
import { useNotificationStore } from '../../stores/notifications'
import { useI18n } from 'vue-i18n'
import UiIcon from '../UiIcon.vue'

defineProps<{
  projectName: string
  workspaceLabel: string
  terminalOpen: boolean
  projectSidebarOpen: boolean
  artifactSidebarOpen: boolean
  projectSidebarDisabled: boolean
  artifactSidebarDisabled: boolean
}>()
const emit = defineEmits<{
  project: []
  terminal: []
  'project-sidebar': []
  'artifact-sidebar': []
}>()
const agent = useAgentStore()
const notifications = useNotificationStore()
const { t } = useI18n()

async function windowAction(
  action: 'minimizeWindow' | 'toggleMaximizeWindow' | 'closeWindow',
) {
  const result = await window.agentApi?.[action]({ version: IPC_VERSION })
  if (result && !result.ok) {
    notifications.error({
      code: result.error.code,
      message: result.error.message,
    })
  }
}
</script>

<template>
  <header class="app-topbar">
    <div class="window-title">
      <span class="app-mark"><UiIcon name="app" /></span>
      <strong>{{ t('app.name') }}</strong>
    </div>
    <NTooltip>
      <template #trigger>
        <NButton
          class="project-crumb"
          text
          :aria-label="workspaceLabel"
          @click="emit('project')"
        >
          <template #icon><UiIcon name="folder" /></template>
          <span>{{ projectName }}</span>
        </NButton>
      </template>
      {{ workspaceLabel }}
    </NTooltip>
    <div class="topbar-actions">
      <NTooltip>
        <template #trigger>
          <NButton
            class="topbar-icon-button"
            quaternary
            circle
            :aria-label="t('topbar.terminal')"
            :aria-pressed="terminalOpen"
            :disabled="!agent.workspacePath || !agent.bridgeAvailable"
            @click="emit('terminal')"
          >
            <template #icon><UiIcon name="terminal" /></template>
          </NButton>
        </template>
        {{ t('topbar.terminal') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton
            class="topbar-icon-button"
            quaternary
            circle
            :aria-label="t('topbar.projectSidebar')"
            :aria-pressed="projectSidebarOpen"
            :disabled="projectSidebarDisabled"
            @click="emit('project-sidebar')"
          >
            <template #icon><UiIcon name="panel-left" /></template>
          </NButton>
        </template>
        {{
          projectSidebarDisabled
            ? t('topbar.sidebarUnavailable')
            : t('topbar.projectSidebar')
        }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton
            class="topbar-icon-button"
            quaternary
            circle
            :aria-label="t('topbar.artifactSidebar')"
            :aria-pressed="artifactSidebarOpen"
            :disabled="artifactSidebarDisabled"
            @click="emit('artifact-sidebar')"
          >
            <template #icon><UiIcon name="panel-right" /></template>
          </NButton>
        </template>
        {{
          artifactSidebarDisabled
            ? t('topbar.sidebarUnavailable')
            : t('topbar.artifactSidebar')
        }}
      </NTooltip>
      <div class="window-controls" :aria-label="t('topbar.windowControls')">
        <button
          class="window-control"
          type="button"
          :aria-label="t('topbar.minimize')"
          @click="windowAction('minimizeWindow')"
        >
          <UiIcon name="minimize" />
        </button>
        <button
          class="window-control"
          type="button"
          :aria-label="t('topbar.maximize')"
          @click="windowAction('toggleMaximizeWindow')"
        >
          <UiIcon name="maximize" />
        </button>
        <button
          class="window-control close"
          type="button"
          :aria-label="t('topbar.close')"
          @click="windowAction('closeWindow')"
        >
          <UiIcon name="close" />
        </button>
      </div>
    </div>
  </header>
</template>
