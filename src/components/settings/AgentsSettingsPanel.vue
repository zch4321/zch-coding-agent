<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { NAlert, NButton, NInputNumber, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'
import ModelPoolSettingsSection from './ModelPoolSettingsSection.vue'

const agent = useAgentStore()
const { t } = useI18n()

const timeoutMinutes = computed({
  get: () =>
    Math.round((agent.subagentsConfig?.workerTimeoutMs ?? 1_800_000) / 60_000),
  set: (minutes: number | null) => {
    if (!agent.subagentsConfig || minutes === null) return
    agent.subagentsConfig.workerTimeoutMs = minutes * 60_000
  },
})

let autosaveTimer: ReturnType<typeof setTimeout> | undefined

/** Saves the current subagent settings without waiting for the debounce. */
function saveSubagentsNow() {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = undefined
  void agent.saveSubagents()
}

watch(
  () => (agent.subagentsConfig ? JSON.stringify(agent.subagentsConfig) : ''),
  () => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
    if (!agent.subagentsDirty) return

    agent.subagentsSaveStatus = ''
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined
      void agent.saveSubagents()
    }, 600)
  },
)

onBeforeUnmount(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  if (agent.subagentsDirty) void agent.saveSubagents()
})
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading settings-heading-with-actions">
      <div>
        <h2>{{ t('subagents.title') }}</h2>
        <p>{{ t('subagents.hint') }}</p>
      </div>
      <div v-if="agent.subagentsConfig" class="settings-heading-actions">
        <NButton
          type="primary"
          :loading="agent.subagentsSaving"
          :disabled="!agent.subagentsDirty"
          @click="saveSubagentsNow"
        >
          {{ t('subagents.save') }}
        </NButton>
        <small class="settings-save-status" aria-live="polite">
          {{
            agent.subagentsDirty
              ? t('settings.unsaved')
              : agent.subagentsSaveStatus === 'Saved'
                ? t('settings.saved')
                : agent.subagentsSaveStatus
          }}
        </small>
      </div>
    </div>

    <template v-if="agent.subagentsConfig">
      <section class="settings-subsection">
        <label class="settings-field">
          <span>{{ t('subagents.enabled') }}</span>
          <NSwitch v-model:value="agent.subagentsConfig.enabled" />
          <small>{{ t('subagents.enabledHint') }}</small>
        </label>

        <label class="settings-field">
          <span>{{ t('subagents.workerTimeout') }}</span>
          <NInputNumber
            v-model:value="timeoutMinutes"
            :min="1"
            :max="1440"
            :step="1"
          >
            <template #suffix>{{ t('subagents.minutes') }}</template>
          </NInputNumber>
          <small>{{ t('subagents.workerTimeoutHint') }}</small>
        </label>

        <label class="settings-field">
          <span>{{ t('subagents.maxAgentsPerSwarm') }}</span>
          <NInputNumber
            v-model:value="agent.subagentsConfig.maxAgentsPerSwarm"
            :min="1"
            :max="32"
            :step="1"
          />
          <small>{{ t('subagents.maxAgentsPerSwarmHint') }}</small>
        </label>
      </section>

      <NAlert type="info" :show-icon="true">
        {{ t('subagents.costNotice') }}
      </NAlert>
      <NAlert type="info" :show-icon="true">
        {{
          t('subagents.concurrencyNotice', {
            count: agent.limitsConfig?.maxConcurrentRuns ?? 1,
          })
        }}
      </NAlert>
    </template>

    <ModelPoolSettingsSection />
  </section>
</template>
