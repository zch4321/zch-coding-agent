<script setup lang="ts">
import type { PermissionMode } from '../../../shared/config'
import AppearanceSettingsPanel from './AppearanceSettingsPanel.vue'
import LoggingSettingsPanel from './LoggingSettingsPanel.vue'
import PermissionsSettingsPanel from './PermissionsSettingsPanel.vue'
import ProjectSettingsPanel from './ProjectSettingsPanel.vue'
import ProviderSettingsPanel from './ProviderSettingsPanel.vue'
import SkillsSettingsPanel from './SkillsSettingsPanel.vue'
import WebSearchSettingsPanel from './WebSearchSettingsPanel.vue'
import type { SettingsTab } from './settings-tabs'

defineProps<{
  activeTab: SettingsTab
}>()
const emit = defineEmits<{
  close: []
  mode: [value: PermissionMode]
}>()
</script>

<template>
  <section class="settings-page">
    <div class="settings-content">
      <AppearanceSettingsPanel v-if="activeTab === 'general'" />
      <ProjectSettingsPanel
        v-else-if="activeTab === 'project'"
        @removed="emit('close')"
      />
      <ProviderSettingsPanel v-else-if="activeTab === 'provider'" />
      <PermissionsSettingsPanel
        v-else-if="activeTab === 'permissions'"
        @mode="emit('mode', $event)"
      />
      <SkillsSettingsPanel v-else-if="activeTab === 'skills'" />
      <LoggingSettingsPanel v-else-if="activeTab === 'logging'" />
      <WebSearchSettingsPanel v-else-if="activeTab === 'websearch'" />
      <LoggingSettingsPanel v-else />
    </div>
  </section>
</template>
