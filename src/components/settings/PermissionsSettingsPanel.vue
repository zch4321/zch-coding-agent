<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput, NSelect, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { PermissionMode } from '../../../shared/config'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

const emit = defineEmits<{ mode: [value: PermissionMode] }>()
const agent = useAgentStore()
const { t } = useI18n()
const modeOptions = computed(() => [
  { label: t('chat.readonly'), value: 'readonly' },
  { label: t('chat.auto'), value: 'auto' },
  { label: t('chat.confirm'), value: 'confirm' },
  { label: t('chat.yolo'), value: 'yolo' },
])
const sensitiveModeOptions = computed(() => [
  { label: t('permissions.off'), value: 'off' },
  { label: t('permissions.warn'), value: 'warn' },
  { label: t('permissions.confirm'), value: 'confirm' },
])
const approvalProvider = computed(() =>
  agent.providers.find(
    (provider) => provider.id === agent.approvalForm.providerId,
  ),
)
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('permissions.title') }}</h2>
      <p>{{ t('permissions.hint') }}</p>
    </div>
    <label class="settings-field">
      <span>{{ t('permissions.defaultMode') }}</span>
      <NTooltip :disabled="!agent.modeLockedByWriter">
        <template #trigger>
          <NSelect
            :value="agent.modeLockedByWriter ? 'readonly' : agent.mode"
            :options="modeOptions"
            :disabled="
              Boolean(
                agent.startPending ||
                agent.activeRunId ||
                agent.pendingApproval ||
                agent.modeLockedByWriter,
              )
            "
            @update:value="emit('mode', $event as PermissionMode)"
          />
        </template>
        {{ agent.modeLockTooltip }}
      </NTooltip>
    </label>
    <div class="settings-subsection">
      <div class="settings-subsection-heading">
        <h3>{{ t('settings.approvalTitle') }}</h3>
        <p>{{ t('settings.approvalHint') }}</p>
      </div>
      <label class="settings-field">
        <span>{{ t('settings.approverProvider') }}</span>
        <NSelect
          :value="agent.approvalForm.providerId"
          :options="agent.providerOptions"
          filterable
          @update:value="agent.setApprovalProvider"
        />
        <small>
          {{
            approvalProvider?.credentialConfigured
              ? t('settings.approvalCredentialReady')
              : t('settings.approvalCredentialMissing')
          }}
        </small>
      </label>
      <label class="settings-field">
        <span>{{ t('settings.approverModel') }}</span>
        <NSelect
          v-model:value="agent.approvalForm.model"
          :options="agent.approvalModelOptions"
          filterable
          tag
        />
        <small>{{ t('settings.approvalModelHint') }}</small>
      </label>
      <div class="settings-actions">
        <NButton
          type="primary"
          :loading="agent.approvalSaving"
          :disabled="!agent.approvalDirty"
          @click="agent.saveApproval"
        >
          {{ t('settings.saveApproval') }}
        </NButton>
        <small class="settings-save-status" aria-live="polite">
          {{
            agent.approvalDirty
              ? t('settings.unsaved')
              : agent.approvalSaveStatus
                ? t('settings.saved')
                : ''
          }}
        </small>
      </div>
    </div>
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
    <NButton type="primary" @click="agent.savePermissions">
      {{ t('permissions.save') }}
    </NButton>
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
