<script setup lang="ts">
import { computed, h } from 'vue'
import { NButton, NMenu, NScrollbar, type MenuOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import UiIcon from '../UiIcon.vue'
import {
  SETTINGS_PAGES,
  SETTINGS_PAGE_GROUPS,
  type SettingsTab,
} from './settings-tabs'

defineProps<{
  activeTab: SettingsTab
}>()
const emit = defineEmits<{
  'update:activeTab': [value: SettingsTab]
  close: []
}>()
const { t } = useI18n()
const menuOptions = computed<MenuOption[]>(() =>
  SETTINGS_PAGE_GROUPS.map((group) => ({
    type: 'group',
    key: `settings-group:${group.id}`,
    label: t(group.labelKey),
    children: SETTINGS_PAGES.filter((page) => page.group === group.id).map(
      (page) => ({
        key: page.id,
        label: t(page.labelKey),
        icon: () => h(UiIcon, { name: page.icon }),
      }),
    ),
  })),
)

function selectTab(key: string | number) {
  const tab = SETTINGS_PAGES.find((candidate) => candidate.id === key)
  if (tab) emit('update:activeTab', tab.id)
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
      <NScrollbar class="settings-nav-scroll">
        <div class="settings-nav-content">
          <NMenu
            :value="activeTab"
            :options="menuOptions"
            :root-indent="12"
            :indent="12"
            @update:value="selectTab"
          />
        </div>
      </NScrollbar>
    </nav>
  </aside>
</template>
