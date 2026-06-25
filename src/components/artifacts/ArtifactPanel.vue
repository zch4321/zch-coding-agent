<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import {
  NButton,
  NSelect,
  NTooltip,
  NTree,
  type SelectOption,
  type TreeOption,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { IPC_VERSION } from '../../../shared/channels'
import type { FileChangeRecord } from '../../../shared/change-history'
import type { PlanItem } from '../../../shared/orchestration'
import { useAgentStore } from '../../stores/agent'
import FileCodePreview from './FileCodePreview.vue'
import UiIcon from '../UiIcon.vue'

type ArtifactTab = 'files' | 'diff' | 'plan'
type ChangeStatusFilter = 'all' | 'active' | 'reverted'

interface ExplorerEntry {
  path: string
  name: string
  type: 'file' | 'directory'
}

interface OpenFile {
  path: string
  content: string
  totalBytes: number
  truncated: boolean
}

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
const explorerTree = ref<TreeOption[]>([])
const explorerLoading = ref(false)
const explorerError = ref('')
const explorerTruncated = ref(false)
const openedFiles = ref<OpenFile[]>([])
const activeFilePath = ref('explorer')
const selectedChangeId = ref<string>()
const filterRunId = ref<string | undefined>(undefined)
const filterPath = ref<string | undefined>(undefined)
const filterStatus = ref<ChangeStatusFilter>('all')
let directoryRequestGeneration = 0
let fileRequestGeneration = 0

const projectName = computed(() => {
  const normalized = agent.workspacePath.replace(/\\/g, '/')
  return (
    normalized.split('/').filter(Boolean).at(-1) || t('app.chooseWorkspace')
  )
})
const activeFile = computed(() =>
  openedFiles.value.find((file) => file.path === activeFilePath.value),
)
const selectedChange = computed(
  () =>
    agent.changes.find((change) => change.id === selectedChangeId.value) ??
    filteredChanges.value[0],
)
const planProgress = computed(() => {
  const items = agent.plan?.items ?? []
  const completed = items.filter((item) => item.status === 'completed').length
  return { completed, total: items.length }
})
const runOptions = computed<SelectOption[]>(() => {
  const runs = new Map<string, number>()
  for (const change of agent.changes) {
    runs.set(change.runId, (runs.get(change.runId) ?? 0) + 1)
  }
  return [
    { label: t('artifact.filterAll'), value: undefined },
    ...[...runs.entries()].map(([runId, count]) => ({
      label: `${runId} (${count})`,
      value: runId,
    })),
  ]
})
const pathOptions = computed<SelectOption[]>(() => {
  const paths = new Map<string, number>()
  for (const change of agent.changes) {
    paths.set(change.path, (paths.get(change.path) ?? 0) + 1)
  }
  return [
    { label: t('artifact.filterAll'), value: undefined },
    ...[...paths.entries()].map(([path, count]) => ({
      label: `${path} (${count})`,
      value: path,
    })),
  ]
})
const statusOptions = computed<SelectOption[]>(
  () =>
    [
      { label: t('artifact.filterAll'), value: 'all' },
      { label: t('artifact.filterActive'), value: 'active' },
      { label: t('artifact.filterReverted'), value: 'reverted' },
    ] as SelectOption[],
)
const filteredChanges = computed(() =>
  agent.changes.filter((change) => {
    if (filterRunId.value && change.runId !== filterRunId.value) return false
    if (filterPath.value && change.path !== filterPath.value) return false
    if (filterStatus.value === 'active' && change.revertedAt) return false
    if (filterStatus.value === 'reverted' && !change.revertedAt) return false
    return true
  }),
)
function planStatusClass(item: PlanItem): string {
  return `status-${item.status.replace(/_/g, '-')}`
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString()
}

function toTreeOptions(entries: ExplorerEntry[]): TreeOption[] {
  return entries.map((entry) => ({
    key: entry.path,
    label: entry.name,
    path: entry.path,
    entryType: entry.type,
    isLeaf: entry.type === 'file',
  }))
}

async function fetchDirectory(
  path: string,
  generation: number,
): Promise<TreeOption[] | undefined> {
  const bridge = window.agentApi
  const workspace = agent.workspacePath
  if (!bridge || !workspace) {
    return undefined
  }

  explorerError.value = ''
  const result = await bridge.listWorkspaceDirectory({
    version: IPC_VERSION,
    workspace,
    path,
  })

  if (
    generation !== directoryRequestGeneration ||
    workspace !== agent.workspacePath ||
    (result.ok && result.value.workspace !== workspace)
  ) {
    return
  }

  if (result.ok) {
    if (result.value.truncated) explorerTruncated.value = true
    return toTreeOptions(result.value.entries)
  } else {
    explorerError.value = result.error.message
    return undefined
  }
}

async function loadRootDirectory(generation: number) {
  explorerLoading.value = true
  const children = await fetchDirectory('.', generation)
  if (generation !== directoryRequestGeneration) return
  explorerLoading.value = false
  if (children) explorerTree.value = children
}

async function loadTreeNode(option: TreeOption) {
  if (option.entryType !== 'directory' || typeof option.path !== 'string') {
    return true
  }

  const generation = directoryRequestGeneration
  const children = await fetchDirectory(option.path, generation)
  if (!children || generation !== directoryRequestGeneration) return false
  option.children = children
  return true
}

function treeClickBehavior({ option }: { option: TreeOption }) {
  return option.entryType === 'directory' ? 'toggleExpand' : 'toggleSelect'
}

function renderTreePrefix({ option }: { option: TreeOption }) {
  return h(UiIcon, {
    name: option.entryType === 'directory' ? 'folder' : 'file',
  })
}

async function openExplorerFile(path: string) {
  const bridge = window.agentApi
  const workspace = agent.workspacePath
  const generation = ++fileRequestGeneration
  if (!bridge || !workspace) return
  explorerError.value = ''
  const result = await bridge.readWorkspaceFile({
    version: IPC_VERSION,
    workspace,
    path,
  })

  if (
    generation !== fileRequestGeneration ||
    workspace !== agent.workspacePath ||
    (result.ok && result.value.workspace !== workspace)
  ) {
    return
  }

  if (!result.ok) {
    explorerError.value = result.error.message
    return
  }

  const existing = openedFiles.value.find(
    (file) => file.path === result.value.path,
  )
  if (existing) Object.assign(existing, result.value)
  else openedFiles.value.push(result.value)
  activeFilePath.value = result.value.path
  activeArtifact.value = 'files'
}

function handleTreeSelection(
  _keys: Array<string | number>,
  options: Array<TreeOption | null>,
) {
  const option = options.at(-1)
  if (option?.entryType === 'file' && typeof option.path === 'string') {
    void openExplorerFile(option.path)
  }
}

function closeFile(path: string) {
  const index = openedFiles.value.findIndex((file) => file.path === path)
  openedFiles.value = openedFiles.value.filter((file) => file.path !== path)
  if (activeFilePath.value === path) {
    activeFilePath.value =
      openedFiles.value[Math.max(0, index - 1)]?.path ?? 'explorer'
  }
}

async function revertChange(change: FileChangeRecord) {
  if (!window.confirm(t('artifact.revertConfirm', { path: change.path }))) {
    return
  }
  await agent.revertChange(change.id)
}

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

watch(
  () => agent.workspacePath,
  (workspace, previous) => {
    directoryRequestGeneration += 1
    fileRequestGeneration += 1
    explorerLoading.value = false
    explorerError.value = ''
    explorerTree.value = []
    explorerTruncated.value = false

    if (workspace && workspace !== previous) {
      openedFiles.value = []
      activeFilePath.value = 'explorer'
      void loadRootDirectory(directoryRequestGeneration)
    } else if (!workspace) {
      explorerTree.value = []
      openedFiles.value = []
    }
  },
  { immediate: true },
)

watch(
  () => [agent.activeConversationId, agent.workspacePath] as const,
  () => {
    filterRunId.value = undefined
    filterPath.value = undefined
    filterStatus.value = 'all'
    void agent.loadConversationChanges()
  },
  { immediate: true },
)

watch(
  () => agent.changes,
  (changes) => {
    if (!changes.some((change) => change.id === selectedChangeId.value)) {
      selectedChangeId.value = changes[0]?.id
    }
  },
  { deep: true },
)

watch(
  () => agent.workspaceFileRevision,
  () => {
    directoryRequestGeneration += 1
    explorerTree.value = []
    void loadRootDirectory(directoryRequestGeneration)
    if (activeFile.value) void openExplorerFile(activeFile.value.path)
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
      </nav>
    </header>

    <section v-if="activeArtifact === 'files'" class="artifact-content">
      <div
        class="file-tabs"
        role="tablist"
        :aria-label="t('artifact.openFiles')"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="activeFilePath === 'explorer'"
          :class="{ active: activeFilePath === 'explorer' }"
          @click="activeFilePath = 'explorer'"
        >
          <UiIcon name="explorer" />{{ t('artifact.explorer') }}
        </button>
        <div
          v-for="file in openedFiles"
          :key="file.path"
          class="file-tab"
          :class="{ active: activeFilePath === file.path }"
        >
          <NTooltip>
            <template #trigger>
              <button
                class="file-tab-label"
                type="button"
                role="tab"
                :aria-selected="activeFilePath === file.path"
                @click="activeFilePath = file.path"
              >
                <UiIcon name="file" />
                <span>{{ file.path.split('/').at(-1) }}</span>
              </button>
            </template>
            {{ file.path }}
          </NTooltip>
          <button
            class="tab-close"
            type="button"
            :aria-label="t('artifact.closeFile')"
            @click="closeFile(file.path)"
          >
            <UiIcon name="close" />
          </button>
        </div>
      </div>

      <div v-if="activeFilePath === 'explorer'" class="explorer-view">
        <div v-if="!agent.workspacePath" class="artifact-empty">
          <UiIcon name="folder" />
          <p>{{ t('artifact.chooseHint') }}</p>
        </div>
        <div v-else class="explorer-tree-state">
          <p v-if="explorerLoading" class="artifact-message">
            {{ t('artifact.loading') }}
          </p>
          <p v-if="explorerError" class="artifact-message error">
            {{ explorerError }}
          </p>
          <NTree
            v-if="explorerTree.length"
            class="explorer-tree"
            :data="explorerTree"
            :on-load="loadTreeNode"
            :render-prefix="renderTreePrefix"
            :override-default-node-click-behavior="treeClickBehavior"
            block-line
            show-line
            virtual-scroll
            @update:selected-keys="handleTreeSelection"
          />
          <p
            v-else-if="!explorerLoading && !explorerError"
            class="artifact-message"
          >
            {{ t('artifact.emptyDirectory') }}
          </p>
          <p v-if="explorerTruncated" class="artifact-message">
            {{ t('artifact.truncatedList') }}
          </p>
        </div>
      </div>

      <div v-else-if="activeFile" class="file-viewer">
        <div class="file-viewer-header">
          <div>
            <strong>{{ activeFile.path }}</strong>
            <span>
              {{ t('artifact.readonly') }} ·
              {{
                t('artifact.bytes', {
                  count: activeFile.totalBytes.toLocaleString(),
                })
              }}
            </span>
          </div>
          <span v-if="activeFile.truncated" class="truncated-badge">
            {{ t('artifact.truncated') }}
          </span>
        </div>
        <FileCodePreview
          :path="activeFile.path"
          :content="activeFile.content"
        />
      </div>
    </section>

    <section
      v-else-if="activeArtifact === 'diff'"
      class="artifact-content diff-view"
    >
      <template v-if="agent.pendingApproval?.diff">
        <div class="diff-summary">
          <span>{{ t('artifact.pendingChange') }}</span>
          <strong>{{ agent.pendingApproval.tool }}</strong>
          <p>{{ agent.pendingApproval.reason }}</p>
          <code v-if="agent.pendingApproval.diffHash">
            {{ agent.pendingApproval.diffHash }}
          </code>
        </div>
        <pre class="diff-content">{{ agent.pendingApproval.diff }}</pre>
        <div class="diff-actions">
          <NButton
            type="primary"
            :loading="agent.approvalSubmitting"
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('allow')"
          >
            {{ t('common.approve') }}
          </NButton>
          <NButton
            secondary
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('deny')"
          >
            {{ t('common.deny') }}
          </NButton>
        </div>
      </template>
      <template v-else-if="agent.changes.length && selectedChange">
        <div class="change-history-header">
          <div>
            <strong>{{ t('artifact.changeHistory') }}</strong>
            <span>{{
              t('artifact.changeCount', { count: agent.changes.length })
            }}</span>
          </div>
          <span v-if="agent.changesLoading">{{ t('common.loading') }}</span>
        </div>
        <div class="change-filters">
          <NSelect
            v-model:value="filterRunId"
            :options="runOptions"
            :placeholder="t('artifact.filterByRun')"
            size="small"
            filterable
            class="change-filter-select"
          />
          <NSelect
            v-model:value="filterPath"
            :options="pathOptions"
            :placeholder="t('artifact.filterByFile')"
            size="small"
            filterable
            class="change-filter-select"
          />
          <NSelect
            v-model:value="filterStatus"
            :options="statusOptions"
            :placeholder="t('artifact.filterByStatus')"
            size="small"
            class="change-filter-select"
          />
        </div>
        <div
          v-if="filteredChanges.length"
          class="change-history-list"
          role="list"
        >
          <button
            v-for="change in filteredChanges"
            :key="change.id"
            type="button"
            :class="{ active: change.id === selectedChange.id }"
            role="listitem"
            @click="selectedChangeId = change.id"
          >
            <span>{{ change.path }}</span>
            <small>
              {{ t(`artifact.operation.${change.operation}`) }} ·
              {{ new Date(change.createdAt).toLocaleString() }}
            </small>
            <em v-if="change.revertedAt">{{ t('artifact.reverted') }}</em>
          </button>
        </div>
        <p v-else class="artifact-message">
          {{ t('artifact.noFilteredChanges') }}
        </p>
        <div class="diff-summary">
          <span>{{ t(`artifact.operation.${selectedChange.operation}`) }}</span>
          <strong>{{ selectedChange.path }}</strong>
          <code v-if="selectedChange.diffHash">{{
            selectedChange.diffHash
          }}</code>
        </div>
        <pre class="diff-content">{{ selectedChange.diff }}</pre>
        <div class="diff-actions">
          <NButton
            type="warning"
            :loading="agent.revertingChangeId === selectedChange.id"
            :disabled="
              Boolean(selectedChange.revertedAt) ||
              Boolean(agent.revertingChangeId) ||
              Boolean(agent.activeRunId) ||
              Boolean(agent.pendingApproval)
            "
            @click="revertChange(selectedChange)"
          >
            {{
              selectedChange.revertedAt
                ? t('artifact.reverted')
                : t('artifact.revert')
            }}
          </NButton>
          <small>{{ t('artifact.revertSafetyHint') }}</small>
        </div>
      </template>
      <template v-else-if="agent.latestReviewedApproval?.diff">
        <div class="diff-summary">
          <span>
            {{
              t('artifact.reviewed', {
                decision: agent.latestReviewedApproval.decision,
              })
            }}
          </span>
          <strong>{{ agent.latestReviewedApproval.tool }}</strong>
          <p>{{ agent.latestReviewedApproval.reason }}</p>
        </div>
        <pre class="diff-content">{{ agent.latestReviewedApproval.diff }}</pre>
      </template>
      <div v-else class="artifact-empty">
        <UiIcon name="diff" />
        <h2>{{ t('artifact.noDiff') }}</h2>
        <p>{{ t('artifact.noDiffHint') }}</p>
      </div>
    </section>

    <section v-else class="artifact-content plan-view">
      <template v-if="agent.plan">
        <header class="plan-panel-header">
          <div>
            <span>{{ t('artifact.plan') }}</span>
            <strong>{{ agent.plan.objective }}</strong>
          </div>
          <small>
            {{
              t('artifact.planProgress', {
                completed: planProgress.completed,
                total: planProgress.total,
              })
            }}
          </small>
        </header>
        <p v-if="agent.plan.warning" class="plan-warning">
          <UiIcon name="warning" />{{ agent.plan.warning }}
        </p>
        <ol v-if="agent.plan.items.length" class="artifact-plan-list">
          <li
            v-for="item in agent.plan.items"
            :key="item.id"
            :class="planStatusClass(item)"
          >
            <div class="plan-item-main">
              <span class="plan-status-dot" aria-hidden="true"></span>
              <div>
                <strong>{{ item.title }}</strong>
                <small>
                  {{ t(`artifact.planStatus.${item.status}`) }} ·
                  {{ formatTimestamp(item.updatedAt) }}
                </small>
              </div>
            </div>
            <p v-if="item.result">{{ item.result }}</p>
            <p v-if="item.evidence" class="plan-evidence">
              {{ item.evidence }}
            </p>
          </li>
        </ol>
        <p v-else class="artifact-message">{{ t('artifact.planNoItems') }}</p>
        <footer class="plan-panel-footer">
          <span>
            {{
              t('artifact.planContinuations', {
                count: agent.plan.continuationCount,
              })
            }}
          </span>
          <span>{{ formatTimestamp(agent.plan.updatedAt) }}</span>
        </footer>
      </template>
      <div v-else class="artifact-empty">
        <UiIcon name="check" />
        <h2>{{ t('artifact.noPlan') }}</h2>
        <p>{{ t('artifact.noPlanHint') }}</p>
      </div>
    </section>
  </aside>
</template>
