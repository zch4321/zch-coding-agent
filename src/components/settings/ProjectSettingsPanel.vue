<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useAgentStore } from '../../stores/agent'

const emit = defineEmits<{ removed: [] }>()
const agent = useAgentStore()

async function removeProject() {
  if (
    agent.workspacePath &&
    window.confirm(
      'Remove this project and its local conversation history from the app?',
    )
  ) {
    await agent.removeCurrentProject()
    emit('removed')
  }
}
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>Project</h2>
      <p>Select the workspace used by file, command, and Agent operations.</p>
    </div>
    <div class="settings-field">
      <span>Current workspace</span>
      <code>{{ agent.workspacePath || 'No workspace selected' }}</code>
    </div>
    <div class="settings-actions">
      <NButton type="primary" @click="agent.chooseWorkspace">
        Choose workspace
      </NButton>
      <NButton
        secondary
        type="error"
        :disabled="!agent.workspacePath"
        @click="removeProject"
      >
        Remove project
      </NButton>
    </div>
    <p class="settings-footnote">
      Removing a project clears app history and runtime resources. It does not
      delete files from disk.
    </p>
  </section>
</template>
