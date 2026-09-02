<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NSelect,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  NTree,
  type SelectOption,
  type TreeOption,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { IPC_VERSION } from '../../../shared/channels'
import type {
  GitReviewDiff,
  GitReviewMode,
  GitReviewStatus,
  GitReviewStatusEntry,
} from '../../../shared/git-review'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

const agent = useAgentStore()
const { t } = useI18n()

const status = ref<GitReviewStatus>()
const diff = ref<GitReviewDiff>()
const selectedPath = ref<string>()
const mode = ref<GitReviewMode>('head')
const baseRef = ref<string>()
const statusLoading = ref(false)
const diffLoading = ref(false)
const error = ref('')
let statusGeneration = 0
let diffGeneration = 0

const baseRefOptions = computed<SelectOption[]>(() =>
  (status.value?.baseRefs ?? []).map((refName) => ({
    label: refName,
    value: refName,
  })),
)
const selectedEntry = computed(() =>
  status.value?.entries.find((entry) => entry.path === selectedPath.value),
)
const treeData = computed<TreeOption[]>(() =>
  (status.value?.entries ?? []).map((entry) => ({
    key: entry.path,
    label: entry.path,
    entry,
  })),
)
const baselineLabel = computed(() => {
  if (mode.value !== 'merge_base') return t(`artifact.gitMode.${mode.value}`)
  return diff.value?.baseOid
    ? `${baseRef.value} · ${diff.value.baseOid.slice(0, 8)}`
    : (baseRef.value ?? t('artifact.selectBaseRef'))
})

function statusType(entry: GitReviewStatusEntry) {
  if (entry.kind === 'deleted' || entry.kind === 'unmerged') return 'error'
  if (entry.kind === 'untracked' || entry.kind === 'added') return 'success'
  if (entry.kind === 'renamed' || entry.kind === 'copied') return 'info'
  return 'warning'
}

function renderStatusLabel({ option }: { option: TreeOption }) {
  const entry = option.entry as GitReviewStatusEntry
  return h('span', { class: 'git-change-label' }, [
    h(
      NTag,
      { size: 'tiny', bordered: false, type: statusType(entry) },
      { default: () => `${entry.indexStatus}${entry.worktreeStatus}` },
    ),
    h('span', { title: entry.path }, entry.path),
  ])
}

function preferredBaseRef(next: GitReviewStatus): string | undefined {
  if (next.upstreamRef && next.baseRefs.includes(next.upstreamRef)) {
    return next.upstreamRef
  }
  return (
    ['origin/main', 'origin/master', 'main', 'master'].find((candidate) =>
      next.baseRefs.includes(candidate),
    ) ?? next.baseRefs.find((candidate) => candidate !== next.headRef)
  )
}

async function refreshStatus() {
  const generation = ++statusGeneration
  diffGeneration += 1
  const api = window.agentApi
  const projectId = agent.selectedProjectId
  if (!api || !projectId) {
    status.value = undefined
    diff.value = undefined
    statusLoading.value = false
    diffLoading.value = false
    error.value = ''
    return
  }
  statusLoading.value = true
  diffLoading.value = false
  diff.value = undefined
  error.value = ''
  const result = await api.getGitReviewStatus({
    version: IPC_VERSION,
    projectId,
  })
  if (generation !== statusGeneration) return
  statusLoading.value = false
  if (!result.ok) {
    error.value = result.error.message
    status.value = undefined
    diff.value = undefined
    return
  }
  status.value = result.value
  if (
    !result.value.entries.some((entry) => entry.path === selectedPath.value)
  ) {
    selectedPath.value = result.value.entries[0]?.path
  }
  if (!baseRef.value || !result.value.baseRefs.includes(baseRef.value)) {
    baseRef.value = preferredBaseRef(result.value)
  }
  await refreshDiff()
}

async function refreshDiff() {
  const generation = ++diffGeneration
  const api = window.agentApi
  const projectId = agent.selectedProjectId
  if (!api || !projectId || !status.value?.repository) {
    diff.value = undefined
    diffLoading.value = false
    return
  }
  if (mode.value === 'merge_base' && !baseRef.value) {
    diff.value = undefined
    diffLoading.value = false
    return
  }
  diffLoading.value = true
  error.value = ''
  const result = await api.getGitReviewDiff({
    version: IPC_VERSION,
    projectId,
    mode: mode.value,
    ...(selectedPath.value ? { path: selectedPath.value } : {}),
    ...(mode.value === 'merge_base' && baseRef.value
      ? { baseRef: baseRef.value }
      : {}),
  })
  if (generation !== diffGeneration) return
  diffLoading.value = false
  if (!result.ok) {
    error.value = result.error.message
    diff.value = undefined
    return
  }
  diff.value = result.value
}

function selectPaths(keys: Array<string | number>) {
  selectedPath.value = typeof keys[0] === 'string' ? keys[0] : undefined
  void refreshDiff()
}

watch(
  () => [agent.selectedProjectId, agent.workspacePath] as const,
  () => {
    status.value = undefined
    diff.value = undefined
    selectedPath.value = undefined
    baseRef.value = undefined
    void refreshStatus()
  },
  { immediate: true },
)
watch(
  () => agent.workspaceFileRevision,
  () => void refreshStatus(),
)
watch(mode, () => void refreshDiff())
watch(baseRef, () => {
  if (mode.value === 'merge_base') void refreshDiff()
})
</script>

<template>
  <section class="artifact-content diff-view git-review-view">
    <header class="git-review-header">
      <div>
        <strong>{{ t('artifact.gitChanges') }}</strong>
        <small v-if="status?.repository">
          {{
            status.headRef ??
            status.headOid?.slice(0, 8) ??
            t('artifact.unbornHead')
          }}
        </small>
      </div>
      <NButton
        quaternary
        circle
        size="small"
        :loading="statusLoading"
        :aria-label="t('artifact.refreshGit')"
        @click="refreshStatus"
      >
        <UiIcon name="refresh" />
      </NButton>
    </header>

    <NAlert v-if="error" type="error" :show-icon="false">{{ error }}</NAlert>
    <NSpin v-if="statusLoading && !status" class="git-review-loading" />
    <NEmpty
      v-else-if="status && !status.repository"
      class="artifact-empty"
      :description="t('artifact.notGitRepository')"
    >
      <template #icon><UiIcon name="git-branch" /></template>
      <template #extra>
        <span class="artifact-empty-hint">{{
          t('artifact.gitRequiredHint')
        }}</span>
      </template>
    </NEmpty>
    <template v-else-if="status?.repository">
      <div class="git-review-status">
        <NTree
          v-if="treeData.length"
          block-line
          :data="treeData"
          :selected-keys="selectedPath ? [selectedPath] : []"
          :render-label="renderStatusLabel"
          @update:selected-keys="selectPaths"
        />
        <NEmpty
          v-else
          size="small"
          :description="t('artifact.cleanWorkingTree')"
        />
        <NTag v-if="status.truncated" size="small" type="warning">
          {{ t('artifact.statusTruncated') }}
        </NTag>
      </div>

      <div class="git-review-controls">
        <NTabs v-model:value="mode" type="segment" size="small" animated>
          <NTabPane name="head" :tab="t('artifact.gitMode.head')" />
          <NTabPane name="unstaged" :tab="t('artifact.gitMode.unstaged')" />
          <NTabPane name="staged" :tab="t('artifact.gitMode.staged')" />
          <NTabPane name="merge_base" :tab="t('artifact.gitMode.merge_base')" />
        </NTabs>
        <NSelect
          v-if="mode === 'merge_base'"
          v-model:value="baseRef"
          size="small"
          filterable
          :options="baseRefOptions"
          :placeholder="t('artifact.selectBaseRef')"
        />
      </div>

      <div class="diff-summary git-diff-summary">
        <span class="diff-summary-label">{{ baselineLabel }}</span>
        <strong>{{ selectedPath ?? t('artifact.allProjectChanges') }}</strong>
        <small v-if="selectedEntry?.originalPath">
          {{ selectedEntry.originalPath }} → {{ selectedEntry.path }}
        </small>
        <NTag v-if="diff?.binary" size="small" type="info">
          {{ t('artifact.binaryDiff') }}
        </NTag>
        <NTag v-if="diff?.truncated" size="small" type="warning">
          {{ t('artifact.truncated') }}
        </NTag>
      </div>
      <NSpin v-if="diffLoading" class="git-review-loading" />
      <pre v-else-if="diff?.content" class="diff-content">{{
        diff.content
      }}</pre>
      <NEmpty
        v-else
        class="git-diff-empty"
        size="small"
        :description="
          selectedEntry?.kind === 'untracked'
            ? t('artifact.untrackedNoDiff')
            : t('artifact.noGitDiff')
        "
      />
    </template>
  </section>
</template>
