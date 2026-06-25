<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import UiIcon from '../UiIcon.vue'
import type { SettingsTab } from './settings-tabs'

defineProps<{
  activeTab: SettingsTab
}>()
const emit = defineEmits<{
  'update:activeTab': [value: SettingsTab]
  close: []
}>()
const { t } = useI18n()
const tabs = computed<
  Array<{
    value: SettingsTab
    label: string
    icon: 'folder' | 'settings' | 'warning' | 'app' | 'file'
  }>
>(() => [
  { value: 'general', label: t('settings.general'), icon: 'settings' },
  { value: 'project', label: t('settings.project'), icon: 'folder' },
  { value: 'provider', label: t('settings.provider'), icon: 'settings' },
  { value: 'permissions', label: t('settings.permissions'), icon: 'warning' },
  { value: 'skills', label: t('settings.skills'), icon: 'app' },
  { value: 'logging', label: t('settings.logging'), icon: 'file' },
  { value: 'websearch', label: t('settings.webSearchTitle'), icon: 'app' },
])
</script>

<template>
  <aside class="settings-sidebar">
    <button class="settings-back-button" type="button" @click="emit('close')">
      <UiIcon name="arrow-left" />
      <span>{{ t('settings.backToChat') }}</span>
    </button>
    <nav class="settings-nav" :aria-label="t('settings.sections')">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        type="button"
        :class="{ active: activeTab === tab.value }"
        @click="emit('update:activeTab', tab.value)"
      >
        <UiIcon :name="tab.icon" />
        {{ tab.label }}
      </button>
    </nav>
  </aside>
</template>
