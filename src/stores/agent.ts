import type { Pinia } from 'pinia'
import type { ProjectId } from '../../shared/ids'
import { useAgentChangesStore } from './agent-changes'
import { useAgentReplicaStore } from './agent-replica'
import { useAgentRuntimeStore } from './agent-runtime'
import { useAgentSettingsStore } from './agent-settings'
import { useAgentShellStore } from './agent-shell'
import type { ProjectView, SessionView } from './agent-types'

export type {
  ChatMessage,
  PendingApproval,
  ProjectView,
  ReviewedApproval,
  SessionView,
  ToolActivity,
} from './agent-types'

type ShellStore = ReturnType<typeof useAgentShellStore>
type SettingsStore = ReturnType<typeof useAgentSettingsStore>
type ReplicaStore = ReturnType<typeof useAgentReplicaStore>
type RuntimeStore = ReturnType<typeof useAgentRuntimeStore>
type ChangesStore = ReturnType<typeof useAgentChangesStore>

export type AgentFacade = Omit<ShellStore, '$id'> &
  Omit<
    SettingsStore,
    | 'error'
    | '$id'
    | 'limitsSavedSignature'
    | 'subagentsSavedSignature'
    | 'savePermissions'
    | 'removeRememberedRule'
  > &
  Omit<ReplicaStore, 'error' | '$id' | 'projects'> &
  Omit<RuntimeStore, '$id' | 'draftModelSelection'> &
  Omit<ChangesStore, 'error' | '$id' | 'revertChange'> & {
    workspacePath: string
    projects: ProjectView[]
    conversations: SessionView[]
    activeConversationId?: string
    activeConversation?: SessionView
    goal: SessionView['goal']
    plan: SessionView['plan']
    savePermissions(): Promise<void>
    removeRememberedRule(ruleId: string): Promise<void>
    revertChange(changeId: string): Promise<boolean>
    searchSessions(text: string, projectId?: ProjectId): Promise<void>
    setProviderDraftModel(model: string): void
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
  'activeProviderId',
  'selectedProviderId',
  'providers',
  'builtinPolicies',
  'rememberedRules',
  'defaultMode',
  'modelProfiles',
  'modelCatalogFetchedAt',
  'modelCatalogStale',
  'modelCatalogLoading',
  'limitsConfig',
  'limitsSaving',
  'limitsSaveStatus',
  'subagentsConfig',
  'subagentsSaving',
  'subagentsSaveStatus',
  'providerForm',
  'providerSavedSignature',
  'providerSaving',
  'providerSaveStatus',
  'approvalForm',
  'approvalSavedSignature',
  'approvalSaving',
  'approvalSaveStatus',
  'permissionForm',
  'loggingForm',
  'loggingWarnings',
  'assistantForm',
  'assistantSaving',
  'assistantSaveStatus',
  'providerNoticeAccepted',
  'traceNoticeAccepted',
  'yoloNoticeAccepted',
  'credentialConfigured',
  'credentialSource',
  'selectedCredentialConfigured',
  'selectedCredentialSource',
  'activeProvider',
  'selectedProvider',
  'modelOptions',
  'providerOptions',
  'approvalModelOptions',
  'providerCardSummaries',
  'activeModelProfile',
  'providerDirty',
  'providerRefreshAvailable',
  'limitsDirty',
  'subagentsDirty',
  'approvalDirty',
])
const replicaProperties = new Set<PropertyKey>([
  'selectedProjectId',
  'selectedSessionId',
  'messagesBySessionId',
  'fileChangesBySessionId',
  'runtimeBySessionId',
  'traceCaptureBySessionId',
  'sessionHasMore',
  'sessionNextBefore',
  'messageHasMoreBySessionId',
  'messageNextBeforeSeqBySessionId',
  'fileChangeHasMoreBySessionId',
  'fileChangeNextBeforeBySessionId',
  'selectedMessageHasMore',
  'selectedFileChangeHasMore',
  'selectedTraceCapture',
  'cursor',
  'searchHits',
  'loading',
])
const runtimeProperties = new Set<PropertyKey>([
  'input',
  'contextAttachments',
  'mode',
  'overlays',
  'workspaceWriters',
  'approvalSubmitting',
  'workspaceFileRevision',
  'sessionId',
  'activeRunId',
  'startPending',
  'runStatus',
  'pendingApproval',
  'messages',
  'tools',
  'usage',
  'latestUsage',
  'latestReviewedApproval',
  'modeLockedByWriter',
  'modeLockTooltip',
  'modeSyncError',
  'canSend',
  'canInterject',
  'composerModelSelection',
  'composerProviderId',
  'composerModel',
  'composerReasoning',
  'composerModelOptions',
])
const changesProperties = new Set<PropertyKey>([
  'changes',
  'changesLoading',
  'revertingChangeId',
])

function projectViews(replica: ReplicaStore): ProjectView[] {
  return replica.projects.map((project) => ({
    id: project.id,
    path: project.path,
    name: project.name,
    addedAt: project.createdAt,
  }))
}

function sessionViews(replica: ReplicaStore): SessionView[] {
  const projects = new Map(
    replica.projects.map((project) => [project.id, project]),
  )
  return replica.sessions
    .filter((session) => session.lifecycle === 'active')
    .map((session) => ({
      id: session.id,
      projectId: session.projectId,
      projectPath: projects.get(session.projectId)?.path ?? '',
      title: session.title,
      model: session.modelSelection.model,
      mode: session.permissionMode,
      goal: session.goal ?? undefined,
      plan: session.plan ?? undefined,
      parentId: session.parent?.sessionId,
      forkedAt: session.parent ? session.createdAt : undefined,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      revision: session.revision,
      archived: false,
    }))
}

/** Creates the facade that combines shell, settings, replica, and runtime Pinia stores. */
export function useAgentStore(pinia?: Pinia): AgentFacade {
  const shell = useAgentShellStore(pinia)
  const settings = useAgentSettingsStore(pinia)
  const replica = useAgentReplicaStore(pinia)
  const runtime = useAgentRuntimeStore(pinia)
  const changes = useAgentChangesStore(pinia)

  const actions: Record<PropertyKey, unknown> = {
    initialize: runtime.initialize,
    dispose: runtime.dispose,
    applyConfig: runtime.applyConfig,
    newConversation: runtime.newConversation,
    selectConversation: runtime.selectConversation,
    renameConversation: runtime.renameConversation,
    deleteConversation: runtime.deleteConversation,
    forkConversation: runtime.forkConversation,
    rewindMessage: runtime.rewindMessage,
    revertConversationAfterMessage: runtime.revertConversationAfterMessage,
    retryUserMessage: runtime.retryUserMessage,
    editUserMessage: runtime.editUserMessage,
    removeCurrentProject: runtime.removeCurrentProject,
    chooseWorkspace: runtime.chooseWorkspace,
    setMode: runtime.setMode,
    hydrateSelectedProviderForm: settings.hydrateSelectedProviderForm,
    selectProviderForEditing: settings.selectProviderForEditing,
    resetSelectedProviderDraft: settings.resetSelectedProviderDraft,
    setProviderModel: runtime.setProviderModel,
    setProviderReasoning: runtime.setProviderReasoning,
    setProviderDraftModel: settings.setProviderModel,
    updateModelConfiguration: settings.updateModelConfiguration,
    loadProviderModels: settings.loadProviderModels,
    enterProviderSettings: settings.enterProviderSettings,
    refreshSelectedProviderModels: settings.refreshSelectedProviderModels,
    saveProviderModelConfigurationSelection:
      settings.saveProviderModelConfigurationSelection,
    setActiveProvider: runtime.setActiveProvider,
    createProvider: settings.createProvider,
    copyProvider: settings.copyProvider,
    deleteProvider: settings.deleteProvider,
    saveProvider: settings.saveProvider,
    setApprovalProvider: settings.setApprovalProvider,
    saveApproval: settings.saveApproval,
    clearCredential: settings.clearCredential,
    saveLimits: settings.saveLimits,
    saveSubagents: settings.saveSubagents,
    savePermissions: () => settings.savePermissions(runtime.mode),
    removeRememberedRule: (ruleId: string) =>
      settings.removeRememberedRule(ruleId, runtime.mode),
    saveLogging: settings.saveLogging,
    acceptProviderNotice: settings.acceptProviderNotice,
    acceptYoloNotice: settings.acceptYoloNotice,
    saveAssistantSettings: runtime.saveAssistantSettings,
    updatePlanStatus: runtime.updatePlanStatus,
    approvePlan: runtime.approvePlan,
    rejectPlan: runtime.rejectPlan,
    loadConversationChanges: changes.loadConversationChanges,
    loadOlderConversationChanges: changes.loadOlderConversationChanges,
    revertChange: (changeId: string) =>
      changes.revertChange(
        changeId,
        Boolean(
          runtime.startPending ||
          runtime.activeRunId ||
          runtime.pendingApproval,
        ),
      ),
    sendMessage: runtime.sendMessage,
    sendInterjection: runtime.sendInterjection,
    chooseContextAttachment: runtime.chooseContextAttachment,
    addContextAttachments: runtime.addContextAttachments,
    removeContextAttachment: runtime.removeContextAttachment,
    interruptRun: runtime.interruptRun,
    decideApproval: runtime.decideApproval,
    handleAgentEvent: runtime.handleAgentEvent,
    clearDiagnostics: runtime.clearDiagnostics,
    conversationIsBusy: runtime.conversationIsBusy,
    conversationStatus: runtime.conversationStatus,
    searchSessions: replica.search,
    loadOlderSessions: replica.loadOlderSessions,
    loadOlderMessages: replica.loadOlderMessages,
    loadOlderFileChanges: replica.loadOlderFileChanges,
  }

  const targetStore = (property: PropertyKey): object | undefined => {
    if (shellProperties.has(property)) return shell
    if (settingsProperties.has(property)) return settings
    if (replicaProperties.has(property)) return replica
    if (runtimeProperties.has(property)) return runtime
    if (changesProperties.has(property)) return changes
    return undefined
  }

  return new Proxy({} as AgentFacade, {
    get(_target, property) {
      if (property === 'workspacePath') {
        return replica.selectedProject?.path ?? ''
      }
      if (property === 'projects') return projectViews(replica)
      if (property === 'conversations') return sessionViews(replica)
      if (property === 'activeConversationId') {
        return replica.selectedSessionId
      }
      if (property === 'activeConversation') {
        return sessionViews(replica).find(
          (session) => session.id === replica.selectedSessionId,
        )
      }
      if (property === 'goal') {
        return (
          runtime.activeOverlay?.goal ??
          replica.selectedSession?.goal ??
          undefined
        )
      }
      if (property === 'plan') {
        return (
          runtime.activeOverlay?.plan ??
          replica.selectedSession?.plan ??
          undefined
        )
      }
      if (Object.hasOwn(actions, property)) return actions[property]
      return Reflect.get(targetStore(property) ?? {}, property)
    },
    set(_target, property, value) {
      const store = targetStore(property)
      return store ? Reflect.set(store, property, value) : false
    },
    has(_target, property) {
      return Object.hasOwn(actions, property) || Boolean(targetStore(property))
    },
  })
}
