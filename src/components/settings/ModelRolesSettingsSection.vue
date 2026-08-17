<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ReasoningEffort } from '../../../shared/config'
import { resolveSupportedReasoningEfforts } from '../../../shared/model-settings'
import { evaluateModelRouteCompatibility } from '../../../shared/model-route'
import { useAgentStore } from '../../stores/agent'

/** Maps each reasoning effort to its locale label key. */
const REASONING_LABEL_KEYS: Record<ReasoningEffort, string> = {
  off: 'settings.reasoningOff',
  low: 'settings.reasoningLow',
  medium: 'settings.reasoningMedium',
  high: 'settings.reasoningHigh',
  xhigh: 'settings.reasoningXhigh',
  max: 'settings.reasoningMax',
}

const agent = useAgentStore()
const { t } = useI18n()
const defaultModelRoleDraft = ref('')
const defaultModelReasoningDraft = ref<ReasoningEffort>('high')
const auxiliaryModelRoleDraft = ref('')
const auxiliaryModelReasoningDraft = ref<ReasoningEffort>('high')

/** Encodes one provider+model pair as a role-select value. */
function roleSelectValue(providerId: string, model: string): string {
  return JSON.stringify([providerId, model])
}

const defaultModelRoleOptions = computed(() =>
  agent.providers.flatMap((provider) =>
    provider.enabledModelIds.map((model) => ({
      label: `${provider.label} / ${model}`,
      value: roleSelectValue(provider.id, model),
    })),
  ),
)
const auxiliaryModelRoleOptions = computed(() => [
  { label: t('settings.auxiliaryFollowDefault'), value: '' },
  ...defaultModelRoleOptions.value,
])

function parseRoleSelectValue(value: string): [string, string] | undefined {
  if (!value) return undefined
  return JSON.parse(value) as [string, string]
}

function roleReasoningOptions(value: string) {
  const selection = parseRoleSelectValue(value)
  const provider = agent.providers.find(
    (candidate) => candidate.id === selection?.[0],
  )
  const model = selection?.[1] ?? ''
  return resolveSupportedReasoningEfforts(provider?.modelOverrides[model]).map(
    (effort) => ({
      label: t(REASONING_LABEL_KEYS[effort]),
      value: effort,
    }),
  )
}

function roleDraftCompatible(value: string, reasoning: ReasoningEffort) {
  const selection = parseRoleSelectValue(value)
  const provider = agent.providers.find(
    (candidate) => candidate.id === selection?.[0],
  )
  return evaluateModelRouteCompatibility(provider, {
    model: selection?.[1] ?? '',
    reasoning,
  }).ok
}

const defaultModelReasoningOptions = computed(() =>
  roleReasoningOptions(defaultModelRoleDraft.value),
)
const auxiliaryModelReasoningOptions = computed(() =>
  roleReasoningOptions(auxiliaryModelRoleDraft.value),
)
const defaultModelRoleInvalid = computed(
  () =>
    Boolean(defaultModelRoleDraft.value) &&
    !roleDraftCompatible(
      defaultModelRoleDraft.value,
      defaultModelReasoningDraft.value,
    ),
)
const auxiliaryModelRoleInvalid = computed(
  () =>
    Boolean(auxiliaryModelRoleDraft.value) &&
    !roleDraftCompatible(
      auxiliaryModelRoleDraft.value,
      auxiliaryModelReasoningDraft.value,
    ),
)

function syncModelRoleDrafts(): void {
  const defaultProvider = agent.providers.find(
    (candidate) => candidate.id === agent.defaultModelProvider,
  )
  const defaultModel = agent.defaultModel || defaultProvider?.model || ''
  defaultModelRoleDraft.value = defaultModel
    ? roleSelectValue(agent.defaultModelProvider, defaultModel)
    : ''
  defaultModelReasoningDraft.value = agent.defaultModelReasoning
  auxiliaryModelRoleDraft.value = agent.auxiliaryModel
    ? roleSelectValue(agent.auxiliaryModelProvider, agent.auxiliaryModel)
    : ''
  auxiliaryModelReasoningDraft.value = agent.auxiliaryModelReasoning
}

async function persistDefaultModelRole(): Promise<void> {
  const selection = parseRoleSelectValue(defaultModelRoleDraft.value)
  if (
    !selection ||
    !roleDraftCompatible(
      defaultModelRoleDraft.value,
      defaultModelReasoningDraft.value,
    )
  ) {
    return
  }
  const saved = await agent.setDefaultModelRole(
    selection[0],
    selection[1],
    defaultModelReasoningDraft.value,
  )
  if (!saved) syncModelRoleDrafts()
}

async function persistAuxiliaryModelRole(): Promise<void> {
  const selection = parseRoleSelectValue(auxiliaryModelRoleDraft.value)
  if (!selection) {
    const saved = await agent.setAuxiliaryModelRole(
      '',
      '',
      defaultModelReasoningDraft.value,
    )
    if (!saved) syncModelRoleDrafts()
    return
  }
  if (
    !roleDraftCompatible(
      auxiliaryModelRoleDraft.value,
      auxiliaryModelReasoningDraft.value,
    )
  ) {
    return
  }
  const saved = await agent.setAuxiliaryModelRole(
    selection[0],
    selection[1],
    auxiliaryModelReasoningDraft.value,
  )
  if (!saved) syncModelRoleDrafts()
}

function selectDefaultModelRole(value: string): void {
  defaultModelRoleDraft.value = value
  void persistDefaultModelRole()
}

function selectDefaultModelReasoning(value: ReasoningEffort): void {
  defaultModelReasoningDraft.value = value
  void persistDefaultModelRole()
}

function selectAuxiliaryModelRole(value: string): void {
  auxiliaryModelRoleDraft.value = value
  if (!value) {
    auxiliaryModelReasoningDraft.value = defaultModelReasoningDraft.value
  }
  void persistAuxiliaryModelRole()
}

function selectAuxiliaryModelReasoning(value: ReasoningEffort): void {
  auxiliaryModelReasoningDraft.value = value
  void persistAuxiliaryModelRole()
}

watch(
  () =>
    JSON.stringify({
      defaultModelProvider: agent.defaultModelProvider,
      defaultModel: agent.defaultModel,
      defaultModelReasoning: agent.defaultModelReasoning,
      auxiliaryModelProvider: agent.auxiliaryModelProvider,
      auxiliaryModel: agent.auxiliaryModel,
      auxiliaryModelReasoning: agent.auxiliaryModelReasoning,
      providerDefaults: agent.providers.map((provider) => ({
        id: provider.id,
        model: provider.model,
      })),
    }),
  syncModelRoleDrafts,
  { immediate: true },
)
</script>

<template>
  <div class="settings-subsection">
    <div class="settings-subsection-heading">
      <h3>{{ t('settings.defaultModelsTitle') }}</h3>
      <p>{{ t('settings.defaultModelsHint') }}</p>
    </div>
    <div class="settings-inline settings-inline-equal">
      <label class="settings-field">
        <span>{{ t('settings.defaultModelRole') }}</span>
        <div class="settings-inline settings-inline-equal">
          <NSelect
            data-testid="default-model-role-select"
            :value="defaultModelRoleDraft"
            :options="defaultModelRoleOptions"
            :placeholder="t('settings.selectMainModel')"
            :disabled="agent.rolesSaving"
            filterable
            @update:value="selectDefaultModelRole"
          />
          <NSelect
            data-testid="default-model-reasoning-select"
            :value="defaultModelReasoningDraft"
            :options="defaultModelReasoningOptions"
            :placeholder="t('settings.reasoning')"
            :disabled="agent.rolesSaving || !defaultModelRoleDraft"
            :status="defaultModelRoleInvalid ? 'error' : undefined"
            @update:value="selectDefaultModelReasoning"
          />
        </div>
        <small v-if="defaultModelRoleInvalid" class="settings-field-error">
          {{ t('settings.modelRoleReasoningConflictHint') }}
        </small>
        <small v-else>{{ t('settings.defaultModelRoleHint') }}</small>
      </label>
      <label class="settings-field">
        <span>{{ t('settings.auxiliaryModelRole') }}</span>
        <div class="settings-inline settings-inline-equal">
          <NSelect
            data-testid="auxiliary-model-role-select"
            :value="auxiliaryModelRoleDraft"
            :options="auxiliaryModelRoleOptions"
            :disabled="agent.rolesSaving"
            filterable
            @update:value="selectAuxiliaryModelRole"
          />
          <NSelect
            data-testid="auxiliary-model-reasoning-select"
            :value="auxiliaryModelReasoningDraft"
            :options="auxiliaryModelReasoningOptions"
            :placeholder="t('settings.reasoning')"
            :disabled="agent.rolesSaving || !auxiliaryModelRoleDraft"
            :status="auxiliaryModelRoleInvalid ? 'error' : undefined"
            @update:value="selectAuxiliaryModelReasoning"
          />
        </div>
        <small v-if="auxiliaryModelRoleInvalid" class="settings-field-error">
          {{ t('settings.modelRoleReasoningConflictHint') }}
        </small>
        <small v-else>{{ t('settings.auxiliaryModelRoleHint') }}</small>
      </label>
    </div>
    <small
      class="settings-save-status"
      data-testid="model-roles-save-status"
      aria-live="polite"
    >
      {{
        agent.rolesSaving
          ? t('settings.saving')
          : agent.rolesSaveStatus === 'saved'
            ? t('settings.saved')
            : agent.rolesSaveStatus
      }}
    </small>
  </div>
</template>
