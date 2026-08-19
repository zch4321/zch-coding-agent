<script setup lang="ts">
import McpSettingsPanel from './McpSettingsPanel.vue'
import SkillsSettingsPanel from './SkillsSettingsPanel.vue'
import WebSearchSettingsPanel from './WebSearchSettingsPanel.vue'
</script>

<template>
  <div class="settings-domain-page" data-settings-domain="integrations">
    <SkillsSettingsPanel />
    <McpSettingsPanel />
    <WebSearchSettingsPanel />
  </div>
</template>
