<script setup lang="ts">
import { computed, watch } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NTag,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  REASONING_EFFORTS,
  type ModelCapabilityLevel,
  type ModelPoolEntry,
  type ProviderPublicConfig,
  type ReasoningEffort,
} from '../../../shared/config'
import { evaluateModelRouteCompatibility } from '../../../shared/model-route'
import { resolveSupportedReasoningEfforts } from '../../../shared/model-settings'
import { useAgentSettingsStore } from '../../stores/agent-settings'
import { useModelPoolSettingsStore } from '../../stores/model-pool-settings'

const REASONING_LABEL_KEYS: Record<ReasoningEffort, string> = {
  off: 'settings.reasoningOff',
  low: 'settings.reasoningLow',
  medium: 'settings.reasoningMedium',
  high: 'settings.reasoningHigh',
  xhigh: 'settings.reasoningXhigh',
  max: 'settings.reasoningMax',
}

const CAPABILITY_LABEL_KEYS: Record<ModelCapabilityLevel, string> = {
  light: 'settings.capabilityLight',
  standard: 'settings.capabilityStandard',
  strong: 'settings.capabilityStrong',
}

const settings = useAgentSettingsStore()
const pool = useModelPoolSettingsStore()
const { t } = useI18n()

const canAddEntry = computed(() =>
  settings.providers.some((provider) =>
    provider.enabledModelIds.some(
      (model) => provider.modelOverrides[model]?.capability,
    ),
  ),
)

const providerOptions = computed(() =>
  settings.providers.map((provider) => ({
    label: provider.label,
    value: provider.id,
    disabled: !provider.enabledModelIds.some(
      (model) => provider.modelOverrides[model]?.capability,
    ),
  })),
)

const saveStatus = computed(() => {
  if (pool.saveStatus === 'external-change') {
    return t('modelPool.externalChange')
  }
  if (pool.saveStatus && pool.saveStatus !== 'saved') return pool.saveStatus
  if (pool.dirty) return t('settings.unsaved')
  return pool.saveStatus === 'saved' ? t('settings.saved') : ''
})

function entryProvider(
  entry: ModelPoolEntry,
): ProviderPublicConfig | undefined {
  return settings.providers.find((provider) => provider.id === entry.providerId)
}

function entryCapability(
  entry: ModelPoolEntry,
): ModelCapabilityLevel | undefined {
  return entryProvider(entry)?.modelOverrides[entry.model]?.capability
}

function capabilityLabel(capability: ModelCapabilityLevel): string {
  return t(CAPABILITY_LABEL_KEYS[capability])
}

function capabilityTagType(
  capability: ModelCapabilityLevel,
): 'info' | 'warning' | 'success' {
  if (capability === 'light') return 'info'
  if (capability === 'standard') return 'warning'
  return 'success'
}

function modelOptions(entry: ModelPoolEntry) {
  const provider = entryProvider(entry)
  if (!provider) {
    return entry.model
      ? [{ label: entry.model, value: entry.model, disabled: true }]
      : []
  }
  const options = provider.enabledModelIds.map((model) => {
    const capability = provider.modelOverrides[model]?.capability
    return {
      label: capability
        ? `${model} · ${capabilityLabel(capability)}`
        : `${model} · ${t('modelPool.capabilityMissing')}`,
      value: model,
      disabled: !capability,
    }
  })
  if (entry.model && !options.some((option) => option.value === entry.model)) {
    options.unshift({
      label: `${entry.model} · ${t('modelPool.modelUnavailable')}`,
      value: entry.model,
      disabled: true,
    })
  }
  return options
}

function reasoningOptions(entry: ModelPoolEntry) {
  const provider = entryProvider(entry)
  const supported = resolveSupportedReasoningEfforts(
    provider?.modelOverrides[entry.model],
  )
  return REASONING_EFFORTS.map((reasoning) => ({
    label: t(REASONING_LABEL_KEYS[reasoning]),
    value: reasoning,
    disabled: !supported.includes(reasoning),
  }))
}

function entryIssue(entry: ModelPoolEntry): string {
  const provider = entryProvider(entry)
  if (!provider) return t('modelPool.providerMissing')
  const compatibility = evaluateModelRouteCompatibility(provider, entry)
  if (!compatibility.ok) {
    if (compatibility.reason === 'reasoning-unsupported') {
      return t('modelPool.reasoningUnsupported')
    }
    return t('modelPool.modelUnavailable')
  }
  if (!entryCapability(entry)) return t('modelPool.capabilityMissingHint')
  if (!provider.credentialConfigured) return t('modelPool.credentialMissing')
  return ''
}

function canEnable(entry: ModelPoolEntry): boolean {
  return entryIssue(entry) === ''
}

function entryIdIssue(entry: ModelPoolEntry): string {
  const id = entry.id.trim().normalize('NFC')
  if (!id) return t('modelPool.idRequired')
  const matches = pool.entries.filter(
    (candidate) => candidate.id.trim().normalize('NFC') === id,
  )
  return matches.length > 1 ? t('modelPool.idDuplicate') : ''
}

function selectProvider(index: number, value: string | number) {
  pool.selectProvider(index, String(value), settings.providers)
}

function selectModel(index: number, value: string | number) {
  pool.selectModel(index, String(value), settings.providers)
}

function selectReasoning(index: number, value: string | number) {
  const entry = pool.entries[index]
  if (entry) entry.reasoning = String(value) as ReasoningEffort
}

function setMaxParallel(index: number, value: number | null) {
  const entry = pool.entries[index]
  if (!entry || value === null || !Number.isInteger(value)) return
  entry.maxParallel = value
}

watch(
  () => JSON.stringify(pool.entries),
  () => {
    if (!pool.saving && pool.dirty) pool.saveStatus = ''
  },
)
</script>

<template>
  <section class="settings-subsection model-pool-section">
    <div class="model-pool-heading">
      <div class="settings-subsection-heading">
        <h3>{{ t('modelPool.title') }}</h3>
        <p>{{ t('modelPool.hint') }}</p>
      </div>
      <div class="model-pool-heading-actions">
        <NButton
          secondary
          :disabled="!canAddEntry"
          @click="pool.addEntry(settings.providers)"
        >
          {{ t('modelPool.add') }}
        </NButton>
        <NButton
          type="primary"
          :loading="pool.saving"
          :disabled="!pool.dirty"
          @click="pool.save(settings.providers)"
        >
          {{ t('modelPool.save') }}
        </NButton>
        <small class="settings-save-status" aria-live="polite">
          {{ saveStatus }}
        </small>
      </div>
    </div>

    <NAlert v-if="!canAddEntry" type="warning" :show-icon="true">
      {{ t('modelPool.noEligibleModels') }}
    </NAlert>

    <NEmpty
      v-if="pool.entries.length === 0"
      class="model-pool-empty"
      :description="t('modelPool.empty')"
    />

    <div v-else class="model-pool-list" data-testid="model-pool-list">
      <article
        v-for="(entry, index) in pool.entries"
        :key="index"
        class="model-pool-entry"
        :data-testid="`model-pool-entry-${index}`"
      >
        <div class="model-pool-entry-heading">
          <label class="settings-field model-pool-entry-id">
            <span>{{ t('modelPool.entryId') }}</span>
            <NInput
              v-model:value="entry.id"
              :maxlength="64"
              :status="entryIdIssue(entry) ? 'error' : undefined"
              :placeholder="t('modelPool.entryIdPlaceholder')"
            />
            <small v-if="entryIdIssue(entry)" class="settings-field-error">
              {{ entryIdIssue(entry) }}
            </small>
          </label>
          <div class="model-pool-entry-actions">
            <NButton
              size="small"
              quaternary
              :disabled="index === 0"
              @click="pool.moveEntry(index, -1)"
            >
              {{ t('modelPool.moveUp') }}
            </NButton>
            <NButton
              size="small"
              quaternary
              :disabled="index === pool.entries.length - 1"
              @click="pool.moveEntry(index, 1)"
            >
              {{ t('modelPool.moveDown') }}
            </NButton>
            <NButton
              size="small"
              quaternary
              type="error"
              @click="pool.removeEntry(index)"
            >
              {{ t('modelPool.remove') }}
            </NButton>
          </div>
        </div>

        <div class="model-pool-entry-grid">
          <label class="settings-field">
            <span>{{ t('modelPool.provider') }}</span>
            <NSelect
              :value="entry.providerId"
              :options="providerOptions"
              filterable
              @update:value="selectProvider(index, $event)"
            />
          </label>

          <label class="settings-field">
            <span>{{ t('modelPool.model') }}</span>
            <NSelect
              :value="entry.model"
              :options="modelOptions(entry)"
              filterable
              @update:value="selectModel(index, $event)"
            />
          </label>

          <label class="settings-field">
            <span>{{ t('modelPool.reasoning') }}</span>
            <NSelect
              :value="entry.reasoning"
              :options="reasoningOptions(entry)"
              @update:value="selectReasoning(index, $event)"
            />
          </label>

          <label class="settings-field">
            <span>{{ t('modelPool.maxParallel') }}</span>
            <NInputNumber
              :value="entry.maxParallel"
              :min="1"
              :max="32"
              :step="1"
              @update:value="setMaxParallel(index, $event)"
            />
            <small>{{ t('modelPool.maxParallelHint') }}</small>
          </label>
        </div>

        <div class="model-pool-entry-footer">
          <div class="model-pool-capability">
            <span>{{ t('modelPool.capability') }}</span>
            <NTag
              v-if="entryCapability(entry)"
              size="small"
              round
              :type="capabilityTagType(entryCapability(entry)!)"
            >
              {{ capabilityLabel(entryCapability(entry)!) }}
            </NTag>
            <small v-else class="settings-field-error">
              {{ t('modelPool.capabilityMissing') }}
            </small>
          </div>
          <label class="model-pool-enabled">
            <span>{{ t('modelPool.enabled') }}</span>
            <NSwitch
              v-model:value="entry.enabled"
              :disabled="!entry.enabled && !canEnable(entry)"
            />
          </label>
        </div>

        <NAlert v-if="entryIssue(entry)" type="warning" :show-icon="true">
          {{ entryIssue(entry) }}
        </NAlert>
      </article>
    </div>
  </section>
</template>
