<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
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
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('permissions.title') }}</h2>
      <p>{{ t('permissions.hint') }}</p>
    </div>
    <label class="settings-field">
      <span>{{ t('permissions.defaultMode') }}</span>
      <NSelect
        :value="agent.mode"
        :options="modeOptions"
        :disabled="Boolean(agent.activeRunId || agent.pendingApproval)"
        @update:value="emit('mode', $event as PermissionMode)"
      />
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
        <button
          type="button"
          :aria-label="t('permissions.deleteRule')"
          @click="agent.removeRememberedRule(rule.id)"
        >
          <UiIcon name="trash" />
        </button>
      </article>
    </div>
  </section>
</template>
