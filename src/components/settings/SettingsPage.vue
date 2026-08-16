<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import type { PermissionMode } from '../../../shared/config'
import AppearanceSettingsPanel from './AppearanceSettingsPanel.vue'
import AgentsSettingsPanel from './AgentsSettingsPanel.vue'
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
  defaultMode: [value: PermissionMode]
}>()
</script>

<template>
  <section class="settings-page">
    <NScrollbar class="settings-content">
      <div class="settings-content-inner">
        <AppearanceSettingsPanel v-if="activeTab === 'general'" />
        <ProjectSettingsPanel v-else-if="activeTab === 'project'" />
        <ArchivedSessionsSettingsPanel v-else-if="activeTab === 'archived'" />
        <ProviderSettingsPanel v-else-if="activeTab === 'provider'" />
        <LimitsSettingsPanel v-else-if="activeTab === 'limits'" />
        <AgentsSettingsPanel v-else-if="activeTab === 'agents'" />
        <PermissionsSettingsPanel
          v-else-if="activeTab === 'permissions'"
          @default-mode="emit('defaultMode', $event)"
        />
        <SkillsSettingsPanel v-else-if="activeTab === 'skills'" />
        <McpSettingsPanel v-else-if="activeTab === 'mcp'" />
        <LoggingSettingsPanel v-else-if="activeTab === 'logging'" />
        <WebSearchSettingsPanel v-else-if="activeTab === 'websearch'" />
        <LoggingSettingsPanel v-else />
      </div>
    </NScrollbar>
  </section>
</template>
