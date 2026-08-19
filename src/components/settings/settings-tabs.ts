import type { Component } from 'vue'
import type { ConfigSection } from '../../../shared/ipc/configuration'
import ApplicationSettingsPanel from './ApplicationSettingsPanel.vue'
import ArchivedSessionsSettingsPanel from './ArchivedSessionsSettingsPanel.vue'
import AssistantSettingsPanel from './AssistantSettingsPanel.vue'
import IntegrationsSettingsPanel from './IntegrationsSettingsPanel.vue'
import ModelsSettingsPanel from './ModelsSettingsPanel.vue'
import NetworkSettingsPanel from './NetworkSettingsPanel.vue'
import ProjectSettingsPanel from './ProjectSettingsPanel.vue'
import ProvidersSettingsPanel from './ProvidersSettingsPanel.vue'
import RuntimeSettingsPanel from './RuntimeSettingsPanel.vue'
import SecuritySettingsPanel from './SecuritySettingsPanel.vue'

export type SettingsDomain =
  | 'application'
  | 'assistant'
  | 'integrations'
  | 'models'
  | 'network'
  | 'providers'
  | 'runtime'
  | 'security'

export type SettingsManagementPage = 'project' | 'archived'
export type SettingsTab = SettingsDomain | SettingsManagementPage
export type SettingsPageGroup = 'configuration' | 'management'
export type SettingsPageIcon =
  | 'app'
  | 'file'
  | 'folder'
  | 'settings'
  | 'trash'
  | 'warning'

export interface SettingsPageDefinition {
  id: SettingsTab
  group: SettingsPageGroup
  labelKey: string
  icon: SettingsPageIcon
  sections: readonly ConfigSection[]
  component: Component
}

export const SETTINGS_PAGE_GROUPS: ReadonlyArray<{
  id: SettingsPageGroup
  labelKey: string
}> = [
  { id: 'configuration', labelKey: 'settings.configurationGroup' },
  { id: 'management', labelKey: 'settings.managementGroup' },
]

/**
 * Defines settings navigation, page composition, and configuration ownership in
 * one renderer-owned registry. Internal sections remain owned by their domain
 * even when they are not directly editable in the UI.
 */
export const SETTINGS_PAGES: readonly SettingsPageDefinition[] = [
  {
    id: 'assistant',
    group: 'configuration',
    labelKey: 'settings.assistantDomain',
    icon: 'settings',
    sections: ['assistant', 'prompts'],
    component: AssistantSettingsPanel,
  },
  {
    id: 'models',
    group: 'configuration',
    labelKey: 'settings.modelsDomain',
    icon: 'app',
    sections: ['models', 'modelPool'],
    component: ModelsSettingsPanel,
  },
  {
    id: 'providers',
    group: 'configuration',
    labelKey: 'settings.providersDomain',
    icon: 'settings',
    sections: ['providers'],
    component: ProvidersSettingsPanel,
  },
  {
    id: 'runtime',
    group: 'configuration',
    labelKey: 'settings.runtimeDomain',
    icon: 'app',
    sections: ['subagents', 'executionEnvironment', 'limits'],
    component: RuntimeSettingsPanel,
  },
  {
    id: 'security',
    group: 'configuration',
    labelKey: 'settings.securityDomain',
    icon: 'warning',
    sections: ['permission', 'privacy'],
    component: SecuritySettingsPanel,
  },
  {
    id: 'integrations',
    group: 'configuration',
    labelKey: 'settings.integrationsDomain',
    icon: 'app',
    sections: ['skills', 'mcp', 'webSearch'],
    component: IntegrationsSettingsPanel,
  },
  {
    id: 'network',
    group: 'configuration',
    labelKey: 'settings.networkDomain',
    icon: 'settings',
    sections: ['network'],
    component: NetworkSettingsPanel,
  },
  {
    id: 'application',
    group: 'configuration',
    labelKey: 'settings.applicationDomain',
    icon: 'file',
    sections: ['logging', 'workspace'],
    component: ApplicationSettingsPanel,
  },
  {
    id: 'project',
    group: 'management',
    labelKey: 'settings.project',
    icon: 'folder',
    sections: [],
    component: ProjectSettingsPanel,
  },
  {
    id: 'archived',
    group: 'management',
    labelKey: 'settings.archived',
    icon: 'trash',
    sections: [],
    component: ArchivedSessionsSettingsPanel,
  },
]

/** Resolves one settings page from its stable route id. */
export function findSettingsPage(id: SettingsTab): SettingsPageDefinition {
  return SETTINGS_PAGES.find((page) => page.id === id) ?? SETTINGS_PAGES[0]!
}
