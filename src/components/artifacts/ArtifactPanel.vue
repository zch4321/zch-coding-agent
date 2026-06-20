<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton } from 'naive-ui'
import { IPC_VERSION } from '../../../shared/channels'
import { useAgentStore } from '../../stores/agent'
import FileCodePreview from './FileCodePreview.vue'
import UiIcon from '../UiIcon.vue'

type ArtifactTab = 'files' | 'diff'

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
const activeArtifact = ref<ArtifactTab>('files')
const explorerPath = ref('.')
const explorerEntries = ref<ExplorerEntry[]>([])
const explorerLoading = ref(false)
const explorerError = ref('')
const explorerTruncated = ref(false)
const openedFiles = ref<OpenFile[]>([])
const activeFilePath = ref('explorer')

const projectName = computed(() => {
  const normalized = agent.workspacePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) || 'Choose workspace'
})
const activeFile = computed(() =>
  openedFiles.value.find((file) => file.path === activeFilePath.value),
)
const explorerParent = computed(() => {
  if (explorerPath.value === '.') return undefined
  const parts = explorerPath.value.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/') || '.'
})

async function loadDirectory(path: string) {
  const bridge = window.agentApi
  if (!bridge || !agent.workspacePath) {
    explorerEntries.value = []
    return
  }

  explorerLoading.value = true
  explorerError.value = ''
  const result = await bridge.listWorkspaceDirectory({
    version: IPC_VERSION,
    path,
  })
  explorerLoading.value = false

  if (result.ok) {
    explorerPath.value = result.value.path
    explorerEntries.value = result.value.entries
    explorerTruncated.value = result.value.truncated
  } else {
    explorerError.value = result.error.message
  }
}

async function openExplorerEntry(entry: ExplorerEntry) {
  if (entry.type === 'directory') {
    await loadDirectory(entry.path)
    return
  }

  const bridge = window.agentApi
  if (!bridge) return
  explorerError.value = ''
  const result = await bridge.readWorkspaceFile({
    version: IPC_VERSION,
    path: entry.path,
  })

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

function closeFile(path: string) {
  const index = openedFiles.value.findIndex((file) => file.path === path)
  openedFiles.value = openedFiles.value.filter((file) => file.path !== path)
  if (activeFilePath.value === path) {
    activeFilePath.value =
      openedFiles.value[Math.max(0, index - 1)]?.path ?? 'explorer'
  }
}

watch(
  () => agent.pendingApproval,
  (approval) => {
    if (approval?.diff) activeArtifact.value = 'diff'
  },
)

watch(
  () => agent.workspacePath,
  (workspace, previous) => {
    if (workspace && workspace !== previous) {
      openedFiles.value = []
      activeFilePath.value = 'explorer'
      void loadDirectory('.')
    } else if (!workspace) {
      explorerEntries.value = []
      openedFiles.value = []
    }
  },
  { immediate: true },
)
</script>

<template>
  <aside class="artifact-sidebar">
    <header class="artifact-header">
      <div class="artifact-project">
        <strong>{{ projectName }}</strong>
        <span :title="agent.workspacePath || 'No workspace selected'">
          {{ agent.workspacePath || 'No workspace selected' }}
        </span>
      </div>
      <nav class="artifact-tabs" aria-label="Artifact views" role="tablist">
        <button
          type="button"
          role="tab"
          :aria-selected="activeArtifact === 'files'"
          :class="{ active: activeArtifact === 'files' }"
          @click="activeArtifact = 'files'"
        >
          <UiIcon name="explorer" />Files
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeArtifact === 'diff'"
          :class="{ active: activeArtifact === 'diff' }"
          @click="activeArtifact = 'diff'"
        >
          <UiIcon name="diff" />Diff
          <span v-if="agent.pendingApproval?.diff" class="tab-dot"></span>
        </button>
      </nav>
    </header>

    <section v-if="activeArtifact === 'files'" class="artifact-content">
      <div class="file-tabs" role="tablist" aria-label="Open files">
        <button
          type="button"
          role="tab"
          :aria-selected="activeFilePath === 'explorer'"
          :class="{ active: activeFilePath === 'explorer' }"
          @click="activeFilePath = 'explorer'"
        >
          <UiIcon name="explorer" />Explorer
        </button>
        <div
          v-for="file in openedFiles"
          :key="file.path"
          class="file-tab"
          :class="{ active: activeFilePath === file.path }"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="activeFilePath === file.path"
            :title="file.path"
            @click="activeFilePath = file.path"
          >
            <UiIcon name="file" />
            <span>{{ file.path.split('/').at(-1) }}</span>
          </button>
          <button
            class="tab-close"
            type="button"
            aria-label="Close file"
            @click="closeFile(file.path)"
          >
            <UiIcon name="close" />
          </button>
        </div>
      </div>

      <div v-if="activeFilePath === 'explorer'" class="explorer-view">
        <div class="explorer-toolbar">
          <button
            type="button"
            aria-label="Go to parent folder"
            :disabled="!explorerParent"
            @click="explorerParent && loadDirectory(explorerParent)"
          >
            <UiIcon name="arrow-left" />
          </button>
          <span :title="explorerPath">{{ explorerPath }}</span>
        </div>
        <p v-if="explorerLoading" class="artifact-message">Loading files...</p>
        <p v-else-if="explorerError" class="artifact-message error">
          {{ explorerError }}
        </p>
        <div v-else-if="!agent.workspacePath" class="artifact-empty">
          <UiIcon name="folder" />
          <p>Choose a workspace to browse files.</p>
        </div>
        <ul v-else class="explorer-list">
          <li v-for="entry in explorerEntries" :key="entry.path">
            <button type="button" @click="openExplorerEntry(entry)">
              <UiIcon :name="entry.type === 'directory' ? 'folder' : 'file'" />
              <span>{{ entry.name }}</span>
              <UiIcon v-if="entry.type === 'directory'" name="chevron-right" />
            </button>
          </li>
        </ul>
        <p v-if="explorerTruncated" class="artifact-message">
          Showing the first 1,000 entries.
        </p>
      </div>

      <div v-else-if="activeFile" class="file-viewer">
        <div class="file-viewer-header">
          <div>
            <strong>{{ activeFile.path }}</strong>
            <span>
              Read-only · {{ activeFile.totalBytes.toLocaleString() }} bytes
            </span>
          </div>
          <span v-if="activeFile.truncated" class="truncated-badge">
            Truncated
          </span>
        </div>
        <FileCodePreview
          :path="activeFile.path"
          :content="activeFile.content"
        />
      </div>
    </section>

    <section v-else class="artifact-content diff-view">
      <template
        v-if="agent.pendingApproval?.diff || agent.latestReviewedApproval?.diff"
      >
        <div class="diff-summary">
          <span>
            {{
              agent.pendingApproval?.diff
                ? 'Pending change'
                : 'Review ' + agent.latestReviewedApproval?.decision
            }}
          </span>
          <strong>
            {{
              agent.pendingApproval?.tool ?? agent.latestReviewedApproval?.tool
            }}
          </strong>
          <p>
            {{
              agent.pendingApproval?.reason ??
              agent.latestReviewedApproval?.reason
            }}
          </p>
          <code
            v-if="
              agent.pendingApproval?.diffHash ||
              agent.latestReviewedApproval?.diffHash
            "
          >
            {{
              agent.pendingApproval?.diffHash ??
              agent.latestReviewedApproval?.diffHash
            }}
          </code>
        </div>
        <pre class="diff-content">{{
          agent.pendingApproval?.diff ?? agent.latestReviewedApproval?.diff
        }}</pre>
        <div v-if="agent.pendingApproval?.diff" class="diff-actions">
          <NButton
            type="primary"
            :loading="agent.approvalSubmitting"
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('allow')"
          >
            Approve
          </NButton>
          <NButton
            secondary
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('deny')"
          >
            Deny
          </NButton>
        </div>
      </template>
      <div v-else class="artifact-empty">
        <UiIcon name="diff" />
        <h2>No diff selected</h2>
        <p>File changes awaiting review will appear here.</p>
      </div>
    </section>
  </aside>
</template>
