import type { Pinia } from 'pinia'
import type { ProjectId } from '../../shared/ids'
import { useAgentChangesStore } from './agent-changes'
import { useModelRolesStore } from './model-roles'
import { useAgentReplicaStore } from './agent-replica'
import { useAgentRuntimeStore } from './agent-runtime'
import { useAgentSettingsStore } from './agent-settings'
import { useAgentShellStore } from './agent-shell'
import type { ProjectView, SessionView } from './agent-types'

export type {
  ChatMessage,
  ConversationTurn,
  PendingApproval,
  ProjectView,
  ReviewedApproval,
  ReasoningSegment,
  SessionView,
  ToolActivity,
} from './agent-types'

type ShellStore = ReturnType<typeof useAgentShellStore>
type ModelRolesStore = ReturnType<typeof useModelRolesStore>
type SettingsStore = ReturnType<typeof useAgentSettingsStore>
type ReplicaStore = ReturnType<typeof useAgentReplicaStore>
type RuntimeStore = ReturnType<typeof useAgentRuntimeStore>
type ChangesStore = ReturnType<typeof useAgentChangesStore>

export type AgentFacade = Omit<ShellStore, '$id'> &
  Omit<ModelRolesStore, 'error' | '$id' | 'applyConfig' | 'persistRoles'> &
  Omit<
    SettingsStore,
    | 'error'
    | '$id'
    | 'limitsSavedSignature'
    | 'subagentsSavedSignature'
    | 'permissionSavedSignature'
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
    savePermissions(): Promise<boolean>
    removeRememberedRule(ruleId: string): Promise<boolean>
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
  'pendingModelCatalogRefreshProviderId',
  'limitsConfig',
  'limitsSaving',
  'limitsSaveStatus',
  'subagentsConfig',
  'subagentsSaving',
  'subagentsSaveStatus',
  'executionEnvironmentConfig',
  'commandShellCatalog',
  'commandShellLoading',
  'commandShellSaving',
  'commandShellSaveStatus',
  'providerForm',
  'providerSavedSignature',
  'providerSaving',
  'providerSaveStatus',
  'permissionForm',
  'permissionsSaving',
  'permissionsSaveStatus',
  'permissionsDirty',
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
  'allModelOptions',
  'modelTransferOptions',
  'providerOptions',
  'providerCardSummaries',
  'activeModelProfile',
  'providerDirty',
  'providerRefreshAvailable',
  'limitsDirty',
  'subagentsDirty',
])
const modelRolesProperties = new Set<PropertyKey>([
  'defaultModelProvider',
  'defaultModel',
  'defaultModelReasoning',
  'auxiliaryModelProvider',
  'auxiliaryModel',
  'auxiliaryModelReasoning',
  'rolesSaving',
  'rolesSaveStatus',
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
  'timelineTurns',
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
  'composerCredentialConfigured',
  'composerReasoning',
  'composerReasoningValid',
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
  const modelRoles = useModelRolesStore(pinia)
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
    exportConversationMarkdown: runtime.exportConversationMarkdown,
    forkConversation: runtime.forkConversation,
    rewindMessage: runtime.rewindMessage,
    revertConversationAfterMessage: runtime.revertConversationAfterMessage,
    retryUserMessage: runtime.retryUserMessage,
    editUserMessage: runtime.editUserMessage,
    removeProject: runtime.removeProject,
    chooseWorkspace: runtime.chooseWorkspace,
    setMode: runtime.setMode,
    hydrateSelectedProviderForm: settings.hydrateSelectedProviderForm,
    selectProviderForEditing: settings.selectProviderForEditing,
    resetSelectedProviderDraft: settings.resetSelectedProviderDraft,
    setProviderModel: runtime.setProviderModel,
    setComposerProvider: runtime.setComposerProvider,
    setProviderReasoning: runtime.setProviderReasoning,
    setProviderDraftModel: settings.setProviderModel,
    addProviderModel: settings.addProviderModel,
    deleteProviderModel: settings.deleteProviderModel,
    updateModelConfiguration: settings.updateModelConfiguration,
    updateModelAnnotation: settings.updateModelAnnotation,
    loadProviderModels: settings.loadProviderModels,
    enterProviderSettings: settings.enterProviderSettings,
    refreshSelectedProviderModels: settings.refreshSelectedProviderModels,

    createProvider: settings.createProvider,
    copyProvider: settings.copyProvider,
    deleteProvider: settings.deleteProvider,
    saveProvider: settings.saveProvider,
    setDefaultModelRole: modelRoles.setDefaultModelRole,
    setAuxiliaryModelRole: modelRoles.setAuxiliaryModelRole,
    clearCredential: settings.clearCredential,
    saveLimits: settings.saveLimits,
    saveSubagents: settings.saveSubagents,
    loadCommandShells: settings.loadCommandShells,
    setCommandShell: settings.setCommandShell,
    savePermissions: settings.savePermissions,
    removeRememberedRule: settings.removeRememberedRule,
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
    if (modelRolesProperties.has(property)) return modelRoles
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
