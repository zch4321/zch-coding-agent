<script setup lang="ts">
import { NTooltip } from 'naive-ui'
import { IPC_VERSION } from '../../../shared/channels'
import { useAgentStore } from '../../stores/agent'
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
const { t } = useI18n()

async function windowAction(
  action: 'minimizeWindow' | 'toggleMaximizeWindow' | 'closeWindow',
) {
  const result = await window.agentApi?.[action]({ version: IPC_VERSION })
  if (result && !result.ok) agent.error = result.error.message
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
        <button
          class="project-crumb"
          type="button"
          :aria-label="workspaceLabel"
          @click="emit('project')"
        >
          <UiIcon name="folder" />
          <span>{{ projectName }}</span>
        </button>
      </template>
      {{ workspaceLabel }}
    </NTooltip>
    <div class="topbar-actions">
      <NTooltip>
        <template #trigger>
          <button
            class="topbar-icon-button"
            type="button"
            :aria-label="t('topbar.terminal')"
            :aria-pressed="terminalOpen"
            :disabled="!agent.workspacePath || !agent.bridgeAvailable"
            @click="emit('terminal')"
          >
            <UiIcon name="terminal" />
          </button>
        </template>
        {{ t('topbar.terminal') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <button
            class="topbar-icon-button"
            type="button"
            :aria-label="t('topbar.projectSidebar')"
            :aria-pressed="projectSidebarOpen"
            :disabled="projectSidebarDisabled"
            @click="emit('project-sidebar')"
          >
            <UiIcon name="panel-left" />
          </button>
        </template>
        {{
          projectSidebarDisabled
            ? t('topbar.sidebarUnavailable')
            : t('topbar.projectSidebar')
        }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <button
            class="topbar-icon-button"
            type="button"
            :aria-label="t('topbar.artifactSidebar')"
            :aria-pressed="artifactSidebarOpen"
            :disabled="artifactSidebarDisabled"
            @click="emit('artifact-sidebar')"
          >
            <UiIcon name="panel-right" />
          </button>
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
