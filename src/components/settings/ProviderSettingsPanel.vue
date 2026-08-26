<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NDropdown,
  NEmpty,
  NGi,
  NGrid,
  NInput,
  NInputNumber,
  NList,
  NListItem,
  NModal,
  NScrollbar,
  NSelect,
  NTag,
  NTransfer,
  type DropdownOption,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  REASONING_EFFORTS,
  type ModelCapabilityLevel,
  type ReasoningEffort,
} from '../../../shared/config'
import {
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  resolveModelTokenSettings,
  type ModelTokenSettings,
} from '../../../shared/model-settings'
import { useAgentStore } from '../../stores/agent'
import { providerDraftAuxiliaryConflict } from '../../stores/provider-form'
import ProviderModelDeleteAction from './ProviderModelDeleteAction.vue'

/** Maps each reasoning effort to its locale label key. */
const REASONING_LABEL_KEYS: Record<ReasoningEffort, string> = {
  off: 'settings.reasoningOff',
  low: 'settings.reasoningLow',
  medium: 'settings.reasoningMedium',
  high: 'settings.reasoningHigh',
  xhigh: 'settings.reasoningXhigh',
  max: 'settings.reasoningMax',
}

const MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'

type ProviderAction =
  | { kind: 'select'; providerId: string }
  | { kind: 'create' }
  | { kind: 'copy'; providerId: string }
  | { kind: 'delete'; providerId: string }

interface ManualModelDraft extends ModelTokenSettings {
  modelId: string
  reasoningEfforts: ReasoningEffort[]
  capability: ModelCapabilityLevel | null
}

const agent = useAgentStore()
const { t } = useI18n()
const deleteProviderId = ref<string>()
const showAddModel = ref(false)
const modelConfigurationFilter = ref('')
const manualModelDraft = reactive<ManualModelDraft>({
  modelId: '',
  ...resolveModelTokenSettings({
    contextWindowTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
    compactTriggerPercent: 80,
  }),
  reasoningEfforts: [],
  capability: null,
})
let autosaveTimer: ReturnType<typeof setTimeout> | undefined
const providerTypeOptions = computed(() => [
  {
    label: t('settings.providerTypeDeepSeek'),
    value: 'deepseek.chat-completions',
  },
  {
    label: t('settings.providerTypeMimo'),
    value: 'mimo.chat-completions',
  },
  {
    label: t('settings.providerTypeGeneric'),
    value: 'generic.chat-completions',
  },
  {
    label: t('settings.providerTypeResponses'),
    value: 'generic.responses',
  },
  {
    label: t('settings.providerTypeAnthropic'),
    value: 'generic.anthropic',
  },
])
const providerTypeHint = computed(() =>
  agent.providerForm.providerType === 'mimo.chat-completions'
    ? t('settings.providerTypeMimoHint')
    : t('settings.providerTypeHint'),
)
const reasoningEffortOptions = computed(() =>
  REASONING_EFFORTS.map((effort) => ({
    label: t(REASONING_LABEL_KEYS[effort]),
    value: effort,
  })),
)
/**
 * A saved auxiliary route remains atomic while its Provider draft changes.
 * Its explicit reasoning is not rewritten when annotations change.
 */
const draftConflict = computed(() =>
  providerDraftAuxiliaryConflict({
    providerId: agent.providerForm.providerId,
    enabledModelIds: agent.providerForm.enabledModelIds,
    profiles: agent.modelProfiles,
    auxiliary: {
      providerId: agent.auxiliaryModelProvider,
      model: agent.auxiliaryModel,
      reasoning: agent.auxiliaryModelReasoning,
    },
  }),
)
const autosaveConflict = computed(() => draftConflict.value.conflict)
const capabilityOptions = computed(() => [
  { label: t('settings.capabilityLight'), value: 'light' },
  { label: t('settings.capabilityStandard'), value: 'standard' },
  { label: t('settings.capabilityStrong'), value: 'strong' },
])
const deleteProvider = computed(() =>
  agent.providers.find((provider) => provider.id === deleteProviderId.value),
)
const modelTransferOptions = computed(() => agent.modelTransferOptions)
const selectedModelIds = computed(() => agent.providerForm.enabledModelIds)
const allModelProfiles = computed(() =>
  [...agent.modelProfiles].sort((left, right) => {
    if (left.id === agent.providerForm.model) return -1
    if (right.id === agent.providerForm.model) return 1
    const leftEnabled = selectedModelIds.value.includes(left.id)
    const rightEnabled = selectedModelIds.value.includes(right.id)
    if (leftEnabled !== rightEnabled) return leftEnabled ? -1 : 1
    return left.id.localeCompare(right.id, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  }),
)
const visibleModelProfiles = computed(() => {
  const query = modelConfigurationFilter.value.trim().toLocaleLowerCase()
  if (!query) return allModelProfiles.value
  return allModelProfiles.value.filter((model) =>
    model.id.toLocaleLowerCase().includes(query),
  )
})
const manualModelValidation = computed(() => {
  const modelId = manualModelDraft.modelId.trim()
  if (!modelId) return t('settings.modelNameRequired')
  if (modelId.length > 256) return t('settings.modelNameTooLong')
  if (
    agent.selectedProvider?.modelCatalog.some((model) => model.id === modelId)
  ) {
    return t('settings.modelAlreadyExists')
  }
  if (
    !Number.isInteger(manualModelDraft.contextWindowTokens) ||
    manualModelDraft.contextWindowTokens < 2_048 ||
    manualModelDraft.contextWindowTokens > 10_000_000 ||
    !Number.isInteger(manualModelDraft.maxOutputTokens) ||
    manualModelDraft.maxOutputTokens < 1 ||
    manualModelDraft.maxOutputTokens >
      manualModelDraft.contextWindowTokens - 1_024 ||
    !Number.isInteger(manualModelDraft.compactThresholdTokens) ||
    manualModelDraft.compactThresholdTokens < 1_024 ||
    manualModelDraft.compactThresholdTokens >
      manualModelDraft.contextWindowTokens - manualModelDraft.maxOutputTokens
  ) {
    return t('settings.modelConfigurationInvalid')
  }
  return ''
})

function handleSelectedModels(value: Array<string | number>): void {
  const availableIds = new Set(agent.modelProfiles.map((model) => model.id))
  const mainModel = agent.providerForm.model
  const nextModelIds = [...new Set(value.map(String))].filter((id) =>
    availableIds.has(id),
  )
  if (mainModel && !nextModelIds.includes(mainModel)) {
    nextModelIds.push(mainModel)
  }
  agent.providerForm.enabledModelIds = nextModelIds
  if (!mainModel && nextModelIds[0]) {
    agent.setProviderDraftModel(nextModelIds[0])
  }
}

/** Applies safe defaults when an empty Provider draft selects MiMo. */
function handleProviderTypeChange(value: string | number | null): void {
  if (value !== 'mimo.chat-completions') return
  const baseURL = agent.providerForm.baseURL.trim()
  if (!baseURL || baseURL === 'https://api.example.com/v1') {
    agent.providerForm.baseURL = MIMO_DEFAULT_BASE_URL
    return
  }
  try {
    const parsed = new URL(baseURL)
    const path = parsed.pathname.replace(/\/+$/u, '') || '/'
    if (
      parsed.origin === 'https://api.xiaomimimo.com' &&
      (path === '/' || path === '/anthropic' || path === '/anthropic/v1')
    ) {
      agent.providerForm.baseURL = MIMO_DEFAULT_BASE_URL
    }
  } catch {
    // Leave an invalid draft visible so the existing save validation reports it.
  }
}

/** Opens the manual-model dialog with a clean draft. */
function openAddModel(): void {
  Object.assign(manualModelDraft, {
    modelId: '',
    ...resolveModelTokenSettings({
      contextWindowTokens:
        agent.limitsConfig?.maxContextTokens ??
        DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
      compactTriggerPercent:
        agent.limitsConfig?.autoCompactTriggerPercent ?? 80,
    }),
    reasoningEfforts: [],
    capability: null,
  })
  showAddModel.value = true
}

/** Keeps manual token fields within the same usable-budget rules as saved rows. */
function updateManualModelTokenSetting(
  field: 'contextWindowTokens' | 'compactThresholdTokens' | 'maxOutputTokens',
  value: number | null,
): void {
  if (value === null || !Number.isInteger(value)) return
  const contextWindowTokens =
    field === 'contextWindowTokens'
      ? Math.min(10_000_000, Math.max(2_048, value))
      : manualModelDraft.contextWindowTokens
  const compactThresholdTokens =
    field === 'compactThresholdTokens'
      ? Math.max(1_024, value)
      : manualModelDraft.compactThresholdTokens
  const maxOutputTokens =
    field === 'maxOutputTokens'
      ? Math.max(1, value)
      : manualModelDraft.maxOutputTokens
  Object.assign(
    manualModelDraft,
    resolveModelTokenSettings({
      contextWindowTokens,
      compactThresholdTokens,
      maxOutputTokens,
      compactTriggerPercent:
        agent.limitsConfig?.autoCompactTriggerPercent ?? 80,
    }),
  )
}

/** Persists a manually entered model and keeps the dialog open on failure. */
async function confirmAddModel(): Promise<boolean> {
  if (manualModelValidation.value) return false
  const added = await agent.addProviderModel({
    modelId: manualModelDraft.modelId,
    modelOverride: {
      contextWindowTokens: manualModelDraft.contextWindowTokens,
      compactThresholdTokens: manualModelDraft.compactThresholdTokens,
      maxOutputTokens: manualModelDraft.maxOutputTokens,
      ...(manualModelDraft.reasoningEfforts.length
        ? { reasoningEfforts: [...manualModelDraft.reasoningEfforts] }
        : {}),
      ...(manualModelDraft.capability
        ? { capability: manualModelDraft.capability }
        : {}),
    },
  })
  if (!added) return false
  showAddModel.value = false
  return true
}

/** Explains why one model cannot currently be deleted. */
function modelDeleteDisabledReason(modelId: string): string {
  if (modelId === agent.providerForm.model) {
    return t('settings.deleteMainModelBlocked')
  }
  if (
    agent.auxiliaryModelProvider === agent.selectedProviderId &&
    agent.auxiliaryModel === modelId
  ) {
    return t('settings.deleteAuxiliaryModelBlocked')
  }
  return ''
}

/** Flushes pending Provider edits before deleting one configured model. */
async function confirmDeleteModel(modelId: string): Promise<boolean> {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = undefined
  return agent.deleteProviderModel(modelId)
}

/** Applies a reasoning-effort annotation edit to one model row. */
function handleReasoningEffortsChange(
  modelId: string,
  value: Array<string | number>,
): void {
  agent.updateModelAnnotation(modelId, {
    reasoningEfforts: value.map(String) as ReasoningEffort[],
  })
}

/** Applies a capability annotation edit to one model row. */
function handleCapabilityChange(
  modelId: string,
  value: string | number | null,
): void {
  agent.updateModelAnnotation(modelId, {
    capability: (value === null
      ? null
      : String(value)) as ModelCapabilityLevel | null,
  })
}

onMounted(() => {
  void agent.enterProviderSettings()
})

watch(
  () =>
    JSON.stringify({
      form: agent.providerForm,
      models: agent.modelProfiles.map((model) => ({
        id: model.id,
        contextWindowTokens: model.contextWindowTokens,
        compactThresholdTokens: model.compactThresholdTokens,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEfforts: model.reasoningEfforts,
        capability: model.capability,
      })),
      auxiliary: {
        providerId: agent.auxiliaryModelProvider,
        model: agent.auxiliaryModel,
        reasoning: agent.auxiliaryModelReasoning,
      },
    }),
  () => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
    if (!agent.providerDirty) return
    agent.providerSaveStatus = ''
    if (autosaveConflict.value) return

    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined
      void agent.saveProvider()
    }, 600)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = undefined
  if (agent.providerDirty && !autosaveConflict.value) {
    void agent.saveProvider()
  }
})

function providerActions(): DropdownOption[] {
  return [
    { label: t('settings.copyProvider'), key: 'copy' },
    {
      label: t('settings.deleteProvider'),
      key: 'delete',
      disabled: agent.providers.length <= 1,
    },
  ]
}

async function requestProviderAction(action: ProviderAction) {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = undefined
  if (agent.providerDirty && !(await agent.saveProvider())) return
  await runProviderAction(action)
}

async function runProviderAction(action: ProviderAction) {
  switch (action.kind) {
    case 'select':
      if (await agent.selectProviderForEditing(action.providerId)) {
        await agent.enterProviderSettings()
      }
      break
    case 'create':
      await agent.createProvider()
      break
    case 'copy':
      await agent.copyProvider(action.providerId)
      break
    case 'delete':
      deleteProviderId.value = action.providerId
      break
  }
}

async function confirmDeleteProvider() {
  const providerId = deleteProviderId.value
  if (!providerId) return

  if (await agent.deleteProvider(providerId)) {
    deleteProviderId.value = undefined
  }
}

function handleCardKeydown(event: KeyboardEvent, providerId: string) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  void requestProviderAction({ kind: 'select', providerId })
}

function handleDropdownSelect(key: string | number, providerId: string) {
  if (key === 'copy') {
    void requestProviderAction({ kind: 'copy', providerId })
  } else if (key === 'delete') {
    void requestProviderAction({ kind: 'delete', providerId })
  }
}
</script>

<template>
  <section class="settings-section provider-settings-section">
    <div class="settings-heading">
      <div>
        <h2>{{ t('settings.providerDomainTitle') }}</h2>
        <p>{{ t('settings.providerDomainHint') }}</p>
      </div>
    </div>

    <div class="settings-subsection">
      <div class="settings-heading provider-settings-heading">
        <div>
          <h3>{{ t('settings.providerConfigTitle') }}</h3>
          <p>{{ t('settings.providerHint') }}</p>
        </div>
        <NButton
          type="primary"
          @click="requestProviderAction({ kind: 'create' })"
        >
          {{ t('settings.addProvider') }}
        </NButton>
      </div>

      <NGrid
        class="provider-card-grid"
        cols="1 s:2 l:3"
        :x-gap="12"
        :y-gap="12"
        responsive="screen"
      >
        <NGi v-for="provider in agent.providerCardSummaries" :key="provider.id">
          <NCard
            size="small"
            hoverable
            class="provider-card"
            :class="{ selected: provider.isSelected }"
            role="button"
            tabindex="0"
            @click="
              requestProviderAction({
                kind: 'select',
                providerId: provider.id,
              })
            "
            @keydown="handleCardKeydown($event, provider.id)"
          >
            <template #header>
              <div class="provider-card-title">
                <strong>{{ provider.label }}</strong>
              </div>
            </template>
            <template #header-extra>
              <NDropdown
                trigger="click"
                :options="providerActions()"
                @select="handleDropdownSelect($event, provider.id)"
              >
                <NButton size="tiny" secondary @click.stop>
                  {{ t('settings.providerActions') }}
                </NButton>
              </NDropdown>
            </template>
            <div class="provider-card-body">
              <div class="provider-card-tags">
                <NTag
                  v-for="model in provider.models"
                  :key="model"
                  size="small"
                  :bordered="false"
                >
                  {{ model }}
                </NTag>
              </div>
              <small>
                {{
                  provider.credentialConfigured
                    ? provider.credentialSource === 'environment'
                      ? t('settings.credentialEnvShort')
                      : t('settings.credentialStoredShort')
                    : t('settings.credentialNoneShort')
                }}
              </small>
            </div>
          </NCard>
        </NGi>
      </NGrid>

      <div class="provider-detail-panel">
        <div class="provider-detail-heading">
          <div>
            <h3>{{ agent.providerForm.label }}</h3>
          </div>
          <div class="provider-detail-toolbar">
            <small
              class="settings-save-status"
              data-testid="provider-save-status"
              aria-live="polite"
            >
              {{
                agent.providerSaving
                  ? t('settings.saving')
                  : agent.providerSaveStatus &&
                      agent.providerSaveStatus !== 'Saved'
                    ? agent.providerSaveStatus
                    : agent.providerDirty
                      ? t('settings.autosavePending')
                      : agent.providerSaveStatus
                        ? t('settings.saved')
                        : ''
              }}
            </small>
          </div>
        </div>

        <div class="settings-inline settings-inline-equal">
          <label class="settings-field">
            <span>{{ t('settings.providerLabel') }}</span>
            <NInput v-model:value="agent.providerForm.label" />
          </label>
          <label class="settings-field">
            <span>{{ t('settings.providerType') }}</span>
            <NSelect
              v-model:value="agent.providerForm.providerType"
              :options="providerTypeOptions"
              @update:value="handleProviderTypeChange"
            />
          </label>
        </div>
        <p class="settings-footnote">
          {{ providerTypeHint }}
        </p>
        <label class="settings-field">
          <span>{{ t('settings.baseUrl') }}</span>
          <NInput v-model:value="agent.providerForm.baseURL" />
        </label>
        <label class="settings-field">
          <span>{{ t('settings.apiKey') }}</span>
          <div class="settings-inline">
            <NInput
              v-model:value="agent.providerForm.apiKey"
              type="password"
              show-password-on="click"
              :placeholder="t('settings.apiKeyPlaceholder')"
            />
            <NButton
              v-if="agent.selectedCredentialSource === 'safe-storage'"
              secondary
              @click="agent.clearCredential"
            >
              {{ t('settings.clearCredential') }}
            </NButton>
          </div>
          <small>
            {{
              agent.selectedCredentialConfigured
                ? agent.selectedCredentialSource === 'environment'
                  ? t('settings.credentialEnv')
                  : t('settings.credentialStored')
                : t('settings.credentialNone')
            }}
          </small>
        </label>
        <label class="settings-field">
          <span>{{ t('settings.mainModel') }}</span>
          <div class="settings-inline">
            <NSelect
              :value="agent.providerForm.model"
              :options="agent.allModelOptions"
              :loading="agent.modelCatalogLoading"
              :disabled="agent.allModelOptions.length === 0"
              :placeholder="t('settings.selectMainModel')"
              filterable
              @update:value="agent.setProviderDraftModel"
            />
            <NButton
              secondary
              :loading="agent.modelCatalogLoading"
              :disabled="
                agent.providerSaving ||
                (!agent.providerRefreshAvailable &&
                  !agent.providerForm.apiKey.trim())
              "
              @click="agent.refreshSelectedProviderModels"
            >
              {{ t('common.refresh') }}
            </NButton>
          </div>
          <small>
            {{
              agent.activeModelProfile
                ? t('settings.modelProfile', {
                    availability: agent.activeModelProfile.availability,
                    source: agent.activeModelProfile.capabilitySource,
                    tokens:
                      agent.activeModelProfile.contextWindowTokens.toLocaleString(),
                  })
                : t('settings.selectMainModelHint')
            }}
          </small>
          <small v-if="!agent.providerRefreshAvailable">
            {{ t('settings.modelRefreshCredentialHint') }}
          </small>
        </label>
        <div class="provider-model-settings">
          <div class="provider-model-settings-title">
            <div>
              <h4>{{ t('settings.modelSettings') }}</h4>
              <p>{{ t('settings.modelSettingsHint') }}</p>
            </div>
            <NButton secondary @click="openAddModel">
              {{ t('settings.addModel') }}
            </NButton>
          </div>
          <small
            v-if="draftConflict.reason === 'model-disabled'"
            class="settings-field-error"
          >
            {{
              t('settings.auxiliaryDraftModelDisabledHint', {
                model: agent.auxiliaryModel,
              })
            }}
          </small>
          <small
            v-else-if="draftConflict.conflict"
            class="settings-field-error"
          >
            {{
              t('settings.auxiliaryDraftConflictHint', {
                model: agent.auxiliaryModel,
              })
            }}
          </small>
          <NTransfer
            :value="selectedModelIds"
            :options="modelTransferOptions"
            :source-title="t('settings.availableModels')"
            :target-title="t('settings.selectedModels')"
            :source-filter-placeholder="t('settings.filterModels')"
            :target-filter-placeholder="t('settings.filterModels')"
            :select-all-text="t('settings.selectAllModels')"
            :clear-text="t('settings.clearSelectedModels')"
            :show-selected="false"
            source-filterable
            target-filterable
            virtual-scroll
            class="provider-model-transfer"
            data-testid="provider-model-transfer"
            @update:value="handleSelectedModels"
          />
          <NInput
            v-if="allModelProfiles.length"
            v-model:value="modelConfigurationFilter"
            clearable
            :placeholder="t('settings.filterModelConfiguration')"
          />
          <div
            v-if="visibleModelProfiles.length"
            class="provider-model-settings-header"
            aria-hidden="true"
          >
            <span>{{ t('settings.modelName') }}</span>
            <span>{{ t('settings.maximumContext') }}</span>
            <span>{{ t('settings.compressionThreshold') }}</span>
            <span>{{ t('settings.maximumOutputLength') }}</span>
            <span>{{ t('settings.modelReasoningEfforts') }}</span>
            <span>{{ t('settings.modelCapability') }}</span>
            <span>{{ t('settings.modelActions') }}</span>
          </div>
          <NScrollbar
            v-if="visibleModelProfiles.length"
            class="provider-model-settings-scroll"
          >
            <NList
              bordered
              class="provider-model-settings-list"
              data-testid="provider-model-settings-list"
            >
              <NListItem v-for="model in visibleModelProfiles" :key="model.id">
                <div class="provider-model-settings-row">
                  <div class="provider-model-name">
                    <strong>{{ model.id }}</strong>
                    <NTag
                      v-if="model.id === agent.providerForm.model"
                      size="small"
                      type="info"
                      :bordered="false"
                    >
                      {{ t('settings.mainModelTag') }}
                    </NTag>
                  </div>
                  <label class="provider-model-value">
                    <span>{{ t('settings.maximumContext') }}</span>
                    <NInputNumber
                      :value="model.contextWindowTokens"
                      :min="2048"
                      :max="10000000"
                      :show-button="false"
                      @update:value="
                        agent.updateModelConfiguration(
                          model.id,
                          'contextWindowTokens',
                          $event,
                        )
                      "
                    />
                  </label>
                  <label class="provider-model-value">
                    <span>{{ t('settings.compressionThreshold') }}</span>
                    <NInputNumber
                      :value="model.compactThresholdTokens"
                      :min="1024"
                      :max="model.contextWindowTokens - model.maxOutputTokens"
                      :show-button="false"
                      @update:value="
                        agent.updateModelConfiguration(
                          model.id,
                          'compactThresholdTokens',
                          $event,
                        )
                      "
                    />
                  </label>
                  <label class="provider-model-value">
                    <span>{{ t('settings.maximumOutputLength') }}</span>
                    <NInputNumber
                      :value="model.maxOutputTokens"
                      :min="1"
                      :max="model.contextWindowTokens - 1024"
                      :show-button="false"
                      @update:value="
                        agent.updateModelConfiguration(
                          model.id,
                          'maxOutputTokens',
                          $event,
                        )
                      "
                    />
                  </label>
                  <label
                    class="provider-model-value"
                    :aria-label="`${model.id} · ${t('settings.modelReasoningEfforts')}`"
                  >
                    <span>{{ t('settings.modelReasoningEfforts') }}</span>
                    <NSelect
                      :value="model.reasoningEfforts ?? []"
                      :options="reasoningEffortOptions"
                      :placeholder="
                        t('settings.modelReasoningEffortsPlaceholder')
                      "
                      multiple
                      clearable
                      @update:value="
                        handleReasoningEffortsChange(model.id, $event)
                      "
                    />
                  </label>
                  <label
                    class="provider-model-value"
                    :aria-label="`${model.id} · ${t('settings.modelCapability')}`"
                  >
                    <span>{{ t('settings.modelCapability') }}</span>
                    <NSelect
                      :value="model.capability ?? null"
                      :options="capabilityOptions"
                      :placeholder="t('settings.modelCapabilityPlaceholder')"
                      clearable
                      @update:value="handleCapabilityChange(model.id, $event)"
                    />
                  </label>
                  <ProviderModelDeleteAction
                    :model-id="model.id"
                    :disabled-reason="modelDeleteDisabledReason(model.id)"
                    :delete-model="confirmDeleteModel"
                  />
                </div>
              </NListItem>
            </NList>
          </NScrollbar>
          <NEmpty
            v-else
            :description="
              allModelProfiles.length
                ? t('settings.noMatchingModels')
                : t('settings.noModelsHint')
            "
          />
        </div>
      </div>
    </div>

    <NModal
      v-model:show="showAddModel"
      preset="dialog"
      :title="t('settings.addModelTitle')"
      :positive-text="t('settings.addModel')"
      :negative-text="t('common.cancel')"
      :positive-button-props="{ disabled: Boolean(manualModelValidation) }"
      @positive-click="confirmAddModel"
    >
      <div class="provider-add-model-fields">
        <label class="settings-field">
          <span>{{ t('settings.modelName') }}</span>
          <NInput
            v-model:value="manualModelDraft.modelId"
            :placeholder="t('settings.addModelPlaceholder')"
            :maxlength="256"
            @keyup.enter="confirmAddModel"
          />
        </label>
        <div class="provider-add-model-token-grid">
          <label class="settings-field">
            <span>{{ t('settings.maximumContext') }}</span>
            <NInputNumber
              :value="manualModelDraft.contextWindowTokens"
              :min="2048"
              :max="10000000"
              :show-button="false"
              @update:value="
                updateManualModelTokenSetting('contextWindowTokens', $event)
              "
            />
          </label>
          <label class="settings-field">
            <span>{{ t('settings.compressionThreshold') }}</span>
            <NInputNumber
              :value="manualModelDraft.compactThresholdTokens"
              :min="1024"
              :max="
                manualModelDraft.contextWindowTokens -
                manualModelDraft.maxOutputTokens
              "
              :show-button="false"
              @update:value="
                updateManualModelTokenSetting('compactThresholdTokens', $event)
              "
            />
          </label>
          <label class="settings-field">
            <span>{{ t('settings.maximumOutputLength') }}</span>
            <NInputNumber
              :value="manualModelDraft.maxOutputTokens"
              :min="1"
              :max="manualModelDraft.contextWindowTokens - 1024"
              :show-button="false"
              @update:value="
                updateManualModelTokenSetting('maxOutputTokens', $event)
              "
            />
          </label>
        </div>
        <label class="settings-field">
          <span>{{ t('settings.modelReasoningEfforts') }}</span>
          <NSelect
            v-model:value="manualModelDraft.reasoningEfforts"
            :options="reasoningEffortOptions"
            :placeholder="t('settings.modelReasoningEffortsPlaceholder')"
            multiple
            clearable
          />
        </label>
        <label class="settings-field">
          <span>{{ t('settings.modelCapability') }}</span>
          <NSelect
            v-model:value="manualModelDraft.capability"
            :options="capabilityOptions"
            :placeholder="t('settings.modelCapabilityPlaceholder')"
            clearable
          />
        </label>
        <small v-if="manualModelValidation" class="settings-field-error">
          {{ manualModelValidation }}
        </small>
        <small v-else>{{ t('settings.addModelHint') }}</small>
      </div>
    </NModal>

    <NModal
      :show="Boolean(deleteProviderId)"
      preset="dialog"
      :title="t('settings.deleteProviderTitle')"
      :positive-text="t('settings.deleteProvider')"
      :negative-text="t('common.cancel')"
      @positive-click="confirmDeleteProvider"
      @negative-click="deleteProviderId = undefined"
      @update:show="!$event && (deleteProviderId = undefined)"
    >
      {{
        t('settings.deleteProviderText', {
          label: deleteProvider?.label ?? deleteProviderId,
        })
      }}
    </NModal>
  </section>
</template>
