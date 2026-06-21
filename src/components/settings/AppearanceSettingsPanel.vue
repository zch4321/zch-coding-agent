<script setup lang="ts">
import { computed } from 'vue'
import { NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { setAppLocale, type AppLocale } from '../../i18n'

const { locale, t } = useI18n()
const languageOptions = computed(() => [
  { label: t('settings.chinese'), value: 'zh-CN' },
  { label: t('settings.english'), value: 'en-US' },
])
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
        @update:value="setAppLocale($event as AppLocale)"
      />
    </label>
  </section>
</template>
