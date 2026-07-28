<script setup lang="ts">
import { computed, h } from 'vue'
import { NButton, NMenu, type MenuOption } from 'naive-ui'
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
    icon: 'folder' | 'settings' | 'warning' | 'app' | 'file' | 'trash'
  }>
>(() => [
  { value: 'general', label: t('settings.general'), icon: 'settings' },
  { value: 'project', label: t('settings.project'), icon: 'folder' },
  { value: 'archived', label: t('settings.archived'), icon: 'trash' },
  { value: 'provider', label: t('settings.provider'), icon: 'settings' },
  { value: 'limits', label: t('settings.limits'), icon: 'settings' },
  { value: 'permissions', label: t('settings.permissions'), icon: 'warning' },
  { value: 'skills', label: t('settings.skills'), icon: 'app' },
  { value: 'mcp', label: t('settings.mcp'), icon: 'app' },
  { value: 'logging', label: t('settings.logging'), icon: 'file' },
  { value: 'websearch', label: t('settings.webSearchTitle'), icon: 'app' },
])
const menuOptions = computed<MenuOption[]>(() =>
  tabs.value.map((tab) => ({
    key: tab.value,
    label: tab.label,
    icon: () => h(UiIcon, { name: tab.icon }),
  })),
)

function selectTab(key: string | number) {
  const tab = tabs.value.find((candidate) => candidate.value === key)
  if (tab) emit('update:activeTab', tab.value)
}
</script>

<template>
  <aside class="settings-sidebar">
    <div class="settings-back-row">
      <NButton
        class="settings-back-button"
        secondary
        block
        @click="emit('close')"
      >
        <UiIcon name="arrow-left" />
        <span>{{ t('settings.backToChat') }}</span>
      </NButton>
    </div>
    <nav class="settings-nav" :aria-label="t('settings.sections')">
      <NMenu
        :value="activeTab"
        :options="menuOptions"
        :root-indent="12"
        :indent="12"
        @update:value="selectTab"
      />
    </nav>
  </aside>
</template>
