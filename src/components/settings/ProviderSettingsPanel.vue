<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NButton,
  NCard,
  NDropdown,
  NGi,
  NGrid,
  NInput,
  NInputNumber,
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
const profileOptions = computed(() => [
  { label: t('settings.providerProfileDeepSeek'), value: 'deepseek' },
  { label: t('settings.providerProfileGeneric'), value: 'generic' },
])
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
      await agent.selectProviderForEditing(action.providerId)
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
      </div>

      <div class="settings-inline settings-inline-equal">
        <label class="settings-field">
          <span>{{ t('settings.providerLabel') }}</span>
          <NInput v-model:value="agent.providerForm.label" />
        </label>
        <label class="settings-field">
          <span>{{ t('settings.providerProfile') }}</span>
          <NSelect
            v-model:value="agent.providerForm.profile"
            :options="profileOptions"
          />
        </label>
      </div>
      <p class="settings-footnote">
        {{ t('settings.providerProfileHint') }}
      </p>
      <label class="settings-field">
        <span>{{ t('settings.baseUrl') }}</span>
        <NInput v-model:value="agent.providerForm.baseURL" />
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
            @update:value="agent.setProviderModel"
          />
          <NButton
            secondary
            :loading="agent.modelCatalogLoading"
            :disabled="!agent.selectedCredentialConfigured"
            @click="agent.loadProviderModels(true)"
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
      </label>
      <div class="settings-inline settings-inline-equal">
        <label class="settings-field">
          <span>{{ t('settings.contextOverride') }}</span>
          <NInputNumber
            v-model:value="agent.providerForm.contextWindowTokens"
            :min="1024"
            :max="10000000"
            clearable
            :placeholder="t('settings.useDefault')"
          />
        </label>
        <label class="settings-field">
          <span>{{ t('settings.outputOverride') }}</span>
          <NInputNumber
            v-model:value="agent.providerForm.maxOutputTokens"
            :min="1"
            :max="10000000"
            clearable
            :placeholder="t('settings.useDefault')"
          />
        </label>
      </div>
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
          {{ t('settings.reasoningHint') }}
        </small>
      </label>
      <label class="settings-field">
        <span>{{ t('settings.approverProvider') }}</span>
        <NSelect
          v-model:value="agent.providerForm.approverProviderId"
          :options="agent.providerOptions"
          filterable
        />
      </label>
      <label class="settings-field">
        <span>{{ t('settings.approverModel') }}</span>
        <NSelect
          v-model:value="agent.providerForm.approverModel"
          :options="agent.modelOptions"
          filterable
          tag
        />
      </label>
      <label class="settings-field">
        <span>{{ t('settings.apiKey') }}</span>
        <NInput
          v-model:value="agent.providerForm.apiKey"
          type="password"
          show-password-on="click"
          :placeholder="t('settings.apiKeyPlaceholder')"
        />
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
      <div class="settings-actions">
        <NButton
          type="primary"
          :loading="agent.providerSaving"
          :disabled="!agent.providerDirty"
          @click="agent.saveProvider"
        >
          {{ t('settings.saveProvider') }}
        </NButton>
        <NButton
          v-if="agent.selectedCredentialSource === 'safe-storage'"
          secondary
          @click="agent.clearCredential"
        >
          {{ t('settings.clearCredential') }}
        </NButton>
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

    <NModal
      :show="Boolean(dirtyAction)"
      preset="card"
      class="small-modal"
      content-class="small-modal-content"
      @update:show="!$event && (dirtyAction = undefined)"
    >
      <template #header>{{ t('settings.unsavedProviderTitle') }}</template>
      <p>{{ t('settings.unsavedProviderText') }}</p>
      <div class="modal-actions settings-actions">
        <NButton
          type="primary"
          :loading="agent.providerSaving"
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
