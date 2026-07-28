<script setup lang="ts">
import type { PermissionMode } from '../../../shared/config'
import ApprovalSettingsPanel from './ApprovalSettingsPanel.vue'
import AppearanceSettingsPanel from './AppearanceSettingsPanel.vue'
import ArchivedSessionsSettingsPanel from './ArchivedSessionsSettingsPanel.vue'
import LoggingSettingsPanel from './LoggingSettingsPanel.vue'
import LimitsSettingsPanel from './LimitsSettingsPanel.vue'
import PermissionsSettingsPanel from './PermissionsSettingsPanel.vue'
import ProjectSettingsPanel from './ProjectSettingsPanel.vue'
import ProviderSettingsPanel from './ProviderSettingsPanel.vue'
import SkillsSettingsPanel from './SkillsSettingsPanel.vue'
import McpSettingsPanel from './McpSettingsPanel.vue'
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
      <ArchivedSessionsSettingsPanel v-else-if="activeTab === 'archived'" />
      <ProviderSettingsPanel v-else-if="activeTab === 'provider'" />
      <ApprovalSettingsPanel v-else-if="activeTab === 'approval'" />
      <LimitsSettingsPanel v-else-if="activeTab === 'limits'" />
      <PermissionsSettingsPanel
        v-else-if="activeTab === 'permissions'"
        @mode="emit('mode', $event)"
      />
      <SkillsSettingsPanel v-else-if="activeTab === 'skills'" />
      <McpSettingsPanel v-else-if="activeTab === 'mcp'" />
      <LoggingSettingsPanel v-else-if="activeTab === 'logging'" />
      <WebSearchSettingsPanel v-else-if="activeTab === 'websearch'" />
      <LoggingSettingsPanel v-else />
    </div>
  </section>
</template>
