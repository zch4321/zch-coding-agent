<script setup lang="ts">
import type { PermissionMode } from '../../../shared/config/security'
import PermissionsSettingsPanel from './PermissionsSettingsPanel.vue'

const emit = defineEmits<{
  defaultMode: [value: PermissionMode]
}>()
</script>

<template>
  <div class="settings-domain-page" data-settings-domain="security">
    <PermissionsSettingsPanel @default-mode="emit('defaultMode', $event)" />
  </div>
</template>
