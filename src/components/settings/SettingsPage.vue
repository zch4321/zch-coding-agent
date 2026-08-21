<script setup lang="ts">
import { computed } from 'vue'
import { NScrollbar } from 'naive-ui'
import type { PermissionMode } from '../../../shared/config'
import { findSettingsPage, type SettingsTab } from './settings-tabs'

const props = defineProps<{
  activeTab: SettingsTab
}>()
const emit = defineEmits<{
  close: []
  defaultMode: [value: PermissionMode]
}>()

const activePage = computed(() => findSettingsPage(props.activeTab))
</script>

<template>
  <section class="settings-page">
    <NScrollbar class="settings-content">
      <div class="settings-content-inner">
        <component
          :is="activePage.component"
          @default-mode="emit('defaultMode', $event)"
        />
      </div>
    </NScrollbar>
  </section>
</template>
