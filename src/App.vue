<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  ref,
} from 'vue'
import { enUS, NConfigProvider, zhCN } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import ConversationTimeline from './components/chat/ConversationTimeline.vue'
import MessageComposer from './components/chat/MessageComposer.vue'
import WorkbenchDialogs from './components/dialogs/WorkbenchDialogs.vue'
import ArtifactPanel from './components/artifacts/ArtifactPanel.vue'
import AppTopbar from './components/layout/AppTopbar.vue'
import ProjectSidebar from './components/projects/ProjectSidebar.vue'
import SettingsModal from './components/settings/SettingsModal.vue'
import { useAgentStore } from './stores/agent'
import type { PermissionMode } from '../shared/config'
import { setAppLocale, type AppLocale } from './i18n'

type SettingsTab =
  | 'general'
  | 'project'
  | 'provider'
  | 'permissions'
  | 'skills'
  | 'logging'

const TerminalPanel = defineAsyncComponent(
  () => import('./components/TerminalPanel.vue'),
)

const agent = useAgentStore()
const { locale, t } = useI18n()
const settingsOpen = ref(false)
const settingsTab = ref<SettingsTab>('general')
const yoloWarningOpen = ref(false)
const projectSidebarOpen = ref(true)
const artifactSidebarOpen = ref(false)
const terminalOpen = ref(false)
const terminalMaximized = ref(false)
const terminalHeight = ref(280)
const renameConversationId = ref<string>()
const renameValue = ref('')
const deleteConversationId = ref<string>()
const switchConversationId = ref<string>()

const projectName = computed(() => {
  if (!agent.workspacePath) {
    return t('app.chooseWorkspace')
  }

  const normalized = agent.workspacePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).at(-1) ?? agent.workspacePath
})
const workspaceLabel = computed(
  () => agent.workspacePath || t('app.noWorkspace'),
)
const activeTitle = computed(() =>
  !agent.activeConversation ||
  agent.activeConversation.title === 'New conversation'
    ? t('app.newConversation')
    : agent.activeConversation.title,
)
const naiveLocale = computed(() => (locale.value === 'zh-CN' ? zhCN : enUS))
const statusLabel = computed(() => {
  if (agent.pendingApproval) {
    return t('app.waitingApproval')
  }

  if (agent.runStatus === 'failed') {
    return t('app.failed')
  }

  if (agent.runStatus === 'cancelling') {
    return t('app.cancelling')
  }

  if (agent.activeRunId) {
    return t('app.running')
  }

  return ''
})
function openSettings(tab: SettingsTab = 'general') {
  settingsTab.value = tab
  settingsOpen.value = true
}

async function selectMode(value: string | number) {
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

  await agent.setMode(value as PermissionMode)
}

async function confirmYoloMode() {
  if (await agent.acceptYoloNotice()) {
    if (await agent.setMode('yolo')) {
      yoloWarningOpen.value = false
    }
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
  if (
    !(await agent.selectConversation(conversationId)) &&
    (agent.activeRunId || agent.pendingApproval)
  ) {
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

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown, { capture: true })
  if (window.innerWidth <= 1080) {
    artifactSidebarOpen.value = false
  }
  await agent.initialize()
  if (agent.assistantForm.language !== locale.value) {
    await agent.saveAssistantSettings(locale.value as AppLocale)
  } else {
    setAppLocale(agent.assistantForm.language)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown, { capture: true })
  agent.dispose()
})
</script>

<template>
  <NConfigProvider :locale="naiveLocale">
    <main
      class="app-frame"
      :class="{
        'project-sidebar-closed': !projectSidebarOpen,
        'artifact-sidebar-closed': !artifactSidebarOpen,
      }"
      data-testid="app-ready"
    >
      <AppTopbar
        :project-name="projectName"
        :workspace-label="workspaceLabel"
        :terminal-open="terminalOpen"
        :project-sidebar-open="projectSidebarOpen"
        :artifact-sidebar-open="artifactSidebarOpen"
        @project="openSettings('project')"
        @terminal="terminalOpen = !terminalOpen"
        @project-sidebar="projectSidebarOpen = !projectSidebarOpen"
        @artifact-sidebar="artifactSidebarOpen = !artifactSidebarOpen"
        @settings="openSettings()"
      />

      <div class="workbench-shell">
        <ProjectSidebar
          :aria-hidden="!projectSidebarOpen"
          @add="agent.chooseWorkspace"
          @create="createConversation"
          @open="openConversation"
          @rename="beginRename"
          @delete="deleteConversationId = $event"
        />

        <section
          class="conversation-pane"
          :style="{ '--terminal-height': terminalHeight + 'px' }"
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

          <ConversationTimeline :project-name="projectName" />

          <MessageComposer
            @mode="selectMode"
            @provider="openSettings('provider')"
          />

          <TerminalPanel
            v-if="terminalOpen"
            @close="closeTerminalPanel"
            @height-change="terminalHeight = $event"
            @maximize-change="terminalMaximized = $event"
          />
        </section>

        <ArtifactPanel :aria-hidden="!artifactSidebarOpen" />
      </div>

      <SettingsModal
        v-model:show="settingsOpen"
        :initial-tab="settingsTab"
        @mode="selectMode"
      />

      <WorkbenchDialogs
        :yolo-open="yoloWarningOpen"
        :rename-open="Boolean(renameConversationId)"
        :rename-value="renameValue"
        :delete-open="Boolean(deleteConversationId)"
        :switch-open="Boolean(switchConversationId)"
        @update:yolo-open="yoloWarningOpen = $event"
        @update:rename-open="!$event && (renameConversationId = undefined)"
        @update:rename-value="renameValue = $event"
        @update:delete-open="!$event && (deleteConversationId = undefined)"
        @update:switch-open="!$event && (switchConversationId = undefined)"
        @confirm-yolo="confirmYoloMode"
        @confirm-rename="confirmRename"
        @confirm-delete="confirmDeleteConversation"
        @confirm-switch="confirmConversationSwitch"
      />
    </main>
  </NConfigProvider>
</template>
