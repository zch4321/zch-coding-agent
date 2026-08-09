<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
import { resolveSupportedReasoningEfforts } from '../../../shared/model-settings'
import { useAgentStore } from '../../stores/agent'
import { providerDraftConflicts } from '../../stores/provider-form'

/** Maps each reasoning effort to its locale label key. */
const REASONING_LABEL_KEYS: Record<ReasoningEffort, string> = {
  off: 'settings.reasoningOff',
  low: 'settings.reasoningLow',
  medium: 'settings.reasoningMedium',
  high: 'settings.reasoningHigh',
  xhigh: 'settings.reasoningXhigh',
  max: 'settings.reasoningMax',
}

type ProviderAction =
  | { kind: 'select'; providerId: string }
  | { kind: 'create' }
  | { kind: 'copy'; providerId: string }
  | { kind: 'delete'; providerId: string }
  | { kind: 'set-active'; providerId: string }

const agent = useAgentStore()
const { t } = useI18n()
const deleteProviderId = ref<string>()
const showAddModel = ref(false)
const manualModelId = ref('')
const modelConfigurationFilter = ref('')
let autosaveTimer: ReturnType<typeof setTimeout> | undefined
const providerTypeOptions = computed(() => [
  {
    label: t('settings.providerTypeDeepSeek'),
    value: 'deepseek.chat-completions',
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
const reasoningHint = computed(() => {
  switch (agent.providerForm.providerType) {
    case 'deepseek.chat-completions':
      return t('settings.reasoningHint')
    case 'generic.responses':
      return t('settings.reasoningHintResponses')
    case 'generic.anthropic':
      return t('settings.reasoningHintAnthropic')
    case 'generic.chat-completions':
      return t('settings.reasoningHintGeneric')
    default:
      return t('settings.reasoningHintGeneric')
  }
})
const reasoningOptions = computed(() => {
  const mainModel = agent.modelProfiles.find(
    (model) => model.id === agent.providerForm.model,
  )
  return resolveSupportedReasoningEfforts({
    reasoningEfforts: mainModel?.reasoningEfforts,
  }).map((effort) => ({
    label: t(REASONING_LABEL_KEYS[effort]),
    value: effort,
  }))
})
const reasoningEffortOptions = computed(() =>
  REASONING_EFFORTS.map((effort) => ({
    label: t(REASONING_LABEL_KEYS[effort]),
    value: effort,
  })),
)
/**
 * Draft conflicts that pause autosave: the main model annotation excluding
 * the draft default effort, or the saved approval route being incompatible
 * with the draft. Neither is auto-adjusted; the user resolves them manually.
 */
const draftConflicts = computed(() =>
  providerDraftConflicts({
    providerId: agent.providerForm.providerId,
    reasoning: agent.providerForm.reasoning,
    mainModelId: agent.providerForm.model,
    enabledModelIds: agent.providerForm.enabledModelIds,
    profiles: agent.modelProfiles,
    approval: agent.approvalSavedForm,
  }),
)
const autosaveConflict = computed(
  () => draftConflicts.value.main || draftConflicts.value.approval,
)
const capabilityOptions = computed(() => [
  { label: t('settings.capabilityLight'), value: 'light' },
  { label: t('settings.capabilityStandard'), value: 'standard' },
  { label: t('settings.capabilityStrong'), value: 'strong' },
])
const tokenEstimationOptions = computed(() => [
  { label: t('settings.tokenConservative'), value: 'conservative' },
  { label: t('settings.tokenCustom'), value: 'custom-bytes' },
])
const deleteProvider = computed(() =>
  agent.providers.find((provider) => provider.id === deleteProviderId.value),
)
const selectedProviderReady = computed(
  () =>
    Boolean(agent.providerForm.model) &&
    agent.providerForm.enabledModelIds.includes(agent.providerForm.model),
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
  const modelId = manualModelId.value.trim()
  if (!modelId) return t('settings.modelNameRequired')
  if (modelId.length > 256) return t('settings.modelNameTooLong')
  if (
    agent.selectedProvider?.modelCatalog.some((model) => model.id === modelId)
  ) {
    return t('settings.modelAlreadyExists')
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

/** Opens the manual-model dialog with a clean draft. */
function openAddModel(): void {
  manualModelId.value = ''
  showAddModel.value = true
}

/** Persists a manually entered model and keeps the dialog open on failure. */
async function confirmAddModel(): Promise<boolean> {
  if (manualModelValidation.value) return false
  const added = await agent.addProviderModel(manualModelId.value)
  if (!added) return false
  showAddModel.value = false
  manualModelId.value = ''
  return true
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
      approval: agent.approvalSavedForm,
      models: agent.modelProfiles.map((model) => ({
        id: model.id,
        contextWindowTokens: model.contextWindowTokens,
        compactThresholdTokens: model.compactThresholdTokens,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEfforts: model.reasoningEfforts,
        capability: model.capability,
      })),
    }),
  () => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
    if (!agent.providerDirty) return
    if (autosaveConflict.value) return

    agent.providerSaveStatus = ''
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

function providerActions(providerId: string): DropdownOption[] {
  const isActive = providerId === agent.activeProviderId
  const provider = agent.providers.find(
    (candidate) => candidate.id === providerId,
  )
  return [
    {
      label: t('settings.setDefaultProvider'),
      key: 'set-active',
      disabled:
        isActive ||
        !provider?.model ||
        !provider.enabledModelIds.includes(provider.model),
    },
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
    case 'set-active':
      await agent.setActiveProvider(action.providerId)
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
  if (key === 'set-active') {
    void requestProviderAction({ kind: 'set-active', providerId })
  } else if (key === 'copy') {
    void requestProviderAction({ kind: 'copy', providerId })
  } else if (key === 'delete') {
    void requestProviderAction({ kind: 'delete', providerId })
  }
}
</script>

<template>
  <section class="settings-section provider-settings-section">
    <div class="settings-heading provider-settings-heading">
      <div>
        <h2>{{ t('settings.providerTitle') }}</h2>
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
          :class="{ active: provider.isActive, selected: provider.isSelected }"
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
              <NTag v-if="provider.isActive" size="small" type="success">
                {{ t('settings.defaultProvider') }}
              </NTag>
            </div>
          </template>
          <template #header-extra>
            <NDropdown
              trigger="click"
              :options="providerActions(provider.id)"
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
          <p>{{ agent.providerForm.providerId }}</p>
        </div>
        <div class="provider-detail-toolbar">
          <div class="provider-detail-actions">
            <NButton
              secondary
              :disabled="
                agent.selectedProviderId === agent.activeProviderId ||
                !selectedProviderReady
              "
              @click="
                requestProviderAction({
                  kind: 'set-active',
                  providerId: agent.selectedProviderId,
                })
              "
            >
              {{ t('settings.setDefaultProvider') }}
            </NButton>
          </div>
          <small class="settings-save-status" aria-live="polite">
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
          />
        </label>
      </div>
      <p class="settings-footnote">
        {{ t('settings.providerTypeHint') }}
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
      <div class="settings-inline settings-inline-equal">
        <label class="settings-field">
          <span>{{ t('settings.tokenEstimation') }}</span>
          <NSelect
            v-model:value="agent.providerForm.tokenEstimationMode"
            :options="tokenEstimationOptions"
          />
        </label>
        <label class="settings-field">
          <span>{{ t('settings.bytesPerToken') }}</span>
          <NInputNumber
            v-model:value="agent.providerForm.bytesPerToken"
            :disabled="
              agent.providerForm.tokenEstimationMode !== 'custom-bytes'
            "
            :min="0.25"
            :max="32"
            :step="0.25"
          />
        </label>
      </div>
      <p class="settings-footnote">
        {{ t('settings.tokenHint') }}
      </p>
      <label class="settings-field">
        <span>{{ t('settings.reasoning') }}</span>
        <NSelect
          v-model:value="agent.providerForm.reasoning"
          :options="reasoningOptions"
          :status="draftConflicts.main ? 'error' : undefined"
        />
        <small v-if="draftConflicts.main" class="settings-field-error">
          {{ t('settings.mainReasoningConflictHint') }}
        </small>
        <small v-else>
          {{ reasoningHint }}
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
          v-if="draftConflicts.approvalReason === 'model-disabled'"
          class="settings-field-error"
        >
          {{
            t('settings.approvalDraftModelDisabledHint', {
              model: agent.approvalSavedForm.model,
            })
          }}
        </small>
        <small v-else-if="draftConflicts.approval" class="settings-field-error">
          {{
            t('settings.approvalDraftConflictHint', {
              model: agent.approvalSavedForm.model,
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

    <NModal
      v-model:show="showAddModel"
      preset="dialog"
      :title="t('settings.addModelTitle')"
      :positive-text="t('settings.addModel')"
      :negative-text="t('common.cancel')"
      :positive-button-props="{ disabled: Boolean(manualModelValidation) }"
      @positive-click="confirmAddModel"
    >
      <label class="settings-field">
        <span>{{ t('settings.modelName') }}</span>
        <NInput
          v-model:value="manualModelId"
          :placeholder="t('settings.addModelPlaceholder')"
          :maxlength="256"
          @keyup.enter="confirmAddModel"
        />
        <small v-if="manualModelValidation" class="settings-field-error">
          {{ manualModelValidation }}
        </small>
        <small v-else>{{ t('settings.addModelHint') }}</small>
      </label>
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
