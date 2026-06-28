<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ProjectModel } from '../../../shared/project-model'
import { useAgentStore } from '../../stores/agent'
import { useAgentProjectStore } from '../../stores/agent-project'

const agent = useAgentStore()
const project = useAgentProjectStore()
const { t } = useI18n()
const commandDraft = ref('')
const argsDraft = ref('')

const snapshot = computed(() => project.projectSnapshot)
const model = computed(() => snapshot.value?.project)

function syncDrafts(next?: ProjectModel) {
  commandDraft.value = next?.serena.command ?? 'serena'
  argsDraft.value = (next?.serena.args ?? []).join('\n')
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
  if (!workspace || !model.value) return
  const next: ProjectModel = structuredClone(model.value)
  next.serena.command = commandDraft.value.trim() || 'serena'
  next.serena.args = argsDraft.value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
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
          <input v-model="commandDraft" />
        </label>
        <label class="project-field">
          <span>{{ t('artifact.backendArgs') }}</span>
          <textarea v-model="argsDraft" rows="5"></textarea>
        </label>
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
