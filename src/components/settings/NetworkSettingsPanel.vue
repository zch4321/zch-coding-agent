<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'

type ProxyMode = 'off' | 'system' | 'manual'

const agent = useAgentStore()
const { t } = useI18n()
const proxyModeOptions = computed(() => [
  { label: t('settings.networkProxyOff'), value: 'off' },
  { label: t('settings.networkProxySystem'), value: 'system' },
  { label: t('settings.networkProxyManual'), value: 'manual' },
])
const proxyMode = computed<ProxyMode>({
  get: () => agent.networkConfig.httpProxy.mode,
  set: (mode) => {
    if (mode === 'manual') {
      const current = agent.networkConfig.httpProxy
      agent.networkConfig.httpProxy = {
        mode,
        url: current.mode === 'manual' ? current.url : '',
      }
      return
    }
    agent.networkConfig.httpProxy = { mode }
  },
})
const manualProxyUrl = computed({
  get: () =>
    agent.networkConfig.httpProxy.mode === 'manual'
      ? agent.networkConfig.httpProxy.url
      : '',
  set: (url: string) => {
    agent.networkConfig.httpProxy = { mode: 'manual', url }
  },
})
const manualProxyInvalid = computed(
  () => proxyMode.value === 'manual' && !manualProxyUrl.value.trim(),
)
</script>

<template>
  <div class="settings-domain-page" data-settings-domain="network">
    <section class="settings-section">
      <div class="settings-heading">
        <h2>{{ t('settings.networkTitle') }}</h2>
        <p>{{ t('settings.networkHint') }}</p>
      </div>
      <label class="settings-field">
        <span>{{ t('settings.networkProxyMode') }}</span>
        <NSelect v-model:value="proxyMode" :options="proxyModeOptions" />
        <small>{{ t('settings.networkProxyModeHint') }}</small>
      </label>
      <label v-if="proxyMode === 'manual'" class="settings-field">
        <span>{{ t('settings.networkProxyUrl') }}</span>
        <NInput
          v-model:value="manualProxyUrl"
          :placeholder="t('settings.networkProxyUrlPlaceholder')"
          :status="manualProxyInvalid ? 'error' : undefined"
          autocomplete="off"
        />
        <small v-if="manualProxyInvalid" class="settings-field-error">
          {{ t('settings.networkProxyUrlRequired') }}
        </small>
        <small v-else>{{ t('settings.networkProxyUrlHint') }}</small>
      </label>
      <div class="settings-actions">
        <NButton
          type="primary"
          :loading="agent.networkSaving"
          :disabled="!agent.networkDirty || manualProxyInvalid"
          @click="agent.saveNetwork"
        >
          {{ t('settings.saveNetwork') }}
        </NButton>
        <small class="settings-save-status" aria-live="polite">
          {{
            agent.networkDirty
              ? t('settings.unsaved')
              : agent.networkSaveStatus === 'saved'
                ? t('settings.saved')
                : agent.networkSaveStatus
          }}
        </small>
      </div>
    </section>
  </div>
</template>
