<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NDropdown,
  NGi,
  NGrid,
  NInput,
  NInputNumber,
  NList,
  NListItem,
  NModal,
  NSelect,
  NTag,
  type DropdownOption,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'

type ProviderAction =
  | { kind: 'select'; providerId: string }
  | { kind: 'create' }
  | { kind: 'copy'; providerId: string }
  | { kind: 'delete'; providerId: string }
  | { kind: 'set-active'; providerId: string }

const agent = useAgentStore()
const { t } = useI18n()
const dirtyAction = ref<ProviderAction>()
const deleteProviderId = ref<string>()
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
const reasoningOptions = computed(() => [
  { label: t('settings.reasoningOff'), value: 'off' },
  { label: t('settings.reasoningHigh'), value: 'high' },
  { label: t('settings.reasoningMax'), value: 'max' },
])
const tokenEstimationOptions = computed(() => [
  { label: t('settings.tokenConservative'), value: 'conservative' },
  { label: t('settings.tokenCustom'), value: 'custom-bytes' },
])
const deleteProvider = computed(() =>
  agent.providers.find((provider) => provider.id === deleteProviderId.value),
)

onMounted(() => {
  void agent.enterProviderSettings()
})

function providerActions(providerId: string): DropdownOption[] {
  const isActive = providerId === agent.activeProviderId
  return [
    {
      label: t('settings.setDefaultProvider'),
      key: 'set-active',
      disabled: isActive,
    },
    { label: t('settings.copyProvider'), key: 'copy' },
    {
      label: t('settings.deleteProvider'),
      key: 'delete',
      disabled: agent.providers.length <= 1,
    },
  ]
}

function requestProviderAction(action: ProviderAction) {
  if (
    agent.providerDirty &&
    (action.kind === 'select' ||
      action.kind === 'create' ||
      action.kind === 'copy' ||
      action.kind === 'set-active' ||
      (action.kind === 'delete' &&
        action.providerId === agent.selectedProviderId))
  ) {
    dirtyAction.value = action
    return
  }

  void runProviderAction(action)
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

async function saveAndContinue() {
  const action = dirtyAction.value
  if (!action) return

  if (await agent.saveProvider()) {
    dirtyAction.value = undefined
    await runProviderAction(action)
  }
}

async function discardAndContinue() {
  const action = dirtyAction.value
  if (!action) return

  agent.resetSelectedProviderDraft()
  dirtyAction.value = undefined
  await runProviderAction(action)
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
  requestProviderAction({ kind: 'select', providerId })
}

function handleDropdownSelect(key: string | number, providerId: string) {
  if (key === 'set-active') {
    requestProviderAction({ kind: 'set-active', providerId })
  } else if (key === 'copy') {
    requestProviderAction({ kind: 'copy', providerId })
  } else if (key === 'delete') {
    requestProviderAction({ kind: 'delete', providerId })
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
              :disabled="agent.selectedProviderId === agent.activeProviderId"
              @click="
                requestProviderAction({
                  kind: 'set-active',
                  providerId: agent.selectedProviderId,
                })
              "
            >
              {{ t('settings.setDefaultProvider') }}
            </NButton>
            <NButton
              type="primary"
              :loading="agent.providerSaving"
              :disabled="!agent.providerDirty || agent.modelCatalogLoading"
              @click="agent.saveProvider"
            >
              {{ t('settings.saveProvider') }}
            </NButton>
          </div>
          <small class="settings-save-status" aria-live="polite">
            {{
              agent.providerDirty
                ? t('settings.unsaved')
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
            :options="agent.modelOptions"
            :loading="agent.modelCatalogLoading"
            filterable
            tag
            @update:value="agent.setProviderDraftModel"
          />
          <NButton
            secondary
            :loading="agent.modelCatalogLoading"
            :disabled="!agent.providerRefreshAvailable || agent.providerDirty"
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
              : t('settings.customModel')
          }}
        </small>
        <small v-if="!agent.providerRefreshAvailable">
          {{ t('settings.modelRefreshCredentialHint') }}
        </small>
        <small v-else-if="agent.providerDirty">
          {{ t('settings.modelRefreshUnsavedHint') }}
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
        />
        <small>
          {{ reasoningHint }}
        </small>
      </label>

      <div class="provider-model-settings">
        <div>
          <h4>{{ t('settings.modelSettings') }}</h4>
          <p>{{ t('settings.modelSettingsHint') }}</p>
        </div>
        <div class="provider-model-settings-header" aria-hidden="true">
          <span>{{ t('settings.modelName') }}</span>
          <span>{{ t('settings.maximumContext') }}</span>
          <span>{{ t('settings.compressionThreshold') }}</span>
          <span>{{ t('settings.maximumOutputLength') }}</span>
        </div>
        <NList bordered data-testid="provider-model-settings-list">
          <NListItem v-for="model in agent.modelProfiles" :key="model.id">
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
            </div>
          </NListItem>
        </NList>
      </div>
    </div>

    <NModal
      :show="Boolean(dirtyAction)"
      preset="card"
      style="width: min(460px, calc(100vw - 40px))"
      content-class="small-modal-content"
      @update:show="!$event && (dirtyAction = undefined)"
    >
      <template #header>{{ t('settings.unsavedProviderTitle') }}</template>
      <p>{{ t('settings.unsavedProviderText') }}</p>
      <div class="modal-actions settings-actions">
        <NButton
          type="primary"
          :loading="agent.providerSaving"
          :disabled="agent.modelCatalogLoading"
          @click="saveAndContinue"
        >
          {{ t('settings.saveAndContinue') }}
        </NButton>
        <NButton secondary @click="discardAndContinue">
          {{ t('settings.discardAndContinue') }}
        </NButton>
        <NButton @click="dirtyAction = undefined">
          {{ t('common.cancel') }}
        </NButton>
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
