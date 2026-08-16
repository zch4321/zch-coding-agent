<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { PermissionMode } from '../../../shared/config'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

const emit = defineEmits<{ defaultMode: [value: PermissionMode] }>()
const agent = useAgentStore()
const { t } = useI18n()
const modeOptions = [
  { label: t('chat.readonly'), value: 'readonly' },
  { label: t('chat.auto'), value: 'auto' },
  { label: t('chat.confirm'), value: 'confirm' },
  { label: t('chat.yolo'), value: 'yolo' },
]
const sensitiveModeOptions = [
  { label: t('permissions.off'), value: 'off' },
  { label: t('permissions.warn'), value: 'warn' },
  { label: t('permissions.confirm'), value: 'confirm' },
]

let autosaveTimer: ReturnType<typeof setTimeout> | undefined

function savePermissionsNow() {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = undefined
  void agent.savePermissions()
}

watch(
  () =>
    JSON.stringify({
      defaultMode: agent.defaultMode,
      permissionForm: agent.permissionForm,
    }),
  () => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
    if (!agent.permissionsDirty) return

    agent.permissionsSaveStatus = ''
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined
      void agent.savePermissions()
    }, 600)
  },
)

onBeforeUnmount(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  if (agent.permissionsDirty) void agent.savePermissions()
})
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading settings-heading-with-actions">
      <div>
        <h2>{{ t('permissions.title') }}</h2>
        <p>{{ t('permissions.hint') }}</p>
      </div>
      <div class="settings-heading-actions">
        <NButton
          type="primary"
          :loading="agent.permissionsSaving"
          :disabled="!agent.permissionsDirty"
          @click="savePermissionsNow"
        >
          {{ t('permissions.save') }}
        </NButton>
        <small class="settings-save-status" aria-live="polite">
          {{
            agent.permissionsDirty
              ? t('settings.unsaved')
              : agent.permissionsSaveStatus
                ? t('settings.saved')
                : ''
          }}
        </small>
      </div>
    </div>
    <label class="settings-field">
      <span>{{ t('permissions.defaultMode') }}</span>
      <NSelect
        :value="agent.defaultMode"
        :options="modeOptions"
        @update:value="emit('defaultMode', $event as PermissionMode)"
      />
      <small>{{ t('permissions.autoApprovalNote') }}</small>
    </label>
    <label class="settings-field">
      <span>{{ t('permissions.sensitiveData') }}</span>
      <NSelect
        v-model:value="agent.permissionForm.sensitiveMode"
        :options="sensitiveModeOptions"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('permissions.pathGlobs') }}</span>
      <NInput
        v-model:value="agent.permissionForm.pathGlobs"
        type="textarea"
        :rows="3"
        :placeholder="t('permissions.oneGlob')"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('permissions.contentPatterns') }}</span>
      <NInput
        v-model:value="agent.permissionForm.contentPatterns"
        type="textarea"
        :rows="3"
        :placeholder="t('permissions.onePattern')"
      />
    </label>
    <div class="remembered-rules">
      <h3>{{ t('permissions.remembered') }}</h3>
      <p v-if="!agent.rememberedRules.length">{{ t('permissions.none') }}</p>
      <article v-for="rule in agent.rememberedRules" :key="rule.id">
        <div>
          <strong>{{ rule.toolId }}</strong>
          <span>{{ rule.effect }} · {{ rule.workspaceScope }}</span>
          <code>{{ rule.argConstraints }}</code>
          <small v-if="rule.expiresAt">{{
            t('permissions.expires', { time: rule.expiresAt })
          }}</small>
        </div>
        <NButton
          quaternary
          circle
          size="small"
          :aria-label="t('permissions.deleteRule')"
          @click="agent.removeRememberedRule(rule.id)"
        >
          <UiIcon name="trash" />
        </NButton>
      </article>
    </div>
  </section>
</template>
