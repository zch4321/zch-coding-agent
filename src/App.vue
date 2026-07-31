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
  enUS,
  NConfigProvider,
  NLayout,
  NLayoutContent,
  NLayoutSider,
  NMessageProvider,
  zhCN,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import ConversationHeader from './components/chat/ConversationHeader.vue'
import ConversationTimeline from './components/chat/ConversationTimeline.vue'
import MessageComposer from './components/chat/MessageComposer.vue'
import WorkbenchDialogs from './components/dialogs/WorkbenchDialogs.vue'
import SessionTranscriptViewer from './components/transcript/SessionTranscriptViewer.vue'
import ArtifactPanel from './components/artifacts/ArtifactPanel.vue'
import AppTopbar from './components/layout/AppTopbar.vue'
import AppMessageBridge from './components/layout/AppMessageBridge.vue'
import ProjectSidebar from './components/projects/ProjectSidebar.vue'
import SettingsNavigation from './components/settings/SettingsNavigation.vue'
import SettingsPage from './components/settings/SettingsPage.vue'
import { useAgentStore } from './stores/agent'
import type { PermissionMode } from '../shared/config'
import { setAppLocale, type AppLocale } from './i18n'
import { naiveThemeOverrides } from './theme/naive-theme'
import type { SettingsTab } from './components/settings/settings-tabs'

type Sidebar = 'project' | 'artifact'
type ArtifactTab = 'files' | 'diff' | 'plan' | 'project'
type AppView = 'chat' | 'settings'
type MessageAction = 'edit' | 'fork' | 'retry'

const PROJECT_SIDEBAR_WIDTH = 360
const SETTINGS_SIDEBAR_WIDTH = 240
const ARTIFACT_SIDEBAR_WIDTH = 440
const MIN_CONVERSATION_WIDTH = 440

const TerminalPanel = defineAsyncComponent(
  () => import('./components/TerminalPanel.vue'),
)

const agent = useAgentStore()
const { locale, t } = useI18n()
const activeView = ref<AppView>('chat')
const settingsTab = ref<SettingsTab>('general')
const yoloWarningOpen = ref(false)
const projectSidebarOpen = ref(true)
const artifactSidebarOpen = ref(false)
const artifactTab = ref<ArtifactTab>('files')
const workbenchElement = ref<HTMLElement>()
const workbenchWidth = ref(
  typeof window === 'undefined' ? 0 : window.innerWidth,
)
const lastOpenedSidebar = ref<Sidebar>('project')
const terminalOpen = ref(false)
const terminalMaximized = ref(false)
const terminalHeight = ref(280)
const renameSessionId = ref<string>()
const renameValue = ref('')
const deleteSessionId = ref<string>()
const revertMessageId = ref<string>()
const revertMessagePreview = ref('')
const messageAction = ref<MessageAction>()
const messageActionId = ref<string>()
const yoloPending = ref(false)
const renamePending = ref(false)
const deletePending = ref(false)
const revertPending = ref(false)
const messageActionPending = ref(false)

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
const leftSidebarWidth = computed(() =>
  activeView.value === 'settings'
    ? SETTINGS_SIDEBAR_WIDTH
    : PROJECT_SIDEBAR_WIDTH,
)
const canOpenProjectSidebar = computed(
  () => workbenchWidth.value >= PROJECT_SIDEBAR_WIDTH + MIN_CONVERSATION_WIDTH,
)
const canOpenArtifactSidebar = computed(
  () => workbenchWidth.value >= ARTIFACT_SIDEBAR_WIDTH + MIN_CONVERSATION_WIDTH,
)
const canOpenBothSidebars = computed(
  () =>
    workbenchWidth.value >=
    PROJECT_SIDEBAR_WIDTH + MIN_CONVERSATION_WIDTH + ARTIFACT_SIDEBAR_WIDTH,
)
const projectSidebarDisabled = computed(
  () => !projectSidebarOpen.value && !canOpenProjectSidebar.value,
)
const artifactSidebarDisabled = computed(
  () =>
    activeView.value === 'settings' ||
    (!artifactSidebarOpen.value && !canOpenArtifactSidebar.value),
)
function openSettings(tab: SettingsTab = 'general') {
  settingsTab.value = tab
  activeView.value = 'settings'
  projectSidebarOpen.value = true
  artifactSidebarOpen.value = false
}

function closeSettings() {
  activeView.value = 'chat'
  void agent.selectProviderForEditing(agent.activeProviderId)
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
  if (yoloPending.value) return
  yoloPending.value = true
  try {
    if (await agent.acceptYoloNotice()) {
      if (await agent.setMode('yolo')) {
        yoloWarningOpen.value = false
      }
    }
  } finally {
    yoloPending.value = false
  }
}

async function createConversation(workspacePath?: string) {
  await agent.newConversation(workspacePath)
}

async function openConversation(sessionId: string) {
  await agent.selectConversation(sessionId)
}

function requestRevert(messageId: string, preview: string) {
  if (agent.startPending || agent.activeRunId || agent.pendingApproval) return
  revertMessageId.value = messageId
  revertMessagePreview.value = preview
}

async function confirmRevert() {
  if (revertPending.value) return
  const messageId = revertMessageId.value
  if (!messageId) return
  revertPending.value = true
  try {
    await agent.revertConversationAfterMessage(messageId)
    revertMessageId.value = undefined
    revertMessagePreview.value = ''
  } finally {
    revertPending.value = false
  }
}

function requestMessageAction(action: MessageAction, messageId: string) {
  if (agent.startPending || agent.activeRunId || agent.pendingApproval) return
  messageAction.value = action
  messageActionId.value = messageId
}

function updateMessageAction(value?: MessageAction) {
  messageAction.value = value
  if (!value) messageActionId.value = undefined
}

async function confirmMessageAction() {
  if (messageActionPending.value) return
  const action = messageAction.value
  const messageId = messageActionId.value
  if (!action || !messageId) return
  messageActionPending.value = true
  messageAction.value = undefined
  messageActionId.value = undefined
  try {
    switch (action) {
      case 'retry':
        await agent.retryUserMessage(messageId)
        break
      case 'edit':
        await agent.editUserMessage(messageId)
        break
      case 'fork':
        await agent.forkConversation(undefined, messageId)
        break
    }
  } finally {
    messageActionPending.value = false
  }
}

function beginRename(sessionId: string) {
  const conversation = agent.conversations.find((item) => item.id === sessionId)

  if (!conversation) {
    return
  }

  renameSessionId.value = sessionId
  renameValue.value = conversation.title
}

async function confirmRename() {
  if (!renameSessionId.value || renamePending.value) return
  renamePending.value = true
  try {
    await agent.renameConversation(renameSessionId.value, renameValue.value)
    renameSessionId.value = undefined
  } finally {
    renamePending.value = false
  }
}

async function confirmDeleteConversation() {
  if (!deleteSessionId.value || deletePending.value) return
  deletePending.value = true
  try {
    await agent.deleteConversation(deleteSessionId.value)
    deleteSessionId.value = undefined
  } finally {
    deletePending.value = false
  }
}

function closeTerminalPanel() {
  terminalOpen.value = false
  terminalMaximized.value = false
}

function reconcileSidebars() {
  if (!canOpenProjectSidebar.value) {
    projectSidebarOpen.value = false
  }

  if (!canOpenArtifactSidebar.value) {
    artifactSidebarOpen.value = false
  }

  if (
    projectSidebarOpen.value &&
    artifactSidebarOpen.value &&
    !canOpenBothSidebars.value
  ) {
    if (lastOpenedSidebar.value === 'project') {
      artifactSidebarOpen.value = false
    } else {
      projectSidebarOpen.value = false
    }
  }
}

function measureWorkbench() {
  const measuredWidth = workbenchElement.value?.clientWidth ?? 0
  workbenchWidth.value = measuredWidth || window.innerWidth
  reconcileSidebars()
}

function toggleProjectSidebar() {
  if (projectSidebarOpen.value) {
    projectSidebarOpen.value = false
    return
  }

  if (!canOpenProjectSidebar.value) return
  lastOpenedSidebar.value = 'project'

  if (artifactSidebarOpen.value && !canOpenBothSidebars.value) {
    artifactSidebarOpen.value = false
  }

  projectSidebarOpen.value = true
}

function toggleArtifactSidebar() {
  if (artifactSidebarOpen.value) {
    artifactSidebarOpen.value = false
    return
  }

  openArtifactSidebar()
}

function openArtifactSidebar() {
  if (activeView.value === 'settings') return
  if (!canOpenArtifactSidebar.value) return
  lastOpenedSidebar.value = 'artifact'

  if (projectSidebarOpen.value && !canOpenBothSidebars.value) {
    projectSidebarOpen.value = false
  }

  artifactSidebarOpen.value = true
}

watch(
  () => agent.plan?.id,
  (planId, previousPlanId) => {
    if (!planId || planId === previousPlanId) return
    artifactTab.value = 'plan'
    openArtifactSidebar()
  },
)

let workbenchResizeObserver: ResizeObserver | undefined

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
    toggleArtifactSidebar()
  } else if (event.key.toLocaleLowerCase() === 'b') {
    event.preventDefault()
    toggleProjectSidebar()
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown, { capture: true })
  window.addEventListener('resize', measureWorkbench)
  measureWorkbench()

  if (workbenchElement.value && typeof ResizeObserver !== 'undefined') {
    workbenchResizeObserver = new ResizeObserver(measureWorkbench)
    workbenchResizeObserver.observe(workbenchElement.value)
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
  window.removeEventListener('resize', measureWorkbench)
  workbenchResizeObserver?.disconnect()
  workbenchResizeObserver = undefined
  agent.dispose()
})
</script>

<template>
  <NConfigProvider
    :locale="naiveLocale"
    :theme-overrides="naiveThemeOverrides"
    inline-theme-disabled
  >
    <NMessageProvider
      placement="top"
      :max="5"
      :container-style="{ top: '58px' }"
    >
      <AppMessageBridge />
      <main class="app-frame" data-testid="app-ready">
        <AppTopbar
          :project-name="projectName"
          :workspace-label="workspaceLabel"
          :terminal-open="terminalOpen"
          :project-sidebar-open="projectSidebarOpen"
          :artifact-sidebar-open="artifactSidebarOpen"
          :project-sidebar-disabled="projectSidebarDisabled"
          :artifact-sidebar-disabled="artifactSidebarDisabled"
          @project="openSettings('project')"
          @terminal="terminalOpen = !terminalOpen"
          @project-sidebar="toggleProjectSidebar"
          @artifact-sidebar="toggleArtifactSidebar"
        />

        <div ref="workbenchElement" class="workbench-shell">
          <NLayout
            class="workbench-layout"
            content-style="height: 100%; overflow: hidden"
            has-sider
          >
            <NLayoutSider
              :width="leftSidebarWidth"
              :collapsed-width="0"
              :collapsed="!projectSidebarOpen"
              :show-collapsed-content="false"
              content-style="overflow: hidden"
              collapse-mode="width"
              :show-trigger="false"
              bordered
            >
              <SettingsNavigation
                v-if="activeView === 'settings'"
                :active-tab="settingsTab"
                :aria-hidden="!projectSidebarOpen"
                @update:active-tab="settingsTab = $event"
                @close="closeSettings"
              />
              <ProjectSidebar
                v-else
                :aria-hidden="!projectSidebarOpen"
                @add="agent.chooseWorkspace"
                @create="createConversation"
                @open="openConversation"
                @rename="beginRename"
                @delete="deleteSessionId = $event"
                @settings="openSettings()"
              />
            </NLayoutSider>

            <NLayout
              class="workbench-main-layout"
              content-style="height: 100%; overflow: hidden"
              has-sider
              sider-placement="right"
            >
              <NLayoutContent
                class="conversation-layout"
                content-class="conversation-layout-content"
                content-style="overflow: hidden"
              >
                <SettingsPage
                  v-if="activeView === 'settings'"
                  :active-tab="settingsTab"
                  @close="closeSettings"
                  @mode="selectMode"
                />
                <section
                  v-else
                  class="conversation-pane"
                  :style="{ '--terminal-height': terminalHeight + 'px' }"
                  :class="{
                    'terminal-open': terminalOpen,
                    'terminal-maximized': terminalOpen && terminalMaximized,
                  }"
                >
                  <ConversationHeader
                    :active-title="activeTitle"
                    :project-name="projectName"
                  />

                  <ConversationTimeline
                    :project-name="projectName"
                    @revert="requestRevert"
                    @fork="requestMessageAction('fork', $event)"
                    @retry="requestMessageAction('retry', $event)"
                    @edit="requestMessageAction('edit', $event)"
                  />

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
              </NLayoutContent>

              <NLayoutSider
                v-if="activeView === 'chat'"
                :width="ARTIFACT_SIDEBAR_WIDTH"
                :collapsed-width="0"
                :collapsed="!artifactSidebarOpen"
                :show-collapsed-content="false"
                content-style="overflow: hidden"
                collapse-mode="width"
                :show-trigger="false"
                bordered
              >
                <ArtifactPanel
                  v-model:active-tab="artifactTab"
                  :aria-hidden="!artifactSidebarOpen"
                />
              </NLayoutSider>
            </NLayout>
          </NLayout>
        </div>

        <WorkbenchDialogs
          :yolo-open="yoloWarningOpen"
          :rename-open="Boolean(renameSessionId)"
          :rename-value="renameValue"
          :delete-open="Boolean(deleteSessionId)"
          :revert-open="Boolean(revertMessageId)"
          :revert-message-preview="revertMessagePreview"
          :message-action="messageAction"
          :yolo-pending="yoloPending"
          :rename-pending="renamePending"
          :delete-pending="deletePending"
          :revert-pending="revertPending"
          :message-action-pending="messageActionPending"
          @update:yolo-open="yoloWarningOpen = $event"
          @update:rename-open="!$event && (renameSessionId = undefined)"
          @update:rename-value="renameValue = $event"
          @update:delete-open="!$event && (deleteSessionId = undefined)"
          @update:revert-open="!$event && (revertMessageId = undefined)"
          @update:message-action="updateMessageAction"
          @confirm-yolo="confirmYoloMode"
          @confirm-rename="confirmRename"
          @confirm-delete="confirmDeleteConversation"
          @confirm-revert="confirmRevert"
          @confirm-message-action="confirmMessageAction"
        />
        <SessionTranscriptViewer />
      </main>
    </NMessageProvider>
  </NConfigProvider>
</template>
