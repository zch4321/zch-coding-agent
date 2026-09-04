<script setup lang="ts">
import { computed, watch } from 'vue'
import { NBadge, NTabPane, NTabs, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'
import DiffTab from './DiffTab.vue'
import FilesTab from './FilesTab.vue'
import PlanTab from './PlanTab.vue'
import AgentsTab from './AgentsTab.vue'
import { useAgentExecutionStore } from '../../stores/agent-executions'

type ArtifactTab = 'files' | 'diff' | 'plan' | 'agents'

const agent = useAgentStore()
const agentExecutions = useAgentExecutionStore()
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
      type="line"
      role="tablist"
      :aria-label="t('artifact.panels')"
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
        name="agents"
        display-directive="show"
        style="height: 100%"
        :tab-props="{
          role: 'tab',
          'aria-selected': activeArtifact === 'agents',
        }"
      >
        <template #tab>
          <span class="artifact-tab-label">
            <UiIcon name="agents" />{{ t('artifact.agents') }}
            <NBadge
              v-if="agentExecutions.selectedActiveCount"
              :value="agentExecutions.selectedActiveCount"
              :max="99"
              type="info"
            />
          </span>
        </template>
        <AgentsTab />
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
          </span>
        </template>
        <DiffTab />
      </NTabPane>
    </NTabs>
  </aside>
</template>
