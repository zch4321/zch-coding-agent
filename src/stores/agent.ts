import type { Pinia } from 'pinia'
import { useAgentChangesStore } from './agent-changes'
import { useAgentRuntimeStore } from './agent-runtime'
import { useAgentSettingsStore } from './agent-settings'
import { useAgentShellStore } from './agent-shell'
import { useAgentTimelineStore } from './agent-timeline'
import { useAgentWorkbenchStore } from './agent-workbench'

export type {
  ChatMessage,
  ConversationRecord,
  PendingApproval,
  ProjectRecord,
  ReviewedApproval,
  ToolActivity,
} from './agent-types'

type ShellStore = ReturnType<typeof useAgentShellStore>
type SettingsStore = ReturnType<typeof useAgentSettingsStore>
type WorkbenchStore = ReturnType<typeof useAgentWorkbenchStore>
type TimelineStore = ReturnType<typeof useAgentTimelineStore>
type RuntimeStore = ReturnType<typeof useAgentRuntimeStore>
type ChangesStore = ReturnType<typeof useAgentChangesStore>

export type AgentFacade = Omit<ShellStore, 'error' | '$id'> &
  Omit<
    SettingsStore,
    'error' | '$id' | 'savePermissions' | 'removeRememberedRule'
  > &
  Omit<WorkbenchStore, 'error' | '$id'> &
  Omit<TimelineStore, '$id'> &
  Omit<RuntimeStore, 'error' | '$id'> &
  Omit<ChangesStore, 'error' | '$id' | 'revertChange'> & {
    error: string
    savePermissions(): Promise<void>
    removeRememberedRule(ruleId: string): Promise<void>
    revertChange(changeId: string): Promise<boolean>
  }

const shellProperties = new Set<PropertyKey>([
  'initialized',
  'bridgeAvailable',
  'unsubscribers',
])
const settingsProperties = new Set<PropertyKey>([
  'providerNoticeVersion',
  'traceNoticeVersion',
  'yoloNoticeVersion',
  'credentialConfiguredValue',
  'credentialSource',
  'providers',
  'builtinPolicies',
  'rememberedRules',
  'defaultMode',
  'modelProfiles',
  'modelCatalogFetchedAt',
  'modelCatalogStale',
  'modelCatalogLoading',
  'modelOverrides',
  'limitsConfig',
  'providerForm',
  'providerSavedSignature',
  'providerSaving',
  'providerSaveStatus',
  'permissionForm',
  'loggingForm',
  'assistantForm',
  'assistantSaving',
  'assistantSaveStatus',
  'providerNoticeAccepted',
  'traceNoticeAccepted',
  'yoloNoticeAccepted',
  'credentialConfigured',
  'modelOptions',
  'providerOptions',
  'activeModelProfile',
  'providerDirty',
])
const workbenchProperties = new Set<PropertyKey>([
  'workspacePath',
  'projects',
  'conversations',
  'activeConversationId',
  'activeConversation',
])
const timelineProperties = new Set<PropertyKey>([
  'input',
  'messages',
  'tools',
  'usage',
  'contextAttachments',
  'goal',
  'plan',
  'timelineCounter',
  'latestReviewedApproval',
  'latestUsage',
  'conversationTotalTokens',
])
const runtimeProperties = new Set<PropertyKey>([
  'sessionIdsByConversation',
  'sessionId',
  'activeRunId',
  'runStatus',
  'mode',
  'pendingApproval',
  'lastAgentSeqBySession',
  'agentEventGap',
  'approvalSubmitting',
  'canSend',
])
const changesProperties = new Set<PropertyKey>([
  'changes',
  'changesLoading',
  'revertingChangeId',
  'workspaceFileRevision',
])

/**
 * Compatibility facade for existing renderer components.
 *
 * State reads and writes are forwarded instead of copied, so Vue still tracks
 * the owning Pinia store. New code should import the focused domain store.
 */
export function useAgentStore(pinia?: Pinia): AgentFacade {
  const shell = useAgentShellStore(pinia)
  const settings = useAgentSettingsStore(pinia)
  const workbench = useAgentWorkbenchStore(pinia)
  const timeline = useAgentTimelineStore(pinia)
  const runtime = useAgentRuntimeStore(pinia)
  const changes = useAgentChangesStore(pinia)

  const actions: Record<PropertyKey, unknown> = {
    initialize: runtime.initialize,
    dispose: runtime.dispose,
    applyConfig: runtime.applyConfig,
    registerProject: workbench.registerProject,
    createConversation: runtime.createConversation,
    newConversation: runtime.newConversation,
    selectConversation: runtime.selectConversation,
    renameConversation: runtime.renameConversation,
    deleteConversation: runtime.deleteConversation,
    removeCurrentProject: runtime.removeCurrentProject,
    restoreActiveConversation: runtime.restoreActiveConversation,
    saveActiveConversation: runtime.saveActiveConversation,
    schedulePersist: runtime.schedulePersist,
    persistWorkbench: runtime.persistWorkbench,
    activateWorkspace: runtime.activateWorkspace,
    saveAssistantSettings: runtime.saveAssistantSettings,
    chooseWorkspace: runtime.chooseWorkspace,
    setMode: runtime.setMode,
    syncModelOverride: settings.syncModelOverride,
    setProviderModel: settings.setProviderModel,
    loadProviderModels: settings.loadProviderModels,
    saveProvider: async () => {
      const saved = await settings.saveProvider()
      if (saved) runtime.schedulePersist(false)
      return saved
    },
    clearCredential: settings.clearCredential,
    savePermissions: () => settings.savePermissions(runtime.mode),
    removeRememberedRule: (ruleId: string) =>
      settings.removeRememberedRule(ruleId, runtime.mode),
    saveLogging: settings.saveLogging,
    acceptProviderNotice: settings.acceptProviderNotice,
    acceptYoloNotice: settings.acceptYoloNotice,
    createSession: runtime.createSession,
    loadConversationChanges: changes.loadConversationChanges,
    revertChange: (changeId: string) =>
      changes.revertChange(
        changeId,
        Boolean(runtime.activeRunId || runtime.pendingApproval),
      ),
    closeRuntimeSession: runtime.closeRuntimeSession,
    sendMessage: runtime.sendMessage,
    chooseContextAttachment: runtime.chooseContextAttachment,
    addContextAttachments: timeline.addContextAttachments,
    removeContextAttachment: timeline.removeContextAttachment,
    interruptRun: runtime.interruptRun,
    decideApproval: runtime.decideApproval,
    handleAgentEvent: runtime.handleAgentEvent,
    assistantMessage: timeline.assistantMessage,
    nextTimelineOrder: timeline.nextTimelineOrder,
  }

  const targetStore = (property: PropertyKey): object | undefined => {
    if (shellProperties.has(property)) return shell
    if (settingsProperties.has(property)) return settings
    if (workbenchProperties.has(property)) return workbench
    if (timelineProperties.has(property)) return timeline
    if (runtimeProperties.has(property)) return runtime
    if (changesProperties.has(property)) return changes
    return undefined
  }

  return new Proxy({} as AgentFacade, {
    get(_target, property) {
      if (property === 'error') {
        return (
          shell.error ||
          runtime.error ||
          settings.error ||
          workbench.error ||
          changes.error
        )
      }
      if (Object.hasOwn(actions, property)) return actions[property]
      return Reflect.get(targetStore(property) ?? {}, property)
    },
    set(_target, property, value) {
      if (property === 'error') {
        shell.error = String(value)
        if (!value) {
          runtime.error = ''
          settings.error = ''
          workbench.error = ''
          changes.error = ''
        }
        return true
      }
      const store = targetStore(property)
      return store ? Reflect.set(store, property, value) : false
    },
    has(_target, property) {
      return (
        property === 'error' ||
        Object.hasOwn(actions, property) ||
        Boolean(targetStore(property))
      )
    },
  })
}
