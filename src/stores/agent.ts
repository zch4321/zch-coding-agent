import type { Pinia } from 'pinia'
import type { ProjectId } from '../../shared/ids'
import { useApplicationSettingsStore } from './application-settings'
import { useAssistantSettingsStore } from './assistant-settings'
import { useModelRolesStore } from './model-roles'
import { useAgentReplicaStore } from './agent-replica'
import { useAgentRuntimeStore } from './agent-runtime'
import { useProviderSettingsStore } from './agent-settings'
import { useAgentShellStore } from './agent-shell'
import { useNetworkSettingsStore } from './network-settings'
import { useRuntimeSettingsStore } from './runtime-settings'
import { useSecuritySettingsStore } from './security-settings'
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
type ApplicationSettingsStore = ReturnType<typeof useApplicationSettingsStore>
type AssistantSettingsStore = ReturnType<typeof useAssistantSettingsStore>
type NetworkSettingsStore = ReturnType<typeof useNetworkSettingsStore>
type ProviderSettingsStore = ReturnType<typeof useProviderSettingsStore>
type RuntimeSettingsStore = ReturnType<typeof useRuntimeSettingsStore>
type SecuritySettingsStore = ReturnType<typeof useSecuritySettingsStore>
type ReplicaStore = ReturnType<typeof useAgentReplicaStore>
type RuntimeStore = ReturnType<typeof useAgentRuntimeStore>

type HiddenSettingsMembers =
  | '$id'
  | '$state'
  | '$patch'
  | '$reset'
  | '$subscribe'
  | '$onAction'
  | '$dispose'
  | 'error'
  | 'applyConfig'

export type AgentFacade = Omit<ShellStore, '$id'> &
  Omit<ModelRolesStore, 'error' | '$id' | 'applyConfig' | 'persistRoles'> &
  Omit<
    ProviderSettingsStore,
    | HiddenSettingsMembers
    | 'providerSavedSignature'
    | 'loadSelectedProviderModelsOnEntry'
  > &
  Omit<
    RuntimeSettingsStore,
    HiddenSettingsMembers | 'limitsSavedSignature' | 'subagentsSavedSignature'
  > &
  Omit<
    SecuritySettingsStore,
    | HiddenSettingsMembers
    | 'permissionSavedSignature'
    | 'acceptNotice'
    | 'acceptTraceNotice'
  > &
  Omit<NetworkSettingsStore, HiddenSettingsMembers | 'networkSavedSignature'> &
  Omit<ApplicationSettingsStore, HiddenSettingsMembers> &
  Omit<AssistantSettingsStore, HiddenSettingsMembers> &
  Omit<ReplicaStore, 'error' | '$id' | 'projects'> &
  Omit<RuntimeStore, '$id' | 'draftModelSelection'> & {
    workspacePath: string
    projects: ProjectView[]
    conversations: SessionView[]
    activeConversationId?: string
    activeConversation?: SessionView
    goal: SessionView['goal']
    plan: SessionView['plan']
    savePermissions(): Promise<boolean>
    removeRememberedRule(ruleId: string): Promise<boolean>
    searchSessions(text: string, projectId?: ProjectId): Promise<void>
    setProviderDraftModel(model: string): void
  }

const shellProperties = new Set<PropertyKey>([
  'initialized',
  'bridgeAvailable',
  'unsubscribers',
])
const providerSettingsProperties = new Set<PropertyKey>([
  'selectedProviderId',
  'providers',
  'modelProfiles',
  'modelCatalogFetchedAt',
  'modelCatalogStale',
  'modelCatalogLoading',
  'pendingModelCatalogRefreshProviderId',
  'providerForm',
  'providerSaving',
  'providerSaveStatus',
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
])
const runtimeSettingsProperties = new Set<PropertyKey>([
  'limitsConfig',
  'limitsSaving',
  'limitsSaveStatus',
  'limitsDirty',
  'subagentsConfig',
  'subagentsSaving',
  'subagentsSaveStatus',
  'subagentsDirty',
  'executionEnvironmentConfig',
  'commandShellCatalog',
  'commandShellLoading',
  'commandShellSaving',
  'commandShellSaveStatus',
])
const securitySettingsProperties = new Set<PropertyKey>([
  'providerNoticeVersion',
  'traceNoticeVersion',
  'yoloNoticeVersion',
  'builtinPolicies',
  'rememberedRules',
  'defaultMode',
  'permissionForm',
  'permissionsSaving',
  'permissionsSaveStatus',
  'permissionsDirty',
  'providerNoticeAccepted',
  'traceNoticeAccepted',
  'yoloNoticeAccepted',
])
const networkSettingsProperties = new Set<PropertyKey>([
  'networkConfig',
  'networkSaving',
  'networkSaveStatus',
  'networkDirty',
])
const applicationSettingsProperties = new Set<PropertyKey>([
  'loggingForm',
  'loggingWarnings',
  'runtimeLogStatus',
  'runtimeLogActionMessage',
])
const assistantSettingsProperties = new Set<PropertyKey>([
  'assistantForm',
  'assistantSaving',
  'assistantSaveStatus',
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
  'runtimeBySessionId',
  'traceCaptureBySessionId',
  'sessionHasMore',
  'sessionNextBefore',
  'messageHasMoreBySessionId',
  'messageNextBeforeSeqBySessionId',
  'selectedMessageHasMore',
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
  'approvalSubmitting',
  'workspaceFileRevision',
  'sessionId',
  'activeRunId',
  'startPending',
  'runStatus',
  'pendingApproval',
  'timelineTurns',
  'currentTodo',
  'usage',
  'latestUsage',
  'latestReviewedApproval',
  'modeSyncError',
  'canSend',
  'canInterject',
  'manualContinuationTarget',
  'composerModelSelection',
  'composerProviderId',
  'composerModel',
  'composerCredentialConfigured',
  'composerReasoning',
  'composerReasoningValid',
  'composerModelOptions',
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
  const applicationSettings = useApplicationSettingsStore(pinia)
  const assistantSettings = useAssistantSettingsStore(pinia)
  const networkSettings = useNetworkSettingsStore(pinia)
  const providerSettings = useProviderSettingsStore(pinia)
  const runtimeSettings = useRuntimeSettingsStore(pinia)
  const securitySettings = useSecuritySettingsStore(pinia)
  const modelRoles = useModelRolesStore(pinia)
  const replica = useAgentReplicaStore(pinia)
  const runtime = useAgentRuntimeStore(pinia)

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
    continueConversation: runtime.continueConversation,
    editUserMessage: runtime.editUserMessage,
    removeProject: runtime.removeProject,
    chooseWorkspace: runtime.chooseWorkspace,
    setMode: runtime.setMode,
    hydrateSelectedProviderForm: providerSettings.hydrateSelectedProviderForm,
    selectProviderForEditing: providerSettings.selectProviderForEditing,
    resetSelectedProviderDraft: providerSettings.resetSelectedProviderDraft,
    setProviderModel: runtime.setProviderModel,
    setComposerProvider: runtime.setComposerProvider,
    setProviderReasoning: runtime.setProviderReasoning,
    setProviderDraftModel: providerSettings.setProviderModel,
    addProviderModel: providerSettings.addProviderModel,
    deleteProviderModel: providerSettings.deleteProviderModel,
    updateModelConfiguration: providerSettings.updateModelConfiguration,
    updateModelAnnotation: providerSettings.updateModelAnnotation,
    loadProviderModels: providerSettings.loadProviderModels,
    enterProviderSettings: providerSettings.enterProviderSettings,
    refreshSelectedProviderModels:
      providerSettings.refreshSelectedProviderModels,

    createProvider: providerSettings.createProvider,
    copyProvider: providerSettings.copyProvider,
    deleteProvider: providerSettings.deleteProvider,
    saveProvider: providerSettings.saveProvider,
    setDefaultModelRole: modelRoles.setDefaultModelRole,
    setAuxiliaryModelRole: modelRoles.setAuxiliaryModelRole,
    clearCredential: providerSettings.clearCredential,
    saveLimits: runtimeSettings.saveLimits,
    saveSubagents: runtimeSettings.saveSubagents,
    loadCommandShells: runtimeSettings.loadCommandShells,
    setCommandShell: runtimeSettings.setCommandShell,
    saveNetwork: networkSettings.saveNetwork,
    savePermissions: securitySettings.savePermissions,
    removeRememberedRule: securitySettings.removeRememberedRule,
    saveLogging: applicationSettings.saveLogging,
    loadRuntimeLogStatus: applicationSettings.loadRuntimeLogStatus,
    openRuntimeLogDirectory: applicationSettings.openRuntimeLogDirectory,
    clearRuntimeLogs: applicationSettings.clearRuntimeLogs,
    acceptProviderNotice: securitySettings.acceptProviderNotice,
    acceptYoloNotice: securitySettings.acceptYoloNotice,
    saveAssistantSettings: assistantSettings.saveAssistantSettings,
    updatePlanStatus: runtime.updatePlanStatus,
    approvePlan: runtime.approvePlan,
    rejectPlan: runtime.rejectPlan,
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
    searchSessions: replica.search,
    loadOlderSessions: replica.loadOlderSessions,
    loadOlderMessages: replica.loadOlderMessages,
  }

  const targetStore = (property: PropertyKey): object | undefined => {
    if (shellProperties.has(property)) return shell
    if (modelRolesProperties.has(property)) return modelRoles
    if (providerSettingsProperties.has(property)) return providerSettings
    if (runtimeSettingsProperties.has(property)) return runtimeSettings
    if (securitySettingsProperties.has(property)) return securitySettings
    if (networkSettingsProperties.has(property)) return networkSettings
    if (applicationSettingsProperties.has(property)) return applicationSettings
    if (assistantSettingsProperties.has(property)) return assistantSettings
    if (replicaProperties.has(property)) return replica
    if (runtimeProperties.has(property)) return runtime
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
