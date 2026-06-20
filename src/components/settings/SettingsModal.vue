<script setup lang="ts">
import { ref, watch } from 'vue'
import { NModal } from 'naive-ui'
import type { PermissionMode } from '../../../shared/config'
import UiIcon from '../UiIcon.vue'
import LoggingSettingsPanel from './LoggingSettingsPanel.vue'
import PermissionsSettingsPanel from './PermissionsSettingsPanel.vue'
import ProjectSettingsPanel from './ProjectSettingsPanel.vue'
import ProviderSettingsPanel from './ProviderSettingsPanel.vue'
import SkillsSettingsPanel from './SkillsSettingsPanel.vue'

type SettingsTab = 'project' | 'provider' | 'permissions' | 'skills' | 'logging'

const props = defineProps<{
  show: boolean
  initialTab?: SettingsTab
}>()
const emit = defineEmits<{
  'update:show': [value: boolean]
  mode: [value: PermissionMode]
}>()
const activeTab = ref<SettingsTab>('project')
const tabs: Array<{
  value: SettingsTab
  label: string
  icon: 'folder' | 'settings' | 'warning' | 'app' | 'file'
}> = [
  { value: 'project', label: 'Project', icon: 'folder' },
  { value: 'provider', label: 'Provider', icon: 'settings' },
  { value: 'permissions', label: 'Permissions', icon: 'warning' },
  { value: 'skills', label: 'Skills', icon: 'app' },
  { value: 'logging', label: 'Logging', icon: 'file' },
]

function selectTab(tab: SettingsTab) {
  activeTab.value = tab
}

watch(
  () => [props.show, props.initialTab] as const,
  ([show, initialTab]) => {
    if (show) selectTab(initialTab ?? 'project')
  },
  { immediate: true },
)
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="settings-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          type="button"
          :class="{ active: activeTab === tab.value }"
          @click="selectTab(tab.value)"
        >
          <UiIcon :name="tab.icon" />
          {{ tab.label }}
        </button>
      </nav>
      <div class="settings-content">
        <ProjectSettingsPanel
          v-if="activeTab === 'project'"
          @removed="emit('update:show', false)"
        />
        <ProviderSettingsPanel v-else-if="activeTab === 'provider'" />
        <PermissionsSettingsPanel
          v-else-if="activeTab === 'permissions'"
          @mode="emit('mode', $event)"
        />
        <SkillsSettingsPanel v-else-if="activeTab === 'skills'" />
        <LoggingSettingsPanel v-else />
      </div>
    </div>
  </NModal>
</template>
