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
  zhCN,
} from 'naive-ui'
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

type Sidebar = 'project' | 'artifact'
type ArtifactTab = 'files' | 'diff' | 'plan'

const PROJECT_SIDEBAR_WIDTH = 240
const ARTIFACT_SIDEBAR_WIDTH = 440
const MIN_CONVERSATION_WIDTH = 440

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
const artifactTab = ref<ArtifactTab>('files')
const workbenchElement = ref<HTMLElement>()
const workbenchWidth = ref(
  typeof window === 'undefined' ? 0 : window.innerWidth,
)
const lastOpenedSidebar = ref<Sidebar>('project')
const terminalOpen = ref(false)
const terminalMaximized = ref(false)
const terminalHeight = ref(280)
const renameConversationId = ref<string>()
const renameValue = ref('')
const deleteConversationId = ref<string>()
const switchConversationId = ref<string>()
const switchNewConversationWorkspace = ref<string>()
const revertMessageId = ref<string>()
const revertMessagePreview = ref('')

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
  () => !artifactSidebarOpen.value && !canOpenArtifactSidebar.value,
)
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
function usageTokens(value: typeof agent.latestUsage): number {
  if (!value) return 0
  return (
    value.totalTokens ??
    (value.promptTokens ?? 0) + (value.completionTokens ?? 0)
  )
}
const usageSummary = computed(() => {
  if (!agent.latestUsage) return ''

  return t('app.usageSummary', {
    latest: usageTokens(agent.latestUsage).toLocaleString(),
    total: agent.conversationTotalTokens.toLocaleString(),
    context: agent.latestUsage.contextWindowTokens.toLocaleString(),
    source: agent.latestUsage.contextWindowSource,
  })
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

async function createConversation(workspacePath?: string) {
  if (agent.activeRunId || agent.pendingApproval) {
    switchConversationId.value = 'new'
    switchNewConversationWorkspace.value = workspacePath
    return
  }

  await agent.newConversation(workspacePath)
}

async function openConversation(conversationId: string) {
  if (
    !(await agent.selectConversation(conversationId)) &&
    (agent.activeRunId || agent.pendingApproval)
  ) {
    switchConversationId.value = conversationId
    switchNewConversationWorkspace.value = undefined
  }
}

async function confirmConversationSwitch() {
  const target = switchConversationId.value
  const targetWorkspace = switchNewConversationWorkspace.value
  switchConversationId.value = undefined
  switchNewConversationWorkspace.value = undefined
  await agent.interruptRun()
  await agent.closeRuntimeSession()

  if (target === 'new') {
    await agent.newConversation(targetWorkspace)
  } else if (target) {
    await agent.selectConversation(target)
  }
}

function closeSwitchDialog() {
  switchConversationId.value = undefined
  switchNewConversationWorkspace.value = undefined
}

function requestRevert(messageId: string, preview: string) {
  if (agent.activeRunId || agent.pendingApproval) return
  revertMessageId.value = messageId
  revertMessagePreview.value = preview
}

async function confirmRevert() {
  const messageId = revertMessageId.value
  revertMessageId.value = undefined
  revertMessagePreview.value = ''
  if (!messageId) return
  await agent.revertConversationAfterMessage(messageId)
}

async function forkFromMessage(messageId: string) {
  if (agent.activeRunId || agent.pendingApproval) return
  await agent.forkConversation(undefined, messageId)
}

async function exportConversation(conversationId: string) {
  const result = await agent.exportConversationViaDialog(conversationId)
  if (!result.canceled && result.error) {
    agent.error = t('dialogs.exportFailed') + ': ' + result.error
  }
}

async function importConversation() {
  if (agent.activeRunId || agent.pendingApproval) return
  const result = await agent.importConversationViaDialog()
  if (result.error) {
    agent.error = t('dialogs.importFailed') + ': ' + result.error
  } else if (!result.canceled && result.conversationId) {
    agent.error = ''
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
  <NConfigProvider :locale="naiveLocale" inline-theme-disabled>
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
        @settings="openSettings()"
      />

      <div ref="workbenchElement" class="workbench-shell">
        <NLayout
          class="workbench-layout"
          content-style="height: 100%; overflow: hidden"
          has-sider
        >
          <NLayoutSider
            :width="PROJECT_SIDEBAR_WIDTH"
            :collapsed-width="0"
            :collapsed="!projectSidebarOpen"
            :show-collapsed-content="false"
            content-style="overflow: hidden"
            collapse-mode="width"
            :show-trigger="false"
            bordered
          >
            <ProjectSidebar
              :aria-hidden="!projectSidebarOpen"
              @add="agent.chooseWorkspace"
              @create="createConversation"
              @open="openConversation"
              @rename="beginRename"
              @delete="deleteConversationId = $event"
              @export="exportConversation"
              @import="importConversation"
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
                    <p v-if="usageSummary" class="usage-summary">
                      {{ usageSummary }}
                    </p>
                  </div>
                  <span
                    v-if="statusLabel"
                    class="run-status"
                    :class="
                      agent.pendingApproval ? 'approval' : agent.runStatus
                    "
                  >
                    <span></span>{{ statusLabel }}
                  </span>
                </header>

                <ConversationTimeline
                  :project-name="projectName"
                  @revert="requestRevert"
                  @fork="forkFromMessage"
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
        :revert-open="Boolean(revertMessageId)"
        :revert-message-preview="revertMessagePreview"
        @update:yolo-open="yoloWarningOpen = $event"
        @update:rename-open="!$event && (renameConversationId = undefined)"
        @update:rename-value="renameValue = $event"
        @update:delete-open="!$event && (deleteConversationId = undefined)"
        @update:switch-open="!$event && closeSwitchDialog()"
        @update:revert-open="!$event && (revertMessageId = undefined)"
        @confirm-yolo="confirmYoloMode"
        @confirm-rename="confirmRename"
        @confirm-delete="confirmDeleteConversation"
        @confirm-switch="confirmConversationSwitch"
        @confirm-revert="confirmRevert"
      />
    </main>
  </NConfigProvider>
</template>
