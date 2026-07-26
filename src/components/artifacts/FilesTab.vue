<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import {
  NAlert,
  NEmpty,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
  NTree,
  type TreeOption,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { IPC_VERSION } from '../../../shared/channels'
import { useAgentStore } from '../../stores/agent'
import { useNotificationStore } from '../../stores/notifications'
import UiIcon from '../UiIcon.vue'
import FileCodePreview from './FileCodePreview.vue'

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
const notifications = useNotificationStore()
const { t } = useI18n()

const explorerTree = ref<TreeOption[]>([])
const explorerLoading = ref(false)
const explorerError = ref('')
const explorerTruncated = ref(false)
const openedFiles = ref<OpenFile[]>([])
const activeFilePath = ref('explorer')
let directoryRequestGeneration = 0
let fileRequestGeneration = 0

const activeFile = computed(() =>
  openedFiles.value.find((file) => file.path === activeFilePath.value),
)

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
  const projectId = agent.selectedProjectId
  if (!bridge || !workspace || !projectId) {
    return undefined
  }

  explorerError.value = ''
  const result = await bridge.listWorkspaceDirectory({
    version: IPC_VERSION,
    projectId,
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
  const projectId = agent.selectedProjectId
  const generation = ++fileRequestGeneration
  if (!bridge || !workspace || !projectId) return
  explorerError.value = ''
  const result = await bridge.readWorkspaceFile({
    version: IPC_VERSION,
    projectId,
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
  () => agent.workspaceFileRevision,
  () => {
    directoryRequestGeneration += 1
    explorerTree.value = []
    void loadRootDirectory(directoryRequestGeneration)
    if (activeFile.value) void openExplorerFile(activeFile.value.path)
  },
)

watch(explorerError, (message) => {
  if (!message) return
  notifications.error({
    code: 'FILE_EXPLORER_OPERATION_FAILED',
    message,
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
  })
})
</script>

<template>
  <section class="artifact-content">
    <NTabs
      v-model:value="activeFilePath"
      class="file-tabs"
      type="card"
      size="small"
      role="tablist"
      :aria-label="t('artifact.openFiles')"
      :animated="false"
      :pane-style="{ height: '100%', minHeight: '0' }"
      @close="closeFile"
    >
      <NTabPane
        name="explorer"
        display-directive="show"
        style="height: 100%"
        :tab-props="{
          role: 'tab',
          'aria-selected': activeFilePath === 'explorer',
        }"
      >
        <template #tab>
          <span class="file-tab-label">
            <UiIcon name="explorer" />{{ t('artifact.explorer') }}
          </span>
        </template>

        <div class="explorer-view">
          <NEmpty
            v-if="!agent.workspacePath"
            class="artifact-empty"
            :description="t('artifact.chooseHint')"
          >
            <template #icon>
              <UiIcon name="folder" />
            </template>
          </NEmpty>
          <div v-else class="explorer-tree-state">
            <NSpin
              class="explorer-tree-loader"
              :show="explorerLoading"
              size="small"
            >
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
              <NEmpty
                v-else-if="!explorerLoading && !explorerError"
                class="artifact-empty"
                size="small"
                :description="t('artifact.emptyDirectory')"
              />
            </NSpin>
            <NAlert
              v-if="explorerTruncated"
              class="artifact-message"
              type="warning"
              :show-icon="false"
            >
              {{ t('artifact.truncatedList') }}
            </NAlert>
          </div>
        </div>
      </NTabPane>

      <NTabPane
        v-for="file in openedFiles"
        :key="file.path"
        :name="file.path"
        closable
        display-directive="show"
        style="height: 100%"
        :tab-props="{
          role: 'tab',
          'aria-selected': activeFilePath === file.path,
        }"
      >
        <template #tab>
          <NTooltip>
            <template #trigger>
              <span class="file-tab-label">
                <UiIcon name="file" />
                <span>{{ file.path.split('/').at(-1) }}</span>
              </span>
            </template>
            {{ file.path }}
          </NTooltip>
        </template>

        <div class="file-viewer">
          <div class="file-viewer-header">
            <div>
              <strong>{{ file.path }}</strong>
              <span>
                {{ t('artifact.readonly') }} ·
                {{
                  t('artifact.bytes', {
                    count: file.totalBytes.toLocaleString(),
                  })
                }}
              </span>
            </div>
            <NTag v-if="file.truncated" round size="small" type="warning">
              {{ t('artifact.truncated') }}
            </NTag>
          </div>
          <FileCodePreview :path="file.path" :content="file.content" />
        </div>
      </NTabPane>
    </NTabs>
  </section>
</template>
