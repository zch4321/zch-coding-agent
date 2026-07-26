<script setup lang="ts">
import { computed, watch } from 'vue'
import { NBadge, NTabPane, NTabs, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'
import DiffTab from './DiffTab.vue'
import FilesTab from './FilesTab.vue'
import PlanTab from './PlanTab.vue'
import ProjectTab from './ProjectTab.vue'

type ArtifactTab = 'files' | 'diff' | 'plan' | 'project'

const agent = useAgentStore()
const { t } = useI18n()
const props = withDefaults(defineProps<{ activeTab?: ArtifactTab }>(), {
  activeTab: 'files',
})
const emit = defineEmits<{
  'update:activeTab': [tab: ArtifactTab]
}>()
const activeArtifact = computed({
  get: () => props.activeTab,
  set: (tab: ArtifactTab) => emit('update:activeTab', tab),
})

const projectName = computed(() => {
  const normalized = agent.workspacePath.replace(/\\/g, '/')
  return (
    normalized.split('/').filter(Boolean).at(-1) || t('app.chooseWorkspace')
  )
})

watch(
  () => agent.pendingApproval,
  (approval) => {
    if (approval?.diff) activeArtifact.value = 'diff'
  },
)

watch(
  () => agent.plan?.id,
  (planId, previousPlanId) => {
    if (planId && planId !== previousPlanId) activeArtifact.value = 'plan'
  },
)
</script>

<template>
  <aside class="artifact-sidebar">
    <header class="artifact-header">
      <div class="artifact-project">
        <strong>{{ projectName }}</strong>
        <NTooltip>
          <template #trigger>
            <span>{{ agent.workspacePath || t('app.noWorkspace') }}</span>
          </template>
          {{ agent.workspacePath || t('app.noWorkspace') }}
        </NTooltip>
      </div>
    </header>

    <NTabs
      v-model:value="activeArtifact"
      class="artifact-tabs"
      size="small"
      type="card"
      role="tablist"
      :aria-label="t('artifact.openFiles')"
      :animated="false"
      :tabs-padding="12"
      :pane-style="{ height: '100%', minHeight: '0' }"
      :pane-wrapper-style="{ flex: '1', minHeight: '0' }"
    >
      <NTabPane
        name="files"
        display-directive="show"
        style="height: 100%"
        :tab-props="{
          role: 'tab',
          'aria-selected': activeArtifact === 'files',
        }"
      >
        <template #tab>
          <span class="artifact-tab-label">
            <UiIcon name="explorer" />{{ t('artifact.files') }}
          </span>
        </template>
        <FilesTab />
      </NTabPane>
      <NTabPane
        name="plan"
        display-directive="show"
        style="height: 100%"
        :tab-props="{
          role: 'tab',
          'aria-selected': activeArtifact === 'plan',
        }"
      >
        <template #tab>
          <span class="artifact-tab-label">
            <UiIcon name="check" />{{ t('artifact.plan') }}
            <NBadge v-if="agent.plan" dot type="warning" />
          </span>
        </template>
        <PlanTab />
      </NTabPane>
      <NTabPane
        name="diff"
        display-directive="show"
        style="height: 100%"
        :tab-props="{
          role: 'tab',
          'aria-selected': activeArtifact === 'diff',
        }"
      >
        <template #tab>
          <span class="artifact-tab-label">
            <UiIcon name="diff" />{{ t('artifact.diff') }}
            <NBadge v-if="agent.pendingApproval?.diff" dot type="warning" />
          </span>
        </template>
        <DiffTab />
      </NTabPane>
      <NTabPane
        name="project"
        display-directive="show"
        style="height: 100%"
        :tab-props="{
          role: 'tab',
          'aria-selected': activeArtifact === 'project',
        }"
      >
        <template #tab>
          <span class="artifact-tab-label">
            <UiIcon name="settings" />{{ t('artifact.project') }}
          </span>
        </template>
        <ProjectTab />
      </NTabPane>
    </NTabs>
  </aside>
</template>
