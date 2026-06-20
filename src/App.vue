<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NConfigProvider,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
} from 'naive-ui'
import MarkdownBlock from './components/MarkdownBlock.vue'
import UiIcon from './components/UiIcon.vue'
import { useAgentStore, type ToolActivity } from './stores/agent'
import { IPC_VERSION } from '../shared/channels'
import type { PermissionMode } from '../shared/config'

type ArtifactTab = 'files' | 'diff'
type SettingsTab = 'project' | 'provider' | 'permissions' | 'skills' | 'logging'

const TerminalPanel = defineAsyncComponent(
  () => import('./components/TerminalPanel.vue'),
)

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
const settingsOpen = ref(false)
const settingsTab = ref<SettingsTab>('project')
const yoloWarningOpen = ref(false)
const projectSidebarOpen = ref(true)
const artifactSidebarOpen = ref(true)
const terminalOpen = ref(false)
const terminalMaximized = ref(false)
const activeArtifact = ref<ArtifactTab>('files')
const searchQuery = ref('')
const renameConversationId = ref<string>()
const renameValue = ref('')
const deleteConversationId = ref<string>()
const removeProjectOpen = ref(false)
const switchConversationId = ref<string>()
const explorerPath = ref('.')
const explorerEntries = ref<ExplorerEntry[]>([])
const explorerLoading = ref(false)
const explorerError = ref('')
const explorerTruncated = ref(false)
const openedFiles = ref<OpenFile[]>([])
const activeFilePath = ref('explorer')

const reasoningOptions = [
  { label: 'Auto', value: 'auto' },
  { label: 'Off', value: 'off' },
]
const tokenEstimationOptions = [
  { label: 'Conservative', value: 'conservative' },
  { label: 'Custom bytes per token', value: 'custom-bytes' },
]
const modeOptions = [
  { label: 'ReadOnly', value: 'readonly' },
  { label: 'Auto', value: 'auto' },
  { label: 'Confirm', value: 'confirm' },
  { label: 'Yolo', value: 'yolo' },
]
const sensitiveModeOptions = [
  { label: 'Off', value: 'off' },
  { label: 'Warn', value: 'warn' },
  { label: 'Confirm', value: 'confirm' },
]
const settingsTabs: Array<{
  label: string
  value: SettingsTab
}> = [
  { label: 'Project', value: 'project' },
  { label: 'Provider', value: 'provider' },
  { label: 'Permissions', value: 'permissions' },
  { label: 'Skills', value: 'skills' },
  { label: 'Logging', value: 'logging' },
]

const projectName = computed(() => {
  if (!agent.workspacePath) {
    return 'Choose workspace'
  }

  const normalized = agent.workspacePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? agent.workspacePath
})
const workspaceLabel = computed(
  () => agent.workspacePath || 'No workspace selected',
)
const activeTitle = computed(
  () => agent.activeConversation?.title ?? 'New conversation',
)
const statusLabel = computed(() => {
  if (agent.pendingApproval) {
    return 'Waiting for approval'
  }

  if (agent.runStatus === 'failed') {
    return 'Failed'
  }

  if (agent.runStatus === 'cancelling') {
    return 'Cancelling'
  }

  if (agent.activeRunId) {
    return 'Running'
  }

  return ''
})
const sortedProjects = computed(() =>
  agent.projects.map((project) => ({
    ...project,
    conversations: agent.conversations
      .filter((conversation) => conversation.projectPath === project.path)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  })),
)
const searchResults = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()

  if (!query) {
    return []
  }

  return agent.conversations
    .filter((conversation) => {
      if (conversation.title.toLocaleLowerCase().includes(query)) {
        return true
      }

      return conversation.messages.some((message) =>
        message.text.toLocaleLowerCase().includes(query),
      )
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
})
const chronologicalTools = computed(() => [...agent.tools].reverse())
const activeFile = computed(() =>
  openedFiles.value.find((file) => file.path === activeFilePath.value),
)
const fileLines = computed(() =>
  (activeFile.value?.content ?? '').split(/\r?\n/),
)
const explorerParent = computed(() => {
  if (explorerPath.value === '.') {
    return undefined
  }

  const parts = explorerPath.value.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/') || '.'
})
const inputDisabled = computed(
  () =>
    !agent.workspacePath ||
    !agent.activeConversationId ||
    Boolean(agent.activeRunId) ||
    Boolean(agent.pendingApproval),
)
const sendHint = computed(() => {
  if (!agent.workspacePath) {
    return 'Choose a workspace to begin'
  }

  if (!agent.credentialConfigured) {
    return 'Configure a Provider API key in Settings'
  }

  if (!agent.providerNoticeAccepted) {
    return 'Review the Provider data notice above'
  }

  if (agent.pendingApproval) {
    return 'Resolve the pending approval before sending another message'
  }

  return 'Ask about this workspace'
})

function okContent(tool: ToolActivity): unknown {
  const result = tool.result

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined
  }

  return 'status' in result && result.status === 'ok' && 'content' in result
    ? result.content
    : undefined
}

function toolResultSummary(tool: ToolActivity): string {
  const result = tool.result

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return tool.status === 'proposed' ? 'Proposed' : 'Completed'
  }

  if ('status' in result && result.status !== 'ok') {
    return String(result.status)
  }

  return 'Completed'
}

function toolArgsPreview(tool: ToolActivity): string {
  return JSON.stringify(tool.args, null, 2)
}

function openSettings(tab: SettingsTab = 'project') {
  selectSettingsTab(tab)
  settingsOpen.value = true
}

function selectSettingsTab(tab: SettingsTab) {
  settingsTab.value = tab

  if (tab === 'skills') {
    void agent.loadSkills(false)
  }

  if (tab === 'logging') {
    void agent.loadTraceData()
  }
}

function providerMetric(value: number | null | undefined, suffix = '') {
  return value === null || value === undefined
    ? 'Provider not provided'
    : `${Math.round(value).toLocaleString()}${suffix}`
}

function clearClosedTraces() {
  if (
    window.confirm(
      'Delete every closed trace? Active session traces will be preserved.',
    )
  ) {
    void agent.clearClosedTraces()
  }
}

async function minimizeWindow() {
  const result = await window.agentApi?.minimizeWindow({
    version: IPC_VERSION,
  })

  if (result && !result.ok) {
    agent.error = result.error.message
  }
}

async function toggleMaximizeWindow() {
  const result = await window.agentApi?.toggleMaximizeWindow({
    version: IPC_VERSION,
  })

  if (result && !result.ok) {
    agent.error = result.error.message
  }
}

async function closeWindow() {
  const result = await window.agentApi?.closeWindow({
    version: IPC_VERSION,
  })

  if (result && !result.ok) {
    agent.error = result.error.message
  }
}

function selectMode(value: string | number) {
  if (
    value !== 'readonly' &&
    value !== 'auto' &&
    value !== 'confirm' &&
    value !== 'yolo'
  ) {
    return
  }

  if (value === 'yolo' && !agent.yoloNoticeAccepted) {
    yoloWarningOpen.value = true
    return
  }

  agent.setMode(value as PermissionMode)
}

async function confirmYoloMode() {
  if (await agent.acceptYoloNotice()) {
    agent.setMode('yolo')
    yoloWarningOpen.value = false
  }
}

async function createConversation() {
  if (agent.activeRunId || agent.pendingApproval) {
    switchConversationId.value = 'new'
    return
  }

  await agent.newConversation()
}

async function openConversation(conversationId: string) {
  if (!(await agent.selectConversation(conversationId))) {
    switchConversationId.value = conversationId
  }
}

async function confirmConversationSwitch() {
  const target = switchConversationId.value
  switchConversationId.value = undefined
  await agent.interruptRun()
  await agent.closeRuntimeSession()

  if (target === 'new') {
    await agent.newConversation()
  } else if (target) {
    await agent.selectConversation(target)
  }
}

function beginRename(conversationId: string) {
  const conversation = agent.conversations.find(
    (item) => item.id === conversationId,
  )

  if (!conversation) {
    return
  }

  renameConversationId.value = conversationId
  renameValue.value = conversation.title
}

function confirmRename() {
  if (renameConversationId.value) {
    agent.renameConversation(renameConversationId.value, renameValue.value)
  }

  renameConversationId.value = undefined
}

async function confirmDeleteConversation() {
  if (deleteConversationId.value) {
    await agent.deleteConversation(deleteConversationId.value)
  }

  deleteConversationId.value = undefined
}

async function chooseWorkspace() {
  const selected = await agent.chooseWorkspace()

  if (selected) {
    await loadDirectory('.')
  }
}

async function confirmRemoveProject() {
  await agent.removeCurrentProject()
  removeProjectOpen.value = false
  openedFiles.value = []
  explorerEntries.value = []
  activeFilePath.value = 'explorer'
}

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

  if (!bridge) {
    return
  }

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

  if (existing) {
    Object.assign(existing, result.value)
  } else {
    openedFiles.value.push(result.value)
  }

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

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.key !== 'Enter' || event.shiftKey) {
    return
  }

  event.preventDefault()
  void agent.sendMessage()
}

function closeTerminalPanel() {
  terminalOpen.value = false
  terminalMaximized.value = false
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (!event.ctrlKey) {
    return
  }

  if (
    event.key.toLocaleLowerCase() === 'j' ||
    event.key === '`' ||
    event.code === 'Backquote'
  ) {
    if (!agent.workspacePath || !agent.bridgeAvailable) {
      return
    }

    event.preventDefault()
    terminalOpen.value = !terminalOpen.value

    if (!terminalOpen.value) {
      terminalMaximized.value = false
    }
  } else if (event.key.toLocaleLowerCase() === 'b' && event.shiftKey) {
    event.preventDefault()
    artifactSidebarOpen.value = !artifactSidebarOpen.value
  } else if (event.key.toLocaleLowerCase() === 'b') {
    event.preventDefault()
    projectSidebarOpen.value = !projectSidebarOpen.value
  }
}

watch(
  () => agent.pendingApproval,
  (approval) => {
    if (approval?.diff) {
      activeArtifact.value = 'diff'
      artifactSidebarOpen.value = true
    }
  },
)

watch(
  () => agent.workspacePath,
  (workspace, previous) => {
    if (workspace && workspace !== previous && agent.initialized) {
      openedFiles.value = []
      activeFilePath.value = 'explorer'
      void loadDirectory('.')
    }
  },
)

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown, { capture: true })
  if (window.innerWidth <= 1080) {
    artifactSidebarOpen.value = false
  }
  await agent.initialize()

  if (agent.workspacePath) {
    await loadDirectory('.')
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown, { capture: true })
  agent.dispose()
})
</script>

<template>
  <NConfigProvider>
    <main
      class="app-frame"
      :class="{
        'project-sidebar-closed': !projectSidebarOpen,
        'artifact-sidebar-closed': !artifactSidebarOpen,
      }"
      data-testid="app-ready"
    >
      <header class="app-topbar">
        <div class="window-title">
          <span class="app-mark"><UiIcon name="app" /></span>
          <strong>My Coding Agent</strong>
        </div>

        <button
          class="project-crumb"
          type="button"
          :title="workspaceLabel"
          @click="openSettings('project')"
        >
          <UiIcon name="folder" />
          <span>{{ projectName }}</span>
        </button>

        <div class="topbar-actions">
          <button
            class="topbar-icon-button"
            type="button"
            aria-label="Toggle terminal"
            title="Toggle terminal (Ctrl+J)"
            :aria-pressed="terminalOpen"
            :disabled="!agent.workspacePath || !agent.bridgeAvailable"
            @click="terminalOpen = !terminalOpen"
          >
            <UiIcon name="terminal" />
          </button>
          <button
            class="topbar-icon-button"
            type="button"
            aria-label="Toggle project sidebar"
            title="Toggle project sidebar (Ctrl+B)"
            :aria-pressed="projectSidebarOpen"
            @click="projectSidebarOpen = !projectSidebarOpen"
          >
            <UiIcon name="panel-left" />
          </button>
          <button
            class="topbar-icon-button"
            type="button"
            aria-label="Toggle artifact sidebar"
            title="Toggle artifact sidebar (Ctrl+Shift+B)"
            :aria-pressed="artifactSidebarOpen"
            @click="artifactSidebarOpen = !artifactSidebarOpen"
          >
            <UiIcon name="panel-right" />
          </button>
          <button
            class="topbar-icon-button"
            type="button"
            aria-label="Open settings"
            title="Settings"
            @click="openSettings()"
          >
            <UiIcon name="settings" />
          </button>
          <div class="window-controls" aria-label="Window controls">
            <button
              class="window-control"
              type="button"
              aria-label="Minimize window"
              @click="minimizeWindow"
            >
              <UiIcon name="minimize" />
            </button>
            <button
              class="window-control"
              type="button"
              aria-label="Maximize or restore window"
              @click="toggleMaximizeWindow"
            >
              <UiIcon name="maximize" />
            </button>
            <button
              class="window-control close"
              type="button"
              aria-label="Close window"
              @click="closeWindow"
            >
              <UiIcon name="close" />
            </button>
          </div>
        </div>
      </header>

      <div class="workbench-shell">
        <aside class="project-sidebar" :aria-hidden="!projectSidebarOpen">
          <button
            class="new-conversation-button"
            type="button"
            @click="createConversation"
          >
            <UiIcon name="plus" />
            <span>New conversation</span>
          </button>

          <label class="conversation-search">
            <UiIcon name="search" />
            <input
              v-model="searchQuery"
              type="search"
              placeholder="Search conversations"
              aria-label="Search conversations"
            />
          </label>

          <div class="project-list">
            <template v-if="searchQuery.trim()">
              <p class="sidebar-section-title">Search results</p>
              <button
                v-for="conversation in searchResults"
                :key="conversation.id"
                class="conversation-item search-result"
                type="button"
                @click="openConversation(conversation.id)"
              >
                <span>{{ conversation.title }}</span>
                <small>{{
                  agent.projects.find(
                    (project) => project.path === conversation.projectPath,
                  )?.name
                }}</small>
              </button>
              <p v-if="searchResults.length === 0" class="sidebar-empty">
                No matching conversations
              </p>
            </template>

            <template v-else>
              <p class="sidebar-section-title">Projects</p>
              <section
                v-for="project in sortedProjects"
                :key="project.path"
                class="project-group"
              >
                <div class="project-heading" :title="project.path">
                  <UiIcon name="chevron-down" />
                  <UiIcon name="folder" />
                  <strong>{{ project.name }}</strong>
                </div>
                <div class="conversation-list">
                  <div
                    v-for="conversation in project.conversations"
                    :key="conversation.id"
                    class="conversation-row"
                    :class="{
                      active: conversation.id === agent.activeConversationId,
                    }"
                  >
                    <button
                      class="conversation-item"
                      type="button"
                      @click="openConversation(conversation.id)"
                    >
                      {{ conversation.title }}
                    </button>
                    <div class="conversation-actions">
                      <button
                        type="button"
                        aria-label="Rename conversation"
                        title="Rename"
                        @click="beginRename(conversation.id)"
                      >
                        <UiIcon name="edit" />
                      </button>
                      <button
                        type="button"
                        aria-label="Delete conversation"
                        title="Delete"
                        @click="deleteConversationId = conversation.id"
                      >
                        <UiIcon name="trash" />
                      </button>
                    </div>
                  </div>
                  <p
                    v-if="project.conversations.length === 0"
                    class="sidebar-empty"
                  >
                    No conversations
                  </p>
                </div>
              </section>
              <div
                v-if="sortedProjects.length === 0"
                class="sidebar-empty-state"
              >
                <UiIcon name="folder" />
                <p>No workspace yet</p>
                <button type="button" @click="chooseWorkspace">
                  Choose workspace
                </button>
              </div>
            </template>
          </div>
        </aside>

        <section
          class="conversation-pane"
          :class="{
            'terminal-open': terminalOpen,
            'terminal-maximized': terminalOpen && terminalMaximized,
          }"
        >
          <header class="conversation-header">
            <div>
              <h1>{{ activeTitle }}</h1>
              <p v-if="agent.workspacePath">{{ projectName }}</p>
            </div>
            <span
              v-if="statusLabel"
              class="run-status"
              :class="agent.pendingApproval ? 'approval' : agent.runStatus"
            >
              <span></span>{{ statusLabel }}
            </span>
          </header>

          <div class="conversation-scroll" aria-label="Conversation messages">
            <NAlert
              v-if="!agent.bridgeAvailable && agent.initialized"
              type="warning"
              title="Desktop bridge unavailable"
              class="inline-alert"
            >
              Open the Electron application to use workspace and Agent actions.
            </NAlert>

            <NAlert
              v-if="agent.bridgeAvailable && !agent.providerNoticeAccepted"
              type="info"
              title="Provider data notice"
              class="inline-alert"
            >
              Messages, selected code and bounded tool results may be sent to
              the configured Provider. Only the notice version and acceptance
              time are stored.
              <div class="notice-action">
                <NButton
                  size="small"
                  type="primary"
                  @click="agent.acceptProviderNotice"
                >
                  I understand
                </NButton>
              </div>
            </NAlert>

            <NAlert
              v-if="agent.error"
              type="error"
              title="Request failed"
              class="inline-alert"
              closable
              @close="agent.error = ''"
            >
              {{ agent.error }}
            </NAlert>

            <article
              v-for="message in agent.messages"
              :key="message.id"
              class="chat-message"
              :class="message.role"
            >
              <div class="message-meta">
                <strong>{{ message.role === 'user' ? 'You' : 'Agent' }}</strong>
                <span
                  v-if="
                    message.role === 'assistant' &&
                    message.runId === agent.activeRunId
                  "
                >
                  Streaming
                </span>
              </div>
              <MarkdownBlock :content="message.text || '...'" />
              <NCollapse v-if="message.reasoning" class="reasoning">
                <NCollapseItem title="Reasoning" name="reasoning">
                  <pre>{{ message.reasoning }}</pre>
                </NCollapseItem>
              </NCollapse>
            </article>

            <article
              v-for="tool in chronologicalTools"
              :key="tool.callId"
              class="tool-call-card"
            >
              <div class="tool-call-header">
                <div>
                  <span class="tool-kicker">Tool call</span>
                  <strong>{{ tool.tool }}</strong>
                </div>
                <span
                  class="tool-status"
                  :class="tool.status === 'completed' ? 'complete' : ''"
                >
                  {{ toolResultSummary(tool) }}
                </span>
              </div>
              <p v-if="tool.reason" class="tool-reason">
                {{ tool.reason }}
              </p>
              <NCollapse>
                <NCollapseItem title="Arguments" :name="`${tool.callId}:args`">
                  <pre>{{ toolArgsPreview(tool) }}</pre>
                </NCollapseItem>
                <NCollapseItem
                  v-if="okContent(tool)"
                  title="Result"
                  :name="`${tool.callId}:result`"
                >
                  <pre>{{ JSON.stringify(tool.result, null, 2) }}</pre>
                </NCollapseItem>
              </NCollapse>
            </article>

            <article v-if="agent.pendingApproval" class="approval-card">
              <div class="approval-header">
                <div>
                  <span class="tool-kicker">Approval required</span>
                  <strong>{{ agent.pendingApproval.tool }}</strong>
                </div>
                <span>{{ agent.pendingApproval.kind }}</span>
              </div>
              <p>{{ agent.pendingApproval.reason }}</p>
              <dl class="approval-meta">
                <div>
                  <dt>Workspace scope</dt>
                  <dd>{{ projectName }}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{{ agent.pendingApproval.expiresAt }}</dd>
                </div>
              </dl>
              <pre class="approval-args">{{
                JSON.stringify(agent.pendingApproval.args, null, 2)
              }}</pre>
              <ul class="policy-signals">
                <li
                  v-for="signal in agent.pendingApproval.signals"
                  :key="signal.code + signal.detail"
                >
                  <UiIcon name="warning" />{{ signal.detail }}
                </li>
              </ul>
              <pre v-if="agent.pendingApproval.diff" class="approval-diff">{{
                agent.pendingApproval.diff
              }}</pre>
              <div
                v-if="agent.pendingApproval.rememberArgConstraints"
                class="approval-remember-preview"
              >
                <strong>Remembered scope</strong>
                <pre>{{
                  JSON.stringify(
                    agent.pendingApproval.rememberArgConstraints,
                    null,
                    2,
                  )
                }}</pre>
              </div>
              <div class="approval-actions">
                <NButton type="primary" @click="agent.decideApproval('allow')">
                  Approve
                </NButton>
                <NButton
                  v-if="agent.pendingApproval.rememberable"
                  secondary
                  type="primary"
                  @click="agent.decideApproval('allow', true)"
                >
                  Approve & remember
                </NButton>
                <NButton secondary @click="agent.decideApproval('deny')">
                  Deny
                </NButton>
              </div>
            </article>

            <div
              v-if="
                agent.messages.length === 0 &&
                chronologicalTools.length === 0 &&
                !agent.pendingApproval
              "
              class="conversation-empty"
            >
              <span class="empty-icon"><UiIcon name="app" /></span>
              <template v-if="!agent.workspacePath">
                <h2>Open a workspace</h2>
                <p>Choose a project folder to start a local conversation.</p>
                <NButton type="primary" @click="chooseWorkspace">
                  Choose workspace
                </NButton>
              </template>
              <template v-else>
                <h2>What should we work on?</h2>
                <p>
                  Ask the Agent to inspect code, explain behavior or prepare a
                  reviewed change.
                </p>
              </template>
            </div>
          </div>

          <footer class="message-input-area">
            <NInput
              v-model:value="agent.input"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 7 }"
              :placeholder="sendHint"
              :disabled="inputDisabled"
              @keydown="handleComposerKeydown"
            />
            <div class="message-input-toolbar">
              <div class="input-selectors">
                <button
                  class="model-button"
                  type="button"
                  @click="openSettings('provider')"
                >
                  {{ agent.providerForm.model }}
                  <UiIcon name="chevron-down" />
                </button>
                <NSelect
                  :value="agent.mode"
                  class="mode-select"
                  size="small"
                  :options="modeOptions"
                  @update:value="selectMode"
                />
              </div>
              <button
                v-if="agent.activeRunId"
                class="send-button stop"
                type="button"
                aria-label="Stop run"
                title="Stop"
                @click="agent.interruptRun"
              >
                <UiIcon name="stop" />
              </button>
              <button
                v-else
                class="send-button"
                type="button"
                aria-label="Send message"
                title="Send"
                :disabled="!agent.canSend"
                @click="agent.sendMessage"
              >
                <UiIcon name="send" />
              </button>
            </div>
          </footer>

          <TerminalPanel
            v-if="terminalOpen"
            @close="closeTerminalPanel"
            @maximize-change="terminalMaximized = $event"
          />
        </section>

        <aside class="artifact-sidebar" :aria-hidden="!artifactSidebarOpen">
          <header class="artifact-header">
            <div class="artifact-project">
              <strong>{{ projectName }}</strong>
              <span :title="workspaceLabel">{{ workspaceLabel }}</span>
            </div>
            <nav class="artifact-tabs" aria-label="Artifact views">
              <button
                type="button"
                :class="{ active: activeArtifact === 'files' }"
                @click="activeArtifact = 'files'"
              >
                <UiIcon name="explorer" />Files
              </button>
              <button
                type="button"
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
                :class="{ active: activeFilePath === 'explorer' }"
                @click="activeFilePath = 'explorer'"
              >
                <UiIcon name="explorer" />Explorer
              </button>
              <button
                v-for="file in openedFiles"
                :key="file.path"
                type="button"
                :class="{ active: activeFilePath === file.path }"
                :title="file.path"
                @click="activeFilePath = file.path"
              >
                <UiIcon name="file" />
                <span>{{ file.path.split('/').at(-1) }}</span>
                <span
                  class="tab-close"
                  role="button"
                  tabindex="0"
                  aria-label="Close file"
                  @click.stop="closeFile(file.path)"
                  @keydown.enter.stop="closeFile(file.path)"
                >
                  <UiIcon name="close" />
                </span>
              </button>
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
              <p v-if="explorerLoading" class="artifact-message">
                Loading files...
              </p>
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
                    <UiIcon
                      :name="entry.type === 'directory' ? 'folder' : 'file'"
                    />
                    <span>{{ entry.name }}</span>
                    <UiIcon
                      v-if="entry.type === 'directory'"
                      name="chevron-right"
                    />
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
                    Read-only ·
                    {{ activeFile.totalBytes.toLocaleString() }} bytes
                  </span>
                </div>
                <span v-if="activeFile.truncated" class="truncated-badge">
                  Truncated
                </span>
              </div>
              <div class="code-preview">
                <div
                  v-for="(line, index) in fileLines"
                  :key="index"
                  class="code-line"
                >
                  <span>{{ index + 1 }}</span>
                  <code>{{ line || ' ' }}</code>
                </div>
              </div>
            </div>
          </section>

          <section v-else class="artifact-content diff-view">
            <template v-if="agent.pendingApproval?.diff">
              <div class="diff-summary">
                <span>Pending change</span>
                <strong>{{ agent.pendingApproval.tool }}</strong>
                <p>{{ agent.pendingApproval.reason }}</p>
                <code v-if="agent.pendingApproval.diffHash">
                  {{ agent.pendingApproval.diffHash }}
                </code>
              </div>
              <pre class="diff-content">{{ agent.pendingApproval.diff }}</pre>
              <div class="diff-actions">
                <NButton type="primary" @click="agent.decideApproval('allow')">
                  Approve
                </NButton>
                <NButton secondary @click="agent.decideApproval('deny')">
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
      </div>

      <NModal v-model:show="settingsOpen" preset="card" class="settings-modal">
        <template #header>Settings</template>
        <div class="settings-layout">
          <nav class="settings-nav" aria-label="Settings sections">
            <button
              v-for="tab in settingsTabs"
              :key="tab.value"
              type="button"
              :class="{ active: settingsTab === tab.value }"
              @click="selectSettingsTab(tab.value)"
            >
              {{ tab.label }}
            </button>
          </nav>

          <div class="settings-content">
            <section v-if="settingsTab === 'project'" class="settings-section">
              <div class="settings-heading">
                <h2>Project</h2>
                <p>Manage the workspace used by the current conversation.</p>
              </div>
              <label class="settings-field">
                <span>Current workspace</span>
                <code>{{ workspaceLabel }}</code>
              </label>
              <div class="settings-actions">
                <NButton type="primary" @click="chooseWorkspace">
                  Choose workspace
                </NButton>
                <NButton
                  secondary
                  type="error"
                  :disabled="!agent.workspacePath"
                  @click="removeProjectOpen = true"
                >
                  Remove project
                </NButton>
              </div>
              <p class="settings-footnote">
                Removing a project clears its local conversation history. It
                does not delete files from disk.
              </p>
            </section>

            <section
              v-else-if="settingsTab === 'provider'"
              class="settings-section"
            >
              <div class="settings-heading">
                <h2>Provider</h2>
                <p>Configure the main model and the Auto approval model.</p>
              </div>
              <label class="settings-field">
                <span>Base URL</span>
                <NInput v-model:value="agent.providerForm.baseURL" />
              </label>
              <label class="settings-field">
                <span>Main model</span>
                <div class="settings-inline">
                  <NSelect
                    :value="agent.providerForm.model"
                    :options="agent.modelOptions"
                    :loading="agent.modelCatalogLoading"
                    filterable
                    tag
                    @update:value="agent.setProviderModel"
                  />
                  <NButton
                    secondary
                    :loading="agent.modelCatalogLoading"
                    :disabled="!agent.credentialConfigured"
                    @click="agent.loadProviderModels(true)"
                  >
                    Refresh
                  </NButton>
                </div>
                <small>
                  {{
                    agent.activeModelProfile
                      ? `${agent.activeModelProfile.availability} model · ${agent.activeModelProfile.capabilitySource} capabilities · ${agent.activeModelProfile.contextWindowTokens.toLocaleString()} effective context tokens`
                      : 'Custom model with conservative capability defaults.'
                  }}
                  <template v-if="agent.modelCatalogFetchedAt">
                    · Catalog refreshed
                    {{ new Date(agent.modelCatalogFetchedAt).toLocaleString() }}
                  </template>
                </small>
              </label>
              <div class="settings-inline settings-inline-equal">
                <label class="settings-field">
                  <span>Context window override</span>
                  <NInputNumber
                    v-model:value="agent.providerForm.contextWindowTokens"
                    :min="1024"
                    :max="10000000"
                    clearable
                    placeholder="Use model/default value"
                  />
                </label>
                <label class="settings-field">
                  <span>Maximum output override</span>
                  <NInputNumber
                    v-model:value="agent.providerForm.maxOutputTokens"
                    :min="1"
                    :max="10000000"
                    clearable
                    placeholder="Use model/default value"
                  />
                </label>
              </div>
              <div class="settings-inline settings-inline-equal">
                <label class="settings-field">
                  <span>Token estimation</span>
                  <NSelect
                    v-model:value="agent.providerForm.tokenEstimationMode"
                    :options="tokenEstimationOptions"
                  />
                </label>
                <label class="settings-field">
                  <span>UTF-8 bytes per token</span>
                  <NInputNumber
                    v-model:value="agent.providerForm.bytesPerToken"
                    :disabled="
                      agent.providerForm.tokenEstimationMode !== 'custom-bytes'
                    "
                    :min="0.25"
                    :max="32"
                    :step="0.25"
                  />
                </label>
              </div>
              <p class="settings-footnote">
                Token estimation plans context usage. Byte, line and result
                limits remain enforced independently.
              </p>
              <label class="settings-field">
                <span>Reasoning</span>
                <NSelect
                  v-model:value="agent.providerForm.reasoning"
                  :options="reasoningOptions"
                />
              </label>
              <label class="settings-field">
                <span>Auto approver model</span>
                <NSelect
                  v-model:value="agent.providerForm.approverModel"
                  :options="agent.modelOptions"
                  filterable
                  tag
                />
              </label>
              <label class="settings-field">
                <span>API key</span>
                <NInput
                  v-model:value="agent.providerForm.apiKey"
                  type="password"
                  show-password-on="click"
                  placeholder="Enter a new key"
                />
                <small>
                  {{
                    agent.credentialConfigured
                      ? agent.credentialSource === 'environment'
                        ? 'Using DEEPSEEK_API_KEY from the main-process environment.'
                        : 'A credential is stored securely.'
                      : 'No credential is configured.'
                  }}
                </small>
              </label>
              <div class="settings-actions">
                <NButton type="primary" @click="agent.saveProvider">
                  Save provider
                </NButton>
                <NButton
                  v-if="agent.credentialSource === 'safe-storage'"
                  secondary
                  @click="agent.clearCredential"
                >
                  Clear credential
                </NButton>
              </div>
            </section>

            <section
              v-else-if="settingsTab === 'permissions'"
              class="settings-section"
            >
              <div class="settings-heading">
                <h2>Permissions</h2>
                <p>Set defaults and review rules remembered from approvals.</p>
              </div>
              <label class="settings-field">
                <span>Default mode</span>
                <NSelect
                  :value="agent.mode"
                  :options="modeOptions"
                  @update:value="selectMode"
                />
              </label>
              <label class="settings-field">
                <span>Sensitive data</span>
                <NSelect
                  v-model:value="agent.permissionForm.sensitiveMode"
                  :options="sensitiveModeOptions"
                />
              </label>
              <label class="settings-field">
                <span>Sensitive path globs</span>
                <NInput
                  v-model:value="agent.permissionForm.pathGlobs"
                  type="textarea"
                  :rows="3"
                  placeholder="One glob per line"
                />
              </label>
              <label class="settings-field">
                <span>Content patterns</span>
                <NInput
                  v-model:value="agent.permissionForm.contentPatterns"
                  type="textarea"
                  :rows="3"
                  placeholder="One pattern per line"
                />
              </label>
              <NButton type="primary" @click="agent.savePermissions">
                Save permissions
              </NButton>
              <div class="remembered-rules">
                <h3>Remembered rules</h3>
                <p v-if="!agent.rememberedRules.length">No remembered rules.</p>
                <article v-for="rule in agent.rememberedRules" :key="rule.id">
                  <div>
                    <strong>{{ rule.toolId }}</strong>
                    <span>{{ rule.effect }} · {{ rule.workspaceScope }}</span>
                    <code>{{ rule.argConstraints }}</code>
                    <small v-if="rule.expiresAt"
                      >Expires {{ rule.expiresAt }}</small
                    >
                  </div>
                  <button
                    type="button"
                    aria-label="Delete remembered rule"
                    @click="agent.removeRememberedRule(rule.id)"
                  >
                    <UiIcon name="trash" />
                  </button>
                </article>
              </div>
            </section>

            <section
              v-else-if="settingsTab === 'skills'"
              class="settings-section"
            >
              <div class="settings-heading">
                <h2>Skills</h2>
                <p>
                  Install bounded instruction files. New skills remain disabled
                  until you explicitly enable them.
                </p>
              </div>
              <div class="settings-inline">
                <NInput
                  v-model:value="agent.skillUrl"
                  placeholder="https://example.com/skill.md"
                />
                <NButton
                  secondary
                  :loading="agent.skillsLoading"
                  @click="agent.installSkillFromUrl"
                >
                  Install URL
                </NButton>
              </div>
              <div class="settings-actions">
                <NButton secondary @click="agent.chooseAndInstallSkill">
                  Install file
                </NButton>
                <NButton
                  secondary
                  :loading="agent.skillsLoading"
                  @click="agent.loadSkills(true)"
                >
                  Refresh
                </NButton>
              </div>
              <div class="skill-list">
                <p v-if="!agent.skills.length">No valid skills found.</p>
                <article v-for="skill in agent.skills" :key="skill.name">
                  <div>
                    <strong>{{ skill.name }}</strong>
                    <span>{{ skill.description }}</span>
                    <small>
                      {{ skill.source }} · {{ skill.sha256.slice(0, 12) }}
                    </small>
                  </div>
                  <NSwitch
                    :value="skill.enabled"
                    @update:value="agent.setSkillEnabled(skill.name, $event)"
                  />
                </article>
              </div>
              <NAlert
                v-if="agent.skillDiagnostics.length"
                type="warning"
                title="Some skill files were skipped"
              >
                <div
                  v-for="item in agent.skillDiagnostics"
                  :key="`${item.file}:${item.code}`"
                >
                  {{ item.file }}: {{ item.message }}
                </div>
              </NAlert>
            </section>

            <section v-else class="settings-section">
              <div class="settings-heading">
                <h2>Logging</h2>
                <p>Control full trace capture and local retention limits.</p>
              </div>
              <div class="settings-switch-row">
                <div>
                  <strong>Full trace logging</strong>
                  <p>May contain prompts, code, tool arguments and outputs.</p>
                </div>
                <NSwitch v-model:value="agent.loggingForm.enabled" />
              </div>
              <label class="settings-field">
                <span>Retention days</span>
                <NInputNumber
                  v-model:value="agent.loggingForm.retentionDays"
                  :min="1"
                  :max="3650"
                />
              </label>
              <label class="settings-field">
                <span>Maximum total size (MB)</span>
                <NInputNumber
                  v-model:value="agent.loggingForm.maxTotalMegabytes"
                  :min="1"
                  :max="10000"
                />
              </label>
              <NButton type="primary" @click="agent.saveLogging">
                Save logging settings
              </NButton>
              <div class="settings-actions">
                <NButton secondary @click="agent.openLogDirectory">
                  Open log directory
                </NButton>
                <NButton
                  secondary
                  :loading="agent.tracesLoading"
                  @click="agent.loadTraceData"
                >
                  Refresh traces
                </NButton>
                <NButton secondary type="error" @click="clearClosedTraces">
                  Clear closed traces
                </NButton>
              </div>

              <div v-if="agent.providerStats" class="trace-stats">
                <article>
                  <span>Requests</span>
                  <strong>{{ agent.providerStats.requestCount }}</strong>
                </article>
                <article>
                  <span>Total tokens</span>
                  <strong>{{
                    providerMetric(agent.providerStats.totalTokens)
                  }}</strong>
                </article>
                <article>
                  <span>Cache hit tokens</span>
                  <strong>{{
                    providerMetric(agent.providerStats.cacheHitTokens)
                  }}</strong>
                </article>
                <article>
                  <span>Cache miss tokens</span>
                  <strong>{{
                    providerMetric(agent.providerStats.cacheMissTokens)
                  }}</strong>
                </article>
                <article>
                  <span>Average TTFT</span>
                  <strong>{{
                    providerMetric(agent.providerStats.averageTtftMs, ' ms')
                  }}</strong>
                </article>
                <article>
                  <span>Average latency</span>
                  <strong>{{
                    providerMetric(agent.providerStats.averageTotalMs, ' ms')
                  }}</strong>
                </article>
              </div>

              <div class="trace-debug">
                <h3>Offline replay and fork</h3>
                <NSelect
                  v-model:value="agent.selectedTraceId"
                  :options="agent.traceOptions"
                  clearable
                  placeholder="Select a trace"
                />
                <div class="settings-actions">
                  <NButton
                    secondary
                    :disabled="!agent.selectedTraceId"
                    @click="agent.replaySelectedTrace"
                  >
                    Replay offline
                  </NButton>
                </div>
                <label class="settings-field">
                  <span>Fork from llm.request event ID</span>
                  <NSelect
                    v-model:value="agent.forkEventId"
                    :options="agent.forkPointOptions"
                    filterable
                    tag
                    placeholder="event-..."
                  />
                </label>
                <NButton
                  secondary
                  :disabled="
                    !agent.selectedTraceId || !agent.forkEventId.trim()
                  "
                  @click="agent.forkSelectedTrace"
                >
                  Fork with current provider
                </NButton>
                <p v-if="agent.replaySummary" class="settings-footnote">
                  {{ agent.replaySummary.messages.length }} messages ·
                  {{ agent.replaySummary.toolCount }} tools ·
                  {{ agent.replaySummary.approvalCount }} approvals ·
                  {{ agent.replaySummary.closed ? 'closed' : 'active' }}
                </p>
                <NAlert v-if="agent.traceActionMessage" type="info">
                  {{ agent.traceActionMessage }}
                </NAlert>
              </div>
            </section>
          </div>
        </div>
      </NModal>

      <NModal
        v-model:show="yoloWarningOpen"
        preset="card"
        class="risk-modal"
        title="Enable Yolo mode?"
      >
        <NAlert type="error" title="Host-level side effects">
          Yolo skips risk policy, sensitive-data confirmation, model approval
          and human approval. File changes execute immediately, and later
          command tools may affect the host. Workspace path invariants still
          apply.
        </NAlert>
        <NSpace justify="end" class="modal-actions">
          <NButton @click="yoloWarningOpen = false">Cancel</NButton>
          <NButton type="error" @click="confirmYoloMode"> Enable Yolo </NButton>
        </NSpace>
      </NModal>

      <NModal
        :show="Boolean(renameConversationId)"
        preset="card"
        class="small-modal"
        title="Rename conversation"
        @update:show="renameConversationId = undefined"
      >
        <NInput
          v-model:value="renameValue"
          autofocus
          maxlength="120"
          @keydown.enter.prevent="confirmRename"
        />
        <NSpace justify="end" class="modal-actions">
          <NButton @click="renameConversationId = undefined">Cancel</NButton>
          <NButton type="primary" @click="confirmRename">Rename</NButton>
        </NSpace>
      </NModal>

      <NModal
        :show="Boolean(deleteConversationId)"
        preset="card"
        class="small-modal"
        title="Delete conversation?"
        @update:show="deleteConversationId = undefined"
      >
        <p>
          This removes the local conversation history. Project files are
          unchanged.
        </p>
        <NSpace justify="end" class="modal-actions">
          <NButton @click="deleteConversationId = undefined">Cancel</NButton>
          <NButton type="error" @click="confirmDeleteConversation">
            Delete
          </NButton>
        </NSpace>
      </NModal>

      <NModal
        v-model:show="removeProjectOpen"
        preset="card"
        class="small-modal"
        title="Remove project?"
      >
        <p>
          This removes the project and its local conversations from the app.
          Files on disk are not changed.
        </p>
        <NSpace justify="end" class="modal-actions">
          <NButton @click="removeProjectOpen = false">Cancel</NButton>
          <NButton type="error" @click="confirmRemoveProject">Remove</NButton>
        </NSpace>
      </NModal>

      <NModal
        :show="Boolean(switchConversationId)"
        preset="card"
        class="small-modal"
        title="Stop the current run?"
        @update:show="switchConversationId = undefined"
      >
        <p>The active run must stop before switching conversations.</p>
        <NSpace justify="end" class="modal-actions">
          <NButton @click="switchConversationId = undefined">Cancel</NButton>
          <NButton type="error" @click="confirmConversationSwitch">
            Stop and continue
          </NButton>
        </NSpace>
      </NModal>
    </main>
  </NConfigProvider>
</template>
