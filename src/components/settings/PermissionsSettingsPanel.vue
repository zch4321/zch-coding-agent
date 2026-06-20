<script setup lang="ts">
import { NButton, NInput, NSelect } from 'naive-ui'
import type { PermissionMode } from '../../../shared/config'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

const emit = defineEmits<{ mode: [value: PermissionMode] }>()
const agent = useAgentStore()
const modeOptions = [
  { label: 'ReadOnly', value: 'readonly' },
  { label: 'Auto', value: 'auto' },
  { label: 'Confirm', value: 'confirm' },
  { label: 'Yolo', value: 'yolo' },
]
const sensitiveModeOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Warn', value: 'warn' },
  { label: 'Confirm', value: 'confirm' },
]
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>Permissions</h2>
      <p>Set defaults and review rules remembered from approvals.</p>
    </div>
    <label class="settings-field">
      <span>Default mode</span>
      <NSelect
        :value="agent.mode"
        :options="modeOptions"
        :disabled="Boolean(agent.activeRunId || agent.pendingApproval)"
        @update:value="emit('mode', $event as PermissionMode)"
      />
    </label>
    <label class="settings-field">
      <span>Sensitive data</span>
      <NSelect
        v-model:value="agent.permissionForm.sensitiveMode"
        :options="sensitiveModeOptions"
      />
    </label>
    <label class="settings-field">
      <span>Sensitive path globs</span>
      <NInput
        v-model:value="agent.permissionForm.pathGlobs"
        type="textarea"
        :rows="3"
        placeholder="One glob per line"
      />
    </label>
    <label class="settings-field">
      <span>Content patterns</span>
      <NInput
        v-model:value="agent.permissionForm.contentPatterns"
        type="textarea"
        :rows="3"
        placeholder="One pattern per line"
      />
    </label>
    <NButton type="primary" @click="agent.savePermissions">
      Save permissions
    </NButton>
    <div class="remembered-rules">
      <h3>Remembered rules</h3>
      <p v-if="!agent.rememberedRules.length">No remembered rules.</p>
      <article v-for="rule in agent.rememberedRules" :key="rule.id">
        <div>
          <strong>{{ rule.toolId }}</strong>
          <span>{{ rule.effect }} · {{ rule.workspaceScope }}</span>
          <code>{{ rule.argConstraints }}</code>
          <small v-if="rule.expiresAt">Expires {{ rule.expiresAt }}</small>
        </div>
        <button
          type="button"
          aria-label="Delete remembered rule"
          @click="agent.removeRememberedRule(rule.id)"
        >
          <UiIcon name="trash" />
        </button>
      </article>
    </div>
  </section>
</template>
