<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NEmpty,
  NForm,
  NFormItem,
  NGi,
  NGrid,
  NInput,
  NInputNumber,
  NList,
  NListItem,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  NThing,
  type SelectOption,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
  CodeBackendStatus,
  ProjectModel,
  SerenaLanguageBackend,
  SerenaLogLevel,
  SerenaProjectMode,
} from '../../../shared/project-model'
import { buildSerenaLaunchPreview } from '../../../shared/serena-launch'
import { useAgentStore } from '../../stores/agent'
import { useAgentProjectStore } from '../../stores/agent-project'

const agent = useAgentStore()
const project = useAgentProjectStore()
const { t } = useI18n()
const commandDraft = ref('')
const contextDraft = ref('ide-assistant')
const projectModeDraft = ref<SerenaProjectMode>('workspacePath')
const languageBackendDraft = ref<'' | SerenaLanguageBackend>('')
const enableWebDashboardDraft = ref<'default' | 'true' | 'false'>('default')
const openWebDashboardDraft = ref(false)
const startupTimeoutDraft = ref(15_000)
const toolTimeoutDraft = ref(30_000)
const logLevelDraft = ref<'' | SerenaLogLevel>('')
const extraArgsDraft = ref('')

const snapshot = computed(() => project.projectSnapshot)
const model = computed(() => snapshot.value?.project)
const projectModeOptions = computed<SelectOption[]>(() => [
  {
    label: t('artifact.backendProjectModeWorkspace'),
    value: 'workspacePath',
  },
  { label: t('artifact.backendProjectModeCwd'), value: 'projectFromCwd' },
  { label: t('artifact.backendProjectModeNone'), value: 'none' },
])
const languageBackendOptions = computed<SelectOption[]>(() => [
  { label: t('artifact.backendLanguageAuto'), value: '' },
  { label: 'LSP', value: 'LSP' },
  { label: 'JetBrains', value: 'JetBrains' },
])
const logLevelOptions = computed<SelectOption[]>(() => [
  { label: t('artifact.backendLogAuto'), value: '' },
  ...['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'].map((value) => ({
    label: value,
    value,
  })),
])
const dashboardOptions = computed<SelectOption[]>(() => [
  { label: t('artifact.backendDashboardDefault'), value: 'default' },
  { label: t('common.enabled'), value: 'true' },
  { label: t('common.disabled'), value: 'false' },
])
const draftSerena = computed(() => {
  const base = model.value?.serena
  if (!base) return undefined
  const next = structuredClone(toRaw(base))

  next.command = commandDraft.value.trim() || 'serena'
  next.context = contextDraft.value.trim() || 'ide-assistant'
  next.projectMode = projectModeDraft.value
  next.openWebDashboard = openWebDashboardDraft.value
  next.startupTimeoutMs = Math.max(1_000, startupTimeoutDraft.value || 15_000)
  next.toolTimeoutMs = Math.max(1_000, toolTimeoutDraft.value || 30_000)
  next.extraArgs = extraArgsDraft.value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  delete next.args

  if (languageBackendDraft.value) {
    next.languageBackend = languageBackendDraft.value
  } else {
    delete next.languageBackend
  }

  if (logLevelDraft.value) {
    next.logLevel = logLevelDraft.value
  } else {
    delete next.logLevel
  }

  if (enableWebDashboardDraft.value === 'default') {
    delete next.enableWebDashboard
  } else {
    next.enableWebDashboard = enableWebDashboardDraft.value === 'true'
  }

  return next
})
const launchPreview = computed(() => {
  const serena = draftSerena.value
  if (!serena) return ''
  return buildSerenaLaunchPreview(
    serena,
    model.value?.workspaceRoot || currentWorkspace() || '${workspace}',
  )
})

function syncDrafts(next?: ProjectModel) {
  const serena = next?.serena
  commandDraft.value = serena?.command ?? 'serena'
  contextDraft.value = serena?.context ?? 'ide-assistant'
  projectModeDraft.value = serena?.projectMode ?? 'workspacePath'
  languageBackendDraft.value = serena?.languageBackend ?? ''
  enableWebDashboardDraft.value =
    serena?.enableWebDashboard === undefined
      ? 'default'
      : serena.enableWebDashboard
        ? 'true'
        : 'false'
  openWebDashboardDraft.value = serena?.openWebDashboard ?? false
  startupTimeoutDraft.value = serena?.startupTimeoutMs ?? 15_000
  toolTimeoutDraft.value = serena?.toolTimeoutMs ?? 30_000
  logLevelDraft.value = serena?.logLevel ?? ''
  extraArgsDraft.value = (serena?.extraArgs ?? []).join('\n')
}

function currentWorkspace() {
  return agent.workspacePath
}

function backendStateType(
  state: CodeBackendStatus['state'],
): 'default' | 'error' | 'info' | 'success' | 'warning' {
  switch (state) {
    case 'ready':
      return 'success'
    case 'error':
      return 'error'
    case 'starting':
      return 'info'
    case 'stopped':
      return 'warning'
    default:
      return 'default'
  }
}

async function load() {
  const workspace = currentWorkspace()
  if (workspace) await project.loadProject(workspace)
}

async function detectModules() {
  const workspace = currentWorkspace()
  if (workspace) await project.detectModules(workspace)
}

async function useDetectedModules() {
  const workspace = currentWorkspace()
  if (workspace) await project.useDetectedModules(workspace)
}

async function saveSerenaConfig() {
  const workspace = currentWorkspace()
  if (!workspace || !model.value || !draftSerena.value) return
  const next: ProjectModel = structuredClone(toRaw(model.value))
  next.serena = draftSerena.value
  await project.saveProject(workspace, next)
}

async function setSerenaEnabled(value: boolean) {
  const workspace = currentWorkspace()
  if (workspace) await project.setSerenaEnabled(workspace, value)
}

async function restartBackend(backendId: string) {
  const workspace = currentWorkspace()
  if (workspace) await project.restartBackend(workspace, backendId)
}

watch(
  () => agent.workspacePath,
  () => {
    project.detectedModules = []
    void load()
  },
  { immediate: true },
)

watch(
  () => model.value?.updatedAt,
  () => syncDrafts(model.value),
  { immediate: true },
)
</script>

<template>
  <section class="artifact-content project-view">
    <NEmpty
      v-if="!agent.workspacePath"
      :description="t('artifact.chooseHint')"
    />

    <NSpin v-else class="project-spin" :show="project.loading">
      <NAlert
        v-if="project.error"
        type="error"
        closable
        @close="project.error = ''"
      >
        {{ project.error }}
      </NAlert>

      <section class="project-section">
        <div class="project-section-header">
          <div>
            <h3>{{ t('artifact.projectModules') }}</h3>
            <p>{{ snapshot?.path || '.zch/project-model.json' }}</p>
          </div>
          <NButton
            size="small"
            :loading="project.detecting"
            @click="detectModules"
          >
            {{ t('artifact.detectModules') }}
          </NButton>
        </div>

        <NAlert v-if="snapshot?.gitIgnoreRecommended" type="warning">
          {{ t('artifact.zchGitIgnoreHint') }}
        </NAlert>

        <NList v-if="model?.modules.length" :show-divider="false" bordered>
          <NListItem v-for="module in model.modules" :key="module.id">
            <NThing :title="module.name" :description="module.root">
              <small class="project-module-meta">
                {{
                  module.languages.join(', ') || t('artifact.unknownLanguage')
                }}
                · {{ module.source }} · {{ module.confidence }}
              </small>
            </NThing>
          </NListItem>
        </NList>
        <NEmpty v-else size="small" :description="t('artifact.noModules')" />

        <div v-if="project.detectedModules.length" class="detected-modules">
          <h4>{{ t('artifact.detectedModules') }}</h4>
          <NList :show-divider="false" bordered>
            <NListItem
              v-for="module in project.detectedModules"
              :key="module.id"
            >
              <NThing :title="module.name" :description="module.root">
                <small class="project-module-meta">
                  {{ module.manifests.join(', ') }}
                </small>
              </NThing>
            </NListItem>
          </NList>
          <NButton
            size="small"
            type="primary"
            :loading="project.saving"
            @click="useDetectedModules"
          >
            {{ t('artifact.useDetectedModules') }}
          </NButton>
        </div>
      </section>

      <section class="project-section">
        <div class="project-section-header">
          <div>
            <h3>{{ t('artifact.codeBackends') }}</h3>
            <p>{{ t('artifact.serenaBackend') }}</p>
          </div>
          <NSwitch
            :value="Boolean(model?.serena.enabled)"
            @update:value="setSerenaEnabled"
          />
        </div>

        <NForm label-placement="top" size="small" :show-feedback="false">
          <NFormItem :label="t('artifact.backendCommand')">
            <NInput v-model:value="commandDraft" data-testid="serena-command" />
          </NFormItem>

          <NGrid :cols="2" :x-gap="8">
            <NGi>
              <NFormItem :label="t('artifact.backendContext')">
                <NInput
                  v-model:value="contextDraft"
                  data-testid="serena-context"
                />
              </NFormItem>
            </NGi>
            <NGi>
              <NFormItem :label="t('artifact.backendProjectMode')">
                <NSelect
                  v-model:value="projectModeDraft"
                  data-testid="serena-project-mode"
                  :options="projectModeOptions"
                />
              </NFormItem>
            </NGi>
          </NGrid>

          <NGrid :cols="2" :x-gap="8">
            <NGi>
              <NFormItem :label="t('artifact.backendLanguageBackend')">
                <NSelect
                  v-model:value="languageBackendDraft"
                  data-testid="serena-language-backend"
                  :options="languageBackendOptions"
                />
              </NFormItem>
            </NGi>
            <NGi>
              <NFormItem :label="t('artifact.backendLogLevel')">
                <NSelect
                  v-model:value="logLevelDraft"
                  data-testid="serena-log-level"
                  :options="logLevelOptions"
                />
              </NFormItem>
            </NGi>
          </NGrid>

          <NGrid :cols="2" :x-gap="8">
            <NGi>
              <NFormItem :label="t('artifact.backendStartupTimeout')">
                <NInputNumber
                  :value="startupTimeoutDraft"
                  data-testid="serena-startup-timeout"
                  :min="1000"
                  :step="1000"
                  @update:value="startupTimeoutDraft = $event ?? 15_000"
                />
              </NFormItem>
            </NGi>
            <NGi>
              <NFormItem :label="t('artifact.backendToolTimeout')">
                <NInputNumber
                  :value="toolTimeoutDraft"
                  data-testid="serena-tool-timeout"
                  :min="1000"
                  :step="1000"
                  @update:value="toolTimeoutDraft = $event ?? 30_000"
                />
              </NFormItem>
            </NGi>
          </NGrid>

          <NGrid :cols="2" :x-gap="8">
            <NGi>
              <NFormItem :label="t('artifact.backendEnableDashboard')">
                <NSelect
                  v-model:value="enableWebDashboardDraft"
                  data-testid="serena-enable-dashboard"
                  :options="dashboardOptions"
                />
              </NFormItem>
            </NGi>
            <NGi>
              <NFormItem :label="t('artifact.backendOpenDashboard')">
                <NCheckbox
                  v-model:checked="openWebDashboardDraft"
                  data-testid="serena-open-dashboard"
                  :aria-label="t('artifact.backendOpenDashboard')"
                />
              </NFormItem>
            </NGi>
          </NGrid>

          <NFormItem :label="t('artifact.backendExtraArgs')">
            <NInput
              v-model:value="extraArgsDraft"
              data-testid="serena-extra-args"
              type="textarea"
              :autosize="{ minRows: 4, maxRows: 8 }"
            />
          </NFormItem>
        </NForm>

        <div class="launch-preview">
          <span>{{ t('artifact.backendLaunchPreview') }}</span>
          <code data-testid="serena-launch-preview">{{ launchPreview }}</code>
        </div>

        <NButton
          size="small"
          :loading="project.saving"
          @click="saveSerenaConfig"
        >
          {{ t('artifact.saveProjectConfig') }}
        </NButton>

        <NList
          v-if="project.backendStatuses.length"
          :show-divider="false"
          bordered
          class="backend-status-list"
        >
          <NListItem
            v-for="status in project.backendStatuses"
            :key="status.backendId"
          >
            <NThing :title="status.backendId" :description="status.message">
              <template #header-extra>
                <NTag
                  size="small"
                  round
                  :bordered="false"
                  :type="backendStateType(status.state)"
                >
                  {{ status.state }}
                </NTag>
              </template>
              <small class="backend-status-meta">
                {{ status.capabilities.join(', ') || 'no capabilities' }}
              </small>
              <template #action>
                <NButton
                  size="tiny"
                  :loading="project.restartingBackendId === status.backendId"
                  @click="restartBackend(status.backendId)"
                >
                  {{ t('artifact.restartBackend') }}
                </NButton>
              </template>
            </NThing>
          </NListItem>
        </NList>
      </section>
    </NSpin>
  </section>
</template>
