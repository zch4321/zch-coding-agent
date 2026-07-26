<script setup lang="ts">
import { h, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NSpin,
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

interface FilePreview {
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
const activeFile = ref<FilePreview>()
const externalOpenPending = ref(false)
let directoryRequestGeneration = 0
let fileRequestGeneration = 0

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

  activeFile.value = result.value
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

function showExplorer() {
  fileRequestGeneration += 1
  activeFile.value = undefined
}

async function openActiveFileExternally() {
  const bridge = window.agentApi
  const projectId = agent.selectedProjectId
  const file = activeFile.value
  if (externalOpenPending.value || !file) return
  if (!bridge || !projectId) {
    notifications.error({
      code: 'EXTERNAL_FILE_OPEN_FAILED',
      message: t('app.bridgeHint'),
      ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    })
    return
  }

  externalOpenPending.value = true
  try {
    const result = await bridge.openWorkspaceFile({
      version: IPC_VERSION,
      projectId,
      path: file.path,
    })
    if (!result.ok) {
      notifications.error({
        code: 'EXTERNAL_FILE_OPEN_FAILED',
        message: result.error.message,
        ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
      })
    }
  } finally {
    externalOpenPending.value = false
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
    externalOpenPending.value = false

    if (workspace && workspace !== previous) {
      activeFile.value = undefined
      void loadRootDirectory(directoryRequestGeneration)
    } else if (!workspace) {
      explorerTree.value = []
      activeFile.value = undefined
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
    const activePath = activeFile.value?.path
    if (activePath) void openExplorerFile(activePath)
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
  <section class="artifact-content files-view">
    <div v-show="!activeFile" class="explorer-view">
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
          :content-style="{ height: '100%', minHeight: '0' }"
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
            :scrollbar-props="{ trigger: 'none' }"
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

    <div v-if="activeFile" class="file-viewer">
      <div class="file-viewer-header">
        <NTooltip>
          <template #trigger>
            <NButton
              quaternary
              circle
              size="small"
              :aria-label="t('artifact.backToExplorer')"
              @click="showExplorer"
            >
              <template #icon><UiIcon name="arrow-left" /></template>
            </NButton>
          </template>
          {{ t('artifact.backToExplorer') }}
        </NTooltip>
        <div class="file-viewer-heading">
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
        <div class="file-viewer-actions">
          <NTag v-if="activeFile.truncated" round size="small" type="warning">
            {{ t('artifact.truncated') }}
          </NTag>
          <NTooltip>
            <template #trigger>
              <NButton
                quaternary
                circle
                size="small"
                :loading="externalOpenPending"
                :aria-label="t('artifact.openExternally')"
                @click="openActiveFileExternally"
              >
                <template #icon><UiIcon name="external-link" /></template>
              </NButton>
            </template>
            {{ t('artifact.openExternally') }}
          </NTooltip>
        </div>
      </div>
      <FileCodePreview :path="activeFile.path" :content="activeFile.content" />
    </div>
  </section>
</template>
