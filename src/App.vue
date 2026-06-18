<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NConfigProvider,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
} from 'naive-ui'
import MarkdownBlock from './components/MarkdownBlock.vue'
import { useAgentStore, type ToolActivity } from './stores/agent'
import { IPC_VERSION } from '../shared/channels'

type ArtifactTab = 'files' | 'browser' | 'terminal' | 'diff'

const agent = useAgentStore()
const settingsOpen = ref(false)
const activeArtifact = ref<ArtifactTab>('files')

const reasoningOptions = [
  { label: 'Reasoning auto', value: 'auto' },
  { label: 'Reasoning off', value: 'off' },
]
const modeOptions = [
  { label: 'ReadOnly', value: 'readonly' },
  { label: 'Auto', value: 'auto' },
  { label: 'Confirm', value: 'confirm' },
  { label: 'Yolo', value: 'yolo' },
]
const artifactTabs: Array<{ label: string; value: ArtifactTab }> = [
  { label: 'Files', value: 'files' },
  { label: 'Browser', value: 'browser' },
  { label: 'Terminal', value: 'terminal' },
  { label: 'Diff', value: 'diff' },
]

const projectName = computed(() => {
  if (!agent.workspacePath) {
    return 'No workspace'
  }

  const normalized = agent.workspacePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? agent.workspacePath
})
const workspaceLabel = computed(() => agent.workspacePath || 'Choose workspace')
const runBadgeClass = computed(() => {
  if (agent.pendingApproval) {
    return 'approval'
  }

  if (agent.runStatus === 'failed') {
    return 'failed'
  }

  if (agent.activeRunId) {
    return 'calling'
  }

  return 'idle'
})
const runLabel = computed(() => {
  if (!agent.sessionId) {
    return 'NO SESSION'
  }

  if (agent.pendingApproval) {
    return 'APPROVAL'
  }

  return agent.runStatus.replace(/_/g, ' ').toUpperCase()
})
const chronologicalTools = computed(() => [...agent.tools].reverse())
const activeThreadSubtitle = computed(() =>
  agent.activeRunId
    ? '1 active thread · run currently active'
    : agent.sessionId
      ? '1 active thread · no run currently active'
      : 'No active session · configure from settings',
)
const lastReadFile = computed(() => {
  for (const tool of agent.tools) {
    const content = okContent(tool)

    if (
      tool.tool === 'read_file' &&
      content &&
      typeof content === 'object' &&
      !Array.isArray(content)
    ) {
      const fileContent = content as Record<string, unknown>

      if (
        typeof fileContent.path !== 'string' ||
        typeof fileContent.content !== 'string'
      ) {
        continue
      }

      return {
        path: fileContent.path,
        content: fileContent.content,
        totalBytes:
          typeof fileContent.totalBytes === 'number'
            ? fileContent.totalBytes
            : null,
        truncated:
          typeof fileContent.truncated === 'boolean'
            ? fileContent.truncated
            : false,
      }
    }
  }

  return undefined
})
const fileEntries = computed(() => {
  for (const tool of agent.tools) {
    const content = okContent(tool)

    if (
      (tool.tool === 'list_dir' || tool.tool === 'glob') &&
      content &&
      typeof content === 'object' &&
      !Array.isArray(content)
    ) {
      const rawEntries =
        'entries' in content
          ? content.entries
          : 'matches' in content
            ? content.matches
            : undefined

      if (Array.isArray(rawEntries)) {
        return rawEntries.slice(0, 12).map((entry) => {
          if (typeof entry === 'string') {
            return { path: entry, type: 'file' }
          }

          if (
            entry &&
            typeof entry === 'object' &&
            'path' in entry &&
            typeof entry.path === 'string'
          ) {
            return {
              path: entry.path,
              type:
                'type' in entry && typeof entry.type === 'string'
                  ? entry.type
                  : 'file',
            }
          }

          return { path: String(entry), type: 'file' }
        })
      }
    }
  }

  return []
})
const fileLines = computed(() =>
  (lastReadFile.value?.content ?? '').split(/\r?\n/).slice(0, 80),
)

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
    return 'pending'
  }

  if (!('status' in result) || typeof result.status !== 'string') {
    return 'completed'
  }

  if (result.status !== 'ok') {
    return result.status
  }

  const totalBytes =
    'totalBytes' in result && typeof result.totalBytes === 'number'
      ? `${Math.round(result.totalBytes / 100) / 10}KB`
      : 'ok'
  const truncated =
    'truncated' in result && result.truncated ? 'truncated' : 'not truncated'
  return `${totalBytes} · ${truncated}`
}

function toolArgsPreview(tool: ToolActivity): string {
  return JSON.stringify(tool.args, null, 2)
}

function openSettings() {
  settingsOpen.value = true
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

function selectArtifact(tab: ArtifactTab) {
  activeArtifact.value = tab
}

onMounted(() => {
  void agent.initialize()
})

onUnmounted(() => {
  agent.dispose()
})
</script>

<template>
  <NConfigProvider>
    <main class="app-frame" data-testid="app-ready">
      <header class="app-topbar">
        <div class="window-title">
          <span class="app-mark">CA</span>
          <strong>My Coding Agent</strong>
        </div>

        <button class="project-crumb" type="button" @click="openSettings">
          <span class="icon">□</span>
          <span>{{ projectName }}</span>
        </button>

        <div class="topbar-actions">
          <button class="toolbar-button" type="button">Share</button>
          <button class="icon-button" type="button" @click="openSettings">
            Settings
          </button>
          <div class="window-controls" aria-label="Window controls">
            <button
              class="window-control"
              type="button"
              aria-label="Minimize window"
              @click="minimizeWindow"
            >
              _
            </button>
            <button
              class="window-control"
              type="button"
              aria-label="Maximize or restore window"
              @click="toggleMaximizeWindow"
            >
              □
            </button>
            <button
              class="window-control close"
              type="button"
              aria-label="Close window"
              @click="closeWindow"
            >
              ×
            </button>
          </div>
        </div>
      </header>

      <div class="workbench-shell">
        <aside class="thread-sidebar">
          <button class="new-task-button" type="button" @click="openSettings">
            <span>＋</span>
            <strong>New task</strong>
          </button>

          <section class="nav-section">
            <p class="nav-title">TODAY</p>
            <button class="thread-item active" type="button">
              <span class="thread-icon">▢</span>
              <span>Design frontend layout</span>
            </button>
            <button class="thread-item" type="button">
              <span class="thread-icon">▢</span>
              <span>Review IPC contracts</span>
            </button>
            <button class="thread-item" type="button">
              <span class="thread-icon">▢</span>
              <span>Path guard tests</span>
            </button>
          </section>

          <section class="nav-section">
            <p class="nav-title">PROJECT</p>
            <button class="project-item" type="button" @click="openSettings">
              <span class="thread-icon">□</span>
              <span>{{ projectName }}</span>
            </button>
          </section>

          <p class="sidebar-note">
            Sidebar only switches threads and project context. Mode, model and
            workspace controls live in composer/settings.
          </p>
        </aside>

        <section class="chat-pane">
          <header class="chat-header">
            <div>
              <h1>设计前端主页</h1>
              <p>{{ activeThreadSubtitle }}</p>
            </div>
            <span class="run-badge" :class="runBadgeClass">
              <span class="badge-dot"></span>
              {{ runLabel }}
            </span>
          </header>

          <div class="chat-scroll" aria-label="对话流">
            <NAlert
              v-if="!agent.bridgeAvailable && agent.initialized"
              type="warning"
              title="Bridge unavailable"
              class="inline-alert"
            >
              当前在测试或预览环境中，window.agentApi 不可用。
            </NAlert>

            <NAlert
              v-if="!agent.providerNoticeAccepted"
              type="info"
              title="首次外发告知"
              class="inline-alert"
            >
              消息、代码片段和只读工具结果可能会发送给 DeepSeek
              Provider。确认后仅记录版本和时间，不记录密钥。
              <div class="notice-action">
                <NButton
                  size="small"
                  type="primary"
                  @click="agent.acceptProviderNotice"
                >
                  我已了解
                </NButton>
              </div>
            </NAlert>

            <NAlert
              v-if="agent.error"
              type="error"
              title="结构化错误"
              class="inline-alert"
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
                <span v-if="message.role === 'assistant' && agent.activeRunId">
                  streaming
                </span>
              </div>
              <MarkdownBlock :content="message.text || '...'" />
              <NCollapse v-if="message.reasoning" class="reasoning">
                <NCollapseItem title="Reasoning hidden" name="reasoning">
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
                <strong>{{ tool.tool }}</strong>
                <span
                  class="tool-status"
                  :class="tool.status === 'completed' ? 'ok' : 'pending'"
                >
                  {{ toolResultSummary(tool) }}
                </span>
              </div>
              <p v-if="tool.reason" class="tool-reason">
                Reason: {{ tool.reason }}
              </p>
              <pre>{{ toolArgsPreview(tool) }}</pre>
              <NCollapse v-if="tool.result">
                <NCollapseItem title="Result" :name="tool.callId">
                  <pre>{{ JSON.stringify(tool.result, null, 2) }}</pre>
                </NCollapseItem>
              </NCollapse>
            </article>

            <article v-if="agent.pendingApproval" class="approval-card">
              <div class="approval-header">
                <strong>Approval required</strong>
                <span>CONTEXT</span>
              </div>
              <p>
                Tool result matched sensitive context rules before entering the
                next provider request.
              </p>
              <ul>
                <li
                  v-for="signal in agent.pendingApproval.signals"
                  :key="signal.code + signal.detail"
                >
                  {{ signal.detail }}
                </li>
              </ul>
              <NSpace>
                <NButton type="primary" @click="agent.decideApproval('allow')">
                  Approve
                </NButton>
                <NButton secondary @click="agent.decideApproval('deny')">
                  Deny
                </NButton>
              </NSpace>
            </article>

            <div
              v-if="
                agent.messages.length === 0 &&
                chronologicalTools.length === 0 &&
                !agent.pendingApproval
              "
              class="empty-thread"
            >
              <p class="empty-eyebrow">Agent ready</p>
              <h2>从底部输入开始，只读检查 workspace。</h2>
              <p>
                Provider、workspace、trace 和 API key 都在右上角设置里配置；
                主界面保持为线程、对话和 Artifact 面板。
              </p>
            </div>
          </div>

          <footer class="prompt-composer">
            <NInput
              v-model:value="agent.input"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 5 }"
              placeholder="Ask the agent to inspect files, summarize code, or open the terminal..."
              @keydown.ctrl.enter.prevent="agent.sendMessage"
            />
            <div class="composer-bottom">
              <div class="composer-pills">
                <button
                  class="composer-pill"
                  type="button"
                  @click="openSettings"
                >
                  DeepSeek⌄
                </button>
                <NSelect
                  v-model:value="agent.mode"
                  class="mode-pill"
                  size="small"
                  :options="modeOptions"
                />
                <button
                  class="composer-pill"
                  type="button"
                  @click="selectArtifact('terminal')"
                >
                  >_ Terminal
                </button>
              </div>
              <button
                v-if="agent.activeRunId"
                class="send-button interrupt"
                type="button"
                aria-label="Interrupt"
                @click="agent.interruptRun"
              >
                ×
              </button>
              <button
                v-else
                class="send-button"
                type="button"
                aria-label="Send"
                :disabled="!agent.canSend"
                @click="agent.sendMessage"
              >
                ↑
              </button>
            </div>
          </footer>
        </section>

        <aside class="artifact-panel">
          <header class="artifact-header">
            <div>
              <h2>
                {{
                  activeArtifact === 'files'
                    ? 'Files'
                    : activeArtifact === 'browser'
                      ? 'Browser'
                      : activeArtifact === 'terminal'
                        ? 'Terminal'
                        : 'Diff'
                }}
              </h2>
            </div>
            <p>{{ workspaceLabel }}</p>
            <nav class="artifact-tabs" aria-label="Artifact tabs">
              <button
                v-for="tab in artifactTabs"
                :key="tab.value"
                type="button"
                :class="{ active: activeArtifact === tab.value }"
                @click="selectArtifact(tab.value)"
              >
                {{ tab.label }}
              </button>
            </nav>
          </header>

          <section class="artifact-body">
            <div v-if="activeArtifact === 'files'" class="file-artifact">
              <div class="file-tabs">
                <button
                  class="file-tab"
                  type="button"
                  :class="{ active: !lastReadFile }"
                >
                  ⊞ Explorer
                </button>
                <button
                  v-if="lastReadFile"
                  class="file-tab active"
                  type="button"
                >
                  ▣ {{ lastReadFile.path }}
                  <span>×</span>
                </button>
              </div>

              <div v-if="lastReadFile" class="file-viewer">
                <div class="file-viewer-header">
                  <strong>{{ lastReadFile.path }}</strong>
                  <span>read-only</span>
                </div>
                <div class="code-preview">
                  <div
                    v-for="(line, index) in fileLines"
                    :key="index"
                    class="code-line"
                  >
                    <span>{{ String(index + 1).padStart(2, '0') }}</span>
                    <code>{{ line || ' ' }}</code>
                  </div>
                </div>
              </div>

              <div v-else class="explorer-view">
                <p class="artifact-muted">
                  Explorer shows workspace paths only when list_dir or glob has
                  returned data.
                </p>
                <ul v-if="fileEntries.length > 0" class="file-list">
                  <li v-for="entry in fileEntries" :key="entry.path">
                    <span>{{ entry.type === 'directory' ? '□' : '▣' }}</span>
                    {{ entry.path }}
                  </li>
                </ul>
              </div>

              <div class="terminal-note">
                >_ Terminal output uses this same artifact panel when the
                Terminal tab is selected.
              </div>
            </div>

            <div
              v-else-if="activeArtifact === 'browser'"
              class="empty-artifact"
            >
              <h3>Browser Preview</h3>
              <p>
                P2 does not open an embedded browser yet. This tab is reserved
                for P4/P5 preview workflows.
              </p>
            </div>

            <div
              v-else-if="activeArtifact === 'terminal'"
              class="empty-artifact terminal-artifact"
            >
              <h3>>_ Terminal</h3>
              <p>
                Persistent terminal arrives in P4. This location matches the
                design: terminal output appears in the right Artifact Panel, not
                in the left sidebar.
              </p>
            </div>

            <div v-else class="empty-artifact">
              <h3>Diff Review</h3>
              <template v-if="agent.pendingApproval">
                <p>Context approval is waiting.</p>
                <ul>
                  <li
                    v-for="signal in agent.pendingApproval.signals"
                    :key="signal.code + signal.detail"
                  >
                    {{ signal.detail }}
                  </li>
                </ul>
              </template>
              <p v-else>
                Write/edit/delete diff review starts in P3. P2 remains workspace
                read-only.
              </p>
            </div>
          </section>
        </aside>
      </div>

      <NModal v-model:show="settingsOpen" preset="card" class="settings-modal">
        <template #header>Settings · session setup</template>
        <div class="settings-grid">
          <section class="settings-section">
            <h3>DeepSeek</h3>
            <NSpace vertical size="small">
              <NInput
                v-model:value="agent.providerForm.baseURL"
                placeholder="Base URL"
              />
              <NInput
                v-model:value="agent.providerForm.model"
                placeholder="Model"
              />
              <NSelect
                v-model:value="agent.providerForm.reasoning"
                :options="reasoningOptions"
              />
              <NInput
                v-model:value="agent.providerForm.apiKey"
                type="password"
                show-password-on="click"
                placeholder="API key, only sent to main process"
              />
              <NButton secondary type="primary" @click="agent.saveProvider">
                Save Provider
              </NButton>
              <NTag :type="agent.credentialConfigured ? 'success' : 'warning'">
                {{
                  agent.credentialConfigured
                    ? 'Credential set'
                    : 'No credential'
                }}
              </NTag>
            </NSpace>
          </section>

          <section class="settings-section">
            <h3>Workspace & Mode</h3>
            <NSpace vertical size="small">
              <NButton secondary @click="agent.chooseWorkspace">
                Choose workspace
              </NButton>
              <p class="settings-path">{{ workspaceLabel }}</p>
              <NSelect v-model:value="agent.mode" :options="modeOptions" />
              <div class="switch-row">
                <span>Full trace</span>
                <NSwitch
                  :value="agent.traceLoggingRequested"
                  @update:value="agent.setTraceLogging"
                />
              </div>
              <NButton
                type="primary"
                :disabled="!agent.canCreateSession"
                @click="agent.createSession"
              >
                Start session
              </NButton>
              <NButton
                secondary
                :disabled="!agent.sessionId"
                @click="agent.closeSession"
              >
                Close session
              </NButton>
            </NSpace>
          </section>

          <section class="settings-section notice-section">
            <h3>Notices</h3>
            <NAlert
              v-if="!agent.providerNoticeAccepted"
              type="info"
              title="Provider data egress"
            >
              Messages, code snippets and bounded read-only tool results may be
              sent to the configured Provider.
              <div class="notice-action">
                <NButton
                  size="small"
                  type="primary"
                  @click="agent.acceptProviderNotice"
                >
                  Accept
                </NButton>
              </div>
            </NAlert>
            <NAlert v-else type="success" title="Provider notice accepted">
              Only the notice version and timestamp are stored.
            </NAlert>
          </section>
        </div>
      </NModal>
    </main>
  </NConfigProvider>
</template>
