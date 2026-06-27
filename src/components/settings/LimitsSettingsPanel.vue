<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInputNumber, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'

const agent = useAgentStore()
const { t } = useI18n()
const tokenEstimationOptions = computed(() => [
  { label: t('limits.tokenConservative'), value: 'conservative' },
  { label: t('limits.tokenCustom'), value: 'custom-bytes' },
])
</script>

<template>
  <section class="settings-section limits-settings-section">
    <div class="settings-heading">
      <h2>{{ t('limits.title') }}</h2>
      <p>{{ t('limits.hint') }}</p>
    </div>

    <template v-if="agent.limitsConfig">
      <div class="limits-grid">
        <section class="limits-group">
          <h3>{{ t('limits.runLoop') }}</h3>
          <label class="settings-field">
            <span>{{ t('limits.maxStepsPerRun') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxStepsPerRun"
              :min="1"
              :max="1000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.maxContextTokens') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxContextTokens"
              :min="1024"
              :max="10000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.maxToolResultTokens') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxToolResultTokens"
              :min="256"
              :max="1000000"
            />
          </label>
          <label class="settings-field">
            <span>{{ t('limits.maxToolTokensPerRun') }}</span>
            <NInputNumber
              v-model:value="agent.limitsConfig.maxToolTokensPerRun"
              :min="256"
              :max="10000000"
            />
          </label>
        </section>

        <section class="limits-group">
          <h3>{{ t('limits.commands') }}</h3>
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

      <div class="settings-actions">
        <NButton
          type="primary"
          :loading="agent.limitsSaving"
          @click="agent.saveLimits"
        >
          {{ t('limits.save') }}
        </NButton>
        <small class="settings-save-status" aria-live="polite">
          {{
            agent.limitsSaveStatus === 'Saved'
              ? t('settings.saved')
              : agent.limitsSaveStatus
          }}
        </small>
      </div>
    </template>
  </section>
</template>
