<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import { NButton, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
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
    <p v-if="!agent.workspacePath" class="artifact-empty">
      {{ t('artifact.chooseHint') }}
    </p>

    <template v-else>
      <div v-if="project.error" class="artifact-error">
        {{ project.error }}
      </div>

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

        <p v-if="snapshot?.gitIgnoreRecommended" class="project-warning">
          {{ t('artifact.zchGitIgnoreHint') }}
        </p>

        <div v-if="model?.modules.length" class="module-list">
          <article
            v-for="module in model.modules"
            :key="module.id"
            class="module-row"
          >
            <strong>{{ module.name }}</strong>
            <span>{{ module.root }}</span>
            <small>
              {{ module.languages.join(', ') || t('artifact.unknownLanguage') }}
              · {{ module.source }} · {{ module.confidence }}
            </small>
          </article>
        </div>
        <p v-else class="artifact-empty">{{ t('artifact.noModules') }}</p>

        <div v-if="project.detectedModules.length" class="detected-modules">
          <h4>{{ t('artifact.detectedModules') }}</h4>
          <div class="module-list">
            <article
              v-for="module in project.detectedModules"
              :key="module.id"
              class="module-row"
            >
              <strong>{{ module.name }}</strong>
              <span>{{ module.root }}</span>
              <small>{{ module.manifests.join(', ') }}</small>
            </article>
          </div>
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

        <label class="project-field">
          <span>{{ t('artifact.backendCommand') }}</span>
          <input v-model="commandDraft" data-testid="serena-command" />
        </label>

        <div class="project-field-grid">
          <label class="project-field">
            <span>{{ t('artifact.backendContext') }}</span>
            <input v-model="contextDraft" data-testid="serena-context" />
          </label>
          <label class="project-field">
            <span>{{ t('artifact.backendProjectMode') }}</span>
            <select
              v-model="projectModeDraft"
              data-testid="serena-project-mode"
            >
              <option value="workspacePath">
                {{ t('artifact.backendProjectModeWorkspace') }}
              </option>
              <option value="projectFromCwd">
                {{ t('artifact.backendProjectModeCwd') }}
              </option>
              <option value="none">
                {{ t('artifact.backendProjectModeNone') }}
              </option>
            </select>
          </label>
        </div>

        <div class="project-field-grid">
          <label class="project-field">
            <span>{{ t('artifact.backendLanguageBackend') }}</span>
            <select
              v-model="languageBackendDraft"
              data-testid="serena-language-backend"
            >
              <option value="">{{ t('artifact.backendLanguageAuto') }}</option>
              <option value="LSP">LSP</option>
              <option value="JetBrains">JetBrains</option>
            </select>
          </label>
          <label class="project-field">
            <span>{{ t('artifact.backendLogLevel') }}</span>
            <select v-model="logLevelDraft" data-testid="serena-log-level">
              <option value="">{{ t('artifact.backendLogAuto') }}</option>
              <option value="DEBUG">DEBUG</option>
              <option value="INFO">INFO</option>
              <option value="WARNING">WARNING</option>
              <option value="ERROR">ERROR</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
          </label>
        </div>

        <div class="project-field-grid">
          <label class="project-field">
            <span>{{ t('artifact.backendStartupTimeout') }}</span>
            <input
              v-model.number="startupTimeoutDraft"
              data-testid="serena-startup-timeout"
              min="1000"
              step="1000"
              type="number"
            />
          </label>
          <label class="project-field">
            <span>{{ t('artifact.backendToolTimeout') }}</span>
            <input
              v-model.number="toolTimeoutDraft"
              data-testid="serena-tool-timeout"
              min="1000"
              step="1000"
              type="number"
            />
          </label>
        </div>

        <div class="project-field-grid">
          <label class="project-field">
            <span>{{ t('artifact.backendEnableDashboard') }}</span>
            <select
              v-model="enableWebDashboardDraft"
              data-testid="serena-enable-dashboard"
            >
              <option value="default">
                {{ t('artifact.backendDashboardDefault') }}
              </option>
              <option value="true">{{ t('common.enabled') }}</option>
              <option value="false">{{ t('common.disabled') }}</option>
            </select>
          </label>
          <label class="project-checkbox">
            <input
              v-model="openWebDashboardDraft"
              data-testid="serena-open-dashboard"
              type="checkbox"
            />
            <span>{{ t('artifact.backendOpenDashboard') }}</span>
          </label>
        </div>

        <label class="project-field">
          <span>{{ t('artifact.backendExtraArgs') }}</span>
          <textarea
            v-model="extraArgsDraft"
            data-testid="serena-extra-args"
            rows="4"
          ></textarea>
        </label>

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

        <div class="backend-status-list">
          <article
            v-for="status in project.backendStatuses"
            :key="status.backendId"
            class="backend-status"
          >
            <div>
              <strong>{{ status.backendId }}</strong>
              <span :class="['backend-state', status.state]">
                {{ status.state }}
              </span>
            </div>
            <small>{{ status.message }}</small>
            <small>{{
              status.capabilities.join(', ') || 'no capabilities'
            }}</small>
            <NButton
              size="tiny"
              :loading="project.restartingBackendId === status.backendId"
              @click="restartBackend(status.backendId)"
            >
              {{ t('artifact.restartBackend') }}
            </NButton>
          </article>
        </div>
      </section>
    </template>
  </section>
</template>
