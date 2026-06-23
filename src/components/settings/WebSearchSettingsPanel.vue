<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInputNumber, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentSettingsStore } from '../../stores/agent-settings'

const settings = useAgentSettingsStore()
const { t } = useI18n()

const providerOptions = computed(() => [
  { label: t('settings.webSearchProviderBrave'), value: 'brave' },
  { label: t('settings.webSearchProviderSerper'), value: 'serper' },
  { label: t('settings.webSearchProviderTavily'), value: 'tavily' },
])
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('settings.webSearchTitle') }}</h2>
      <p>{{ t('settings.webSearchHint') }}</p>
    </div>
    <label class="settings-field">
      <span>{{ t('settings.webSearchProvider') }}</span>
      <NSelect
        v-model:value="settings.webSearchForm.provider"
        :options="providerOptions"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('settings.webSearchCount') }}</span>
      <NInputNumber
        v-model:value="settings.webSearchForm.count"
        :min="1"
        :max="20"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('settings.webSearchApiKey') }}</span>
      <input
        v-model="settings.webSearchForm.apiKey"
        type="password"
        autocomplete="off"
        :placeholder="
          settings.webSearchCredentialConfigured
            ? t('settings.webSearchApiKeyPlaceholder')
            : ''
        "
      />
    </label>
    <p class="settings-footnote">
      <span v-if="settings.webSearchCredentialConfigured">
        {{ t('settings.webSearchCredentialStored') }}
      </span>
      <span v-else>{{ t('settings.webSearchCredentialNone') }}</span>
    </p>
    <div class="settings-inline">
      <NButton
        type="primary"
        :loading="settings.webSearchSaving"
        @click="settings.saveWebSearchSettings()"
      >
        {{ t('settings.saved') }}
      </NButton>
      <NButton
        v-if="settings.webSearchCredentialConfigured"
        secondary
        @click="settings.clearWebSearchCredential()"
      >
        {{ t('settings.webSearchClearCredential') }}
      </NButton>
    </div>
  </section>
</template>
