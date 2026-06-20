<script setup lang="ts">
import { IPC_VERSION } from '../../../shared/channels'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

defineProps<{
  projectName: string
  workspaceLabel: string
  terminalOpen: boolean
  projectSidebarOpen: boolean
  artifactSidebarOpen: boolean
}>()
const emit = defineEmits<{
  project: []
  terminal: []
  'project-sidebar': []
  'artifact-sidebar': []
  settings: []
}>()
const agent = useAgentStore()

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
      <strong>My Coding Agent</strong>
    </div>
    <button
      class="project-crumb"
      type="button"
      :title="workspaceLabel"
      @click="emit('project')"
    >
      <UiIcon name="folder" />
      <span>{{ projectName }}</span>
    </button>
    <div class="topbar-actions">
      <button
        class="topbar-icon-button"
        type="button"
        aria-label="Toggle terminal"
        title="Toggle terminal (Ctrl+J)"
        :aria-pressed="terminalOpen"
        :disabled="!agent.workspacePath || !agent.bridgeAvailable"
        @click="emit('terminal')"
      >
        <UiIcon name="terminal" />
      </button>
      <button
        class="topbar-icon-button"
        type="button"
        aria-label="Toggle project sidebar"
        title="Toggle project sidebar (Ctrl+B)"
        :aria-pressed="projectSidebarOpen"
        @click="emit('project-sidebar')"
      >
        <UiIcon name="panel-left" />
      </button>
      <button
        class="topbar-icon-button"
        type="button"
        aria-label="Toggle artifact sidebar"
        title="Toggle artifact sidebar (Ctrl+Shift+B)"
        :aria-pressed="artifactSidebarOpen"
        @click="emit('artifact-sidebar')"
      >
        <UiIcon name="panel-right" />
      </button>
      <button
        class="topbar-icon-button"
        type="button"
        aria-label="Open settings"
        title="Settings"
        @click="emit('settings')"
      >
        <UiIcon name="settings" />
      </button>
      <div class="window-controls" aria-label="Window controls">
        <button
          class="window-control"
          type="button"
          aria-label="Minimize window"
          @click="windowAction('minimizeWindow')"
        >
          <UiIcon name="minimize" />
        </button>
        <button
          class="window-control"
          type="button"
          aria-label="Maximize or restore window"
          @click="windowAction('toggleMaximizeWindow')"
        >
          <UiIcon name="maximize" />
        </button>
        <button
          class="window-control close"
          type="button"
          aria-label="Close window"
          @click="windowAction('closeWindow')"
        >
          <UiIcon name="close" />
        </button>
      </div>
    </div>
  </header>
</template>
