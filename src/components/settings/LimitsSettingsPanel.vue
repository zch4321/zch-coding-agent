<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import {
  NAlert,
  NButton,
  NDivider,
  NInputNumber,
  NSelect,
  type SelectOption,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { CommandShellSelection } from '../../../shared/command-shell'
import { useAgentStore } from '../../stores/agent'

const agent = useAgentStore()
const { t } = useI18n()
const tokenEstimationOptions = computed(() => [
  { label: t('limits.tokenConservative'), value: 'conservative' },
  { label: t('limits.tokenCustom'), value: 'custom-bytes' },
])
const commandShellOptions = computed<SelectOption[]>(() => {
  const catalog = agent.commandShellCatalog
  const resolvedLabel = catalog?.resolved.label ?? t('limits.shellDetecting')
  const options: SelectOption[] = [
    {
      label: t('limits.commandShellAuto', { shell: resolvedLabel }),
      value: 'auto',
    },
    ...(catalog?.profiles.map((profile) => ({
      label: profile.label,
      value: profile.id,
    })) ?? []),
  ]
  const selected = agent.executionEnvironmentConfig.commandShell
  if (
    selected !== 'auto' &&
    !options.some((option) => option.value === selected)
  ) {
    options.push({
      label: t('limits.commandShellMissing', { shell: selected }),
      value: selected,
      disabled: true,
    })
  }
  return options
})

let autosaveTimer: ReturnType<typeof setTimeout> | undefined

function saveLimitsNow() {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = undefined
  void agent.saveLimits()
}

function selectCommandShell(value: string) {
  void agent.setCommandShell(value as CommandShellSelection)
}

onMounted(() => {
  void agent.loadCommandShells()
})

watch(
  () => (agent.limitsConfig ? JSON.stringify(agent.limitsConfig) : ''),
  () => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
    if (!agent.limitsDirty) return

    agent.limitsSaveStatus = ''
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined
      void agent.saveLimits()
    }, 600)
  },
)

onBeforeUnmount(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  if (agent.limitsDirty) void agent.saveLimits()
})
</script>

<template>
  <section class="settings-section limits-settings-section">
    <div class="settings-heading settings-heading-with-actions">
      <div>
        <h2>{{ t('limits.title') }}</h2>
        <p>{{ t('limits.hint') }}</p>
      </div>
      <div v-if="agent.limitsConfig" class="settings-heading-actions">
        <NButton
          type="primary"
          :loading="agent.limitsSaving"
          :disabled="!agent.limitsDirty"
          @click="saveLimitsNow"
        >
          {{ t('limits.save') }}
        </NButton>
        <small class="settings-save-status" aria-live="polite">
          {{
            agent.limitsDirty
              ? t('settings.unsaved')
              : agent.limitsSaveStatus === 'Saved'
                ? t('settings.saved')
                : agent.limitsSaveStatus
          }}
        </small>
      </div>
    </div>

    <template v-if="agent.limitsConfig">
      <div class="limits-grid">
        <section class="limits-group">
          <h3>{{ t('limits.concurrency') }}</h3>
          <label class="settings-field">
            <span>{{ t('limits.maxConcurrentRuns') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxConcurrentRuns"
              :min="1"
              :max="32"
            />
          </label>
          <p>{{ t('limits.concurrencyHint') }}</p>
        </section>
        <NDivider />
        <section class="limits-group">
          <h3>{{ t('limits.runLoop') }}</h3>
          <label class="settings-field">
            <span>{{ t('limits.maxStepsPerRun') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxStepsPerRun"
              :min="0"
              :max="1000"
            />
          </label>
          <p>{{ t('limits.maxStepsPerRunHint') }}</p>
          <label class="settings-field">
            <span>{{ t('limits.maxContextTokens') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxContextTokens"
              :min="1024"
              :max="10000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.maxAttachmentContextTokens') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxAttachmentContextTokens"
              :min="1024"
              :max="1000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.autoCompactTriggerPercent') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.autoCompactTriggerPercent"
              :min="50"
              :max="95"
            >
              <template #suffix>%</template>
            </NInputNumber>
          </label>
          <label class="settings-field">
            <span>{{ t('limits.maxToolResultTokens') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxToolResultTokens"
              :min="256"
              :max="1000000"
            />
          </label>
        </section>

        <NDivider />
        <section class="limits-group">
          <h3>{{ t('limits.commands') }}</h3>
          <div class="settings-field">
            <span>{{ t('limits.commandShell') }}</span>
            <div class="settings-inline">
              <NSelect
                :aria-label="t('limits.commandShell')"
                :value="agent.executionEnvironmentConfig.commandShell"
                :options="commandShellOptions"
                :loading="agent.commandShellLoading"
                :disabled="agent.commandShellSaving"
                @update:value="selectCommandShell"
              />
              <NButton
                :loading="agent.commandShellLoading"
                :disabled="agent.commandShellSaving"
                @click="agent.loadCommandShells(true)"
              >
                {{ t('limits.rescanShells') }}
              </NButton>
            </div>
            <small v-if="agent.commandShellCatalog">
              {{
                t('limits.commandShellResolved', {
                  shell: agent.commandShellCatalog.resolved.label,
                  path: agent.commandShellCatalog.resolved.executable,
                })
              }}
            </small>
          </div>
          <NAlert
            v-if="agent.commandShellCatalog?.fallback"
            type="warning"
            :title="t('limits.commandShellFallbackTitle')"
          >
            {{ t('limits.commandShellFallback') }}
          </NAlert>
          <p>{{ t('limits.commandShellHint') }}</p>
          <label class="settings-field">
            <span>{{ t('limits.commandTimeoutMs') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.commandTimeoutMs"
              :min="100"
              :max="86400000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.maxToolOutputBytes') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxToolOutputBytes"
              :min="1024"
              :max="100000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.terminalScrollbackBytes') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.terminalScrollbackBytes"
              :min="1024"
              :max="100000000"
            />
          </label>
        </section>

        <NDivider />
        <section class="limits-group">
          <h3>{{ t('limits.files') }}</h3>
          <label class="settings-field">
            <span>{{ t('limits.readFileSourceBytes') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.readFileSourceBytes"
              :min="1024"
              :max="100000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.readFileOutputBytes') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.readFileOutputBytes"
              :min="1024"
              :max="10000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.editableFileBytes') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.editableFileBytes"
              :min="1024"
              :max="100000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.writeFileBytes') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.writeFileBytes"
              :min="1024"
              :max="10000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.patchBytes') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.patchBytes"
              :min="1024"
              :max="10000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.diffChars') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.diffChars"
              :min="1024"
              :max="10000000"
            />
          </label>
        </section>

        <NDivider />
        <section class="limits-group">
          <h3>{{ t('limits.approvalAndNetwork') }}</h3>
          <label class="settings-field">
            <span>{{ t('limits.approvalTimeoutMs') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.approvalTimeoutMs"
              :min="1000"
              :max="86400000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.autoApprovalTimeoutMs') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.autoApprovalTimeoutMs"
              :min="1000"
              :max="300000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.fetchTimeoutMs') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.fetchTimeoutMs"
              :min="1000"
              :max="60000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.fetchResponseBytes') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.fetchResponseBytes"
              :min="1024"
              :max="10000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.fetchMaxRedirects') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.fetchMaxRedirects"
              :min="0"
              :max="10"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.modelCatalogTimeoutMs') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.modelCatalogTimeoutMs"
              :min="1000"
              :max="300000"
            />
          </label>
        </section>

        <NDivider />
        <section class="limits-group">
          <h3>{{ t('limits.tokenEstimation') }}</h3>
          <label class="settings-field">
            <span>{{ t('limits.tokenEstimationMode') }}</span>
            <NSelect
              v-model:value="agent.limitsConfig.tokenEstimation.mode"
              :options="tokenEstimationOptions"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.bytesPerToken') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.tokenEstimation.bytesPerToken"
              :disabled="
                agent.limitsConfig.tokenEstimation.mode !== 'custom-bytes'
              "
              :min="0.25"
              :max="32"
              :step="0.25"
            />
          </label>
        </section>
      </div>
    </template>
  </section>
</template>
