<script setup lang="ts">
import AgentsSettingsPanel from './AgentsSettingsPanel.vue'
import LimitsSettingsPanel from './LimitsSettingsPanel.vue'
</script>

<template>
  <div class="settings-domain-page" data-settings-domain="runtime">
    <AgentsSettingsPanel />
    <LimitsSettingsPanel />
  </div>
</template>
