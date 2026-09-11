import { combineStoreMembers, pickStoreMembers } from './store-facade'
import type { Pinia } from 'pinia'
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
import type { ContextAttachmentChip } from '../../shared/context'
import { useComposerDraftsStore } from './composer-drafts'
import { selectedDraftTarget } from './composer-draft-view'

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

export type AgentFacade = ReturnType<typeof useAgentStore>

const shellProperties = [
  'initialized',
  'bridgeAvailable',
  'unsubscribers',
] as const satisfies readonly (keyof ShellStore)[]
const providerSettingsProperties = [
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
] as const satisfies readonly (keyof ProviderSettingsStore)[]
const runtimeSettingsProperties = [
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
] as const satisfies readonly (keyof RuntimeSettingsStore)[]
const securitySettingsProperties = [
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
] as const satisfies readonly (keyof SecuritySettingsStore)[]
const networkSettingsProperties = [
  'networkConfig',
  'networkSaving',
  'networkSaveStatus',
  'networkDirty',
] as const satisfies readonly (keyof NetworkSettingsStore)[]
const applicationSettingsProperties = [
  'loggingForm',
  'loggingWarnings',
  'runtimeLogStatus',
  'runtimeLogActionMessage',
] as const satisfies readonly (keyof ApplicationSettingsStore)[]
const assistantSettingsProperties = [
  'assistantForm',
  'assistantSaving',
  'assistantSaveStatus',
] as const satisfies readonly (keyof AssistantSettingsStore)[]
const modelRolesProperties = [
  'defaultModelProvider',
  'defaultModel',
  'defaultModelReasoning',
  'auxiliaryModelProvider',
  'auxiliaryModel',
  'auxiliaryModelReasoning',
  'rolesSaving',
  'rolesSaveStatus',
] as const satisfies readonly (keyof ModelRolesStore)[]
const replicaProperties = [
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
] as const satisfies readonly (keyof ReplicaStore)[]
const runtimeProperties = [
  'mode',
  'overlays',
  'approvalSubmitting',
  'sessionId',
  'activeRunId',
  'startPending',
  'pendingDraftStarts',
  'runStatus',
  'pendingApproval',
  'timelineTurns',
  'currentTodo',
  'usage',
  'approvalUsageByCallId',
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
] as const satisfies readonly (keyof RuntimeStore)[]
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
export function useAgentStore(pinia?: Pinia) {
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
  const drafts = useComposerDraftsStore(pinia)

  const actions = {
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
    providerTokenDefaults: providerSettings.providerTokenDefaults,
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

  const views = {
    get input(): string {
      const target = selectedDraftTarget(replica)
      return target ? drafts.get(target).text : ''
    },
    set input(value: string) {
      const target = selectedDraftTarget(replica)
      if (target) drafts.setText(target, value)
    },
    get contextAttachments(): ContextAttachmentChip[] {
      const target = selectedDraftTarget(replica)
      return target ? drafts.get(target).attachments : []
    },
    set contextAttachments(value: ContextAttachmentChip[]) {
      const target = selectedDraftTarget(replica)
      if (target) drafts.set(target, drafts.get(target).text, value)
    },
    get workspacePath() {
      return replica.selectedProject?.path ?? ''
    },
    get projects() {
      return projectViews(replica)
    },
    get conversations() {
      return sessionViews(replica)
    },
    get activeConversationId() {
      return replica.selectedSessionId
    },
    get activeConversation() {
      return sessionViews(replica).find(
        (session) => session.id === replica.selectedSessionId,
      )
    },
    get goal() {
      return (
        runtime.activeOverlay?.goal ??
        replica.selectedSession?.goal ??
        undefined
      )
    },
    get plan() {
      return (
        runtime.activeOverlay?.plan ??
        replica.selectedSession?.plan ??
        undefined
      )
    },
  }
  return combineStoreMembers(
    pickStoreMembers(shell, shellProperties),
    pickStoreMembers(modelRoles, modelRolesProperties),
    pickStoreMembers(providerSettings, providerSettingsProperties),
    pickStoreMembers(runtimeSettings, runtimeSettingsProperties),
    pickStoreMembers(securitySettings, securitySettingsProperties),
    pickStoreMembers(networkSettings, networkSettingsProperties),
    pickStoreMembers(applicationSettings, applicationSettingsProperties),
    pickStoreMembers(assistantSettings, assistantSettingsProperties),
    pickStoreMembers(replica, replicaProperties),
    pickStoreMembers(runtime, runtimeProperties),
    Object.freeze(actions),
    views,
  )
}
