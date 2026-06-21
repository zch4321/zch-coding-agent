<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { setAppLocale, type AppLocale } from '../../i18n'
import { DEFAULT_SYSTEM_PROMPTS } from '../../../shared/system-prompts'
import { useAgentStore } from '../../stores/agent'

const { locale, t } = useI18n()
const agent = useAgentStore()
const languageOptions = computed(() => [
  { label: t('settings.chinese'), value: 'zh-CN' },
  { label: t('settings.english'), value: 'en-US' },
])

async function changeLanguage(value: AppLocale) {
  const previous = locale.value as AppLocale
  setAppLocale(value)
  if (!(await agent.saveAssistantSettings(value))) {
    setAppLocale(previous)
  }
}

function restoreDefaultPrompts() {
  agent.assistantForm.systemPrompts = structuredClone(DEFAULT_SYSTEM_PROMPTS)
  agent.assistantSaveStatus = ''
}
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('settings.appearanceTitle') }}</h2>
      <p>{{ t('settings.languageHint') }}</p>
    </div>
    <label class="settings-field">
      <span>{{ t('settings.language') }}</span>
      <NSelect
        :value="locale"
        :options="languageOptions"
        @update:value="changeLanguage($event as AppLocale)"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('settings.systemPromptZh') }}</span>
      <NInput
        v-model:value="agent.assistantForm.systemPrompts['zh-CN']"
        type="textarea"
        :autosize="{ minRows: 6, maxRows: 12 }"
        :placeholder="DEFAULT_SYSTEM_PROMPTS['zh-CN']"
        @update:value="agent.assistantSaveStatus = ''"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('settings.systemPromptEn') }}</span>
      <NInput
        v-model:value="agent.assistantForm.systemPrompts['en-US']"
        type="textarea"
        :autosize="{ minRows: 6, maxRows: 12 }"
        :placeholder="DEFAULT_SYSTEM_PROMPTS['en-US']"
        @update:value="agent.assistantSaveStatus = ''"
      />
    </label>
    <p class="settings-footnote">{{ t('settings.systemPromptHint') }}</p>
    <div class="settings-actions">
      <NButton
        type="primary"
        :loading="agent.assistantSaving"
        :disabled="
          agent.assistantSaving ||
          !agent.assistantForm.systemPrompts['zh-CN'].trim() ||
          !agent.assistantForm.systemPrompts['en-US'].trim()
        "
        @click="agent.saveAssistantSettings(locale as AppLocale)"
      >
        {{ t('settings.saveSystemPrompts') }}
      </NButton>
      <NButton
        secondary
        :disabled="agent.assistantSaving"
        @click="restoreDefaultPrompts"
      >
        {{ t('settings.restoreSystemPrompts') }}
      </NButton>
      <small class="settings-save-status" aria-live="polite">
        {{ agent.assistantSaveStatus === 'saved' ? t('settings.saved') : '' }}
      </small>
    </div>
  </section>
</template>
