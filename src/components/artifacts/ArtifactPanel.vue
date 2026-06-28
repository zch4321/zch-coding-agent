<script setup lang="ts">
import { computed, watch } from 'vue'
import { NTooltip } from 'naive-ui'
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
      <nav
        class="artifact-tabs"
        :aria-label="t('artifact.openFiles')"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="activeArtifact === 'files'"
          :class="{ active: activeArtifact === 'files' }"
          @click="activeArtifact = 'files'"
        >
          <UiIcon name="explorer" />{{ t('artifact.files') }}
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeArtifact === 'plan'"
          :class="{ active: activeArtifact === 'plan' }"
          @click="activeArtifact = 'plan'"
        >
          <UiIcon name="check" />{{ t('artifact.plan') }}
          <span v-if="agent.plan" class="tab-dot"></span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeArtifact === 'diff'"
          :class="{ active: activeArtifact === 'diff' }"
          @click="activeArtifact = 'diff'"
        >
          <UiIcon name="diff" />{{ t('artifact.diff') }}
          <span v-if="agent.pendingApproval?.diff" class="tab-dot"></span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeArtifact === 'project'"
          :class="{ active: activeArtifact === 'project' }"
          @click="activeArtifact = 'project'"
        >
          <UiIcon name="settings" />{{ t('artifact.project') }}
        </button>
      </nav>
    </header>

    <FilesTab v-show="activeArtifact === 'files'" />
    <PlanTab v-show="activeArtifact === 'plan'" />
    <DiffTab v-show="activeArtifact === 'diff'" />
    <ProjectTab v-show="activeArtifact === 'project'" />
  </aside>
</template>
