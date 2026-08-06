<script setup lang="ts">
import { computed, h, ref, watch, type VNodeChild } from 'vue'
import {
  NGi,
  NAlert,
  NButton,
  NEmpty,
  NFlex,
  NGrid,
  NSelect,
  NTag,
  NTransfer,
  NTree,
  type TreeOption,
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
import {
  modelPoolRouteKey,
  useModelPoolSettingsStore,
  type ModelPoolSelectableRoute,
} from '../../stores/model-pool-settings'

type ReasoningFloor = 'all' | ReasoningEffort

interface RouteDescriptor extends ModelPoolSelectableRoute {
  key: string
  providerLabel: string
  capability?: ModelCapabilityLevel
  available: boolean
}

interface ModelPoolTreeNode extends TreeOption {
  kind: 'provider' | 'model' | 'reasoning'
  capability?: ModelCapabilityLevel
  reasoning?: ReasoningEffort
  routeKey?: string
}

interface TransferListRenderProps {
  onCheck: (checkedValueList: Array<string | number>) => void
  pattern: string
}

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
const reasoningFloor = ref<ReasoningFloor>('all')

const reasoningOrder = new Map(
  REASONING_EFFORTS.map((reasoning, index) => [reasoning, index] as const),
)

const reasoningFloorOptions = computed(() => [
  { label: t('modelPool.reasoningFloorAll'), value: 'all' },
  ...REASONING_EFFORTS.filter((reasoning) => reasoning !== 'off').map(
    (reasoning) => ({
      label: t('modelPool.reasoningFloorAtLeast', {
        reasoning: t(REASONING_LABEL_KEYS[reasoning]),
      }),
      value: reasoning,
    }),
  ),
])

const selectedRouteKeys = computed(() => [
  ...new Set(pool.entries.map((entry) => modelPoolRouteKey(entry))),
])

const selectedRouteKeySet = computed(() => new Set(selectedRouteKeys.value))

const selectableRoutes = computed<RouteDescriptor[]>(() =>
  settings.providers.flatMap((provider) => {
    if (!provider.credentialConfigured) return []
    return provider.enabledModelIds.flatMap((model) => {
      const capability = provider.modelOverrides[model]?.capability
      if (!capability) return []
      return resolveSupportedReasoningEfforts(
        provider.modelOverrides[model],
      ).map((reasoning) => ({
        key: modelPoolRouteKey({
          providerId: provider.id,
          model,
          reasoning,
        }),
        providerId: provider.id,
        providerLabel: provider.label,
        model,
        reasoning,
        capability,
        available: true,
      }))
    })
  }),
)

const routeDescriptors = computed<RouteDescriptor[]>(() => {
  const descriptors = new Map(
    selectableRoutes.value.map((route) => [route.key, route]),
  )
  for (const entry of pool.entries) {
    const key = modelPoolRouteKey(entry)
    if (descriptors.has(key)) continue
    const provider = entryProvider(entry)
    descriptors.set(key, {
      key,
      providerId: entry.providerId,
      providerLabel: provider?.label ?? entry.providerId,
      model: entry.model,
      reasoning: entry.reasoning,
      capability: provider?.modelOverrides[entry.model]?.capability,
      available: false,
    })
  }
  return [...descriptors.values()]
})

const routeDescriptorByKey = computed(
  () => new Map(routeDescriptors.value.map((route) => [route.key, route])),
)

const entryByRouteKey = computed(() => {
  const entries = new Map<string, ModelPoolEntry>()
  for (const entry of pool.entries) {
    const key = modelPoolRouteKey(entry)
    if (!entries.has(key)) entries.set(key, entry)
  }
  return entries
})

const transferOptions = computed(() =>
  routeDescriptors.value.map((route) => ({
    label: `${route.providerLabel} / ${route.model} / ${reasoningLabel(route.reasoning)}`,
    value: route.key,
    disabled:
      !selectedRouteKeySet.value.has(route.key) &&
      (!route.available || !meetsReasoningFloor(route.reasoning)),
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

function reasoningLabel(reasoning: ReasoningEffort): string {
  return t(REASONING_LABEL_KEYS[reasoning])
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

function meetsReasoningFloor(reasoning: ReasoningEffort): boolean {
  if (reasoningFloor.value === 'all') return true
  return (
    (reasoningOrder.get(reasoning) ?? 0) >=
    (reasoningOrder.get(reasoningFloor.value) ?? 0)
  )
}

function entryProvider(
  entry: ModelPoolEntry,
): ProviderPublicConfig | undefined {
  return settings.providers.find((provider) => provider.id === entry.providerId)
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
  if (!provider.modelOverrides[entry.model]?.capability) {
    return t('modelPool.capabilityMissingHint')
  }
  if (!provider.credentialConfigured) return t('modelPool.credentialMissing')
  if (!entry.enabled) return t('modelPool.entryDisabled')
  return ''
}

function matchesPattern(route: RouteDescriptor, pattern: string): boolean {
  const normalized = pattern.trim().toLocaleLowerCase()
  if (!normalized) return true
  return [route.providerLabel, route.model, reasoningLabel(route.reasoning)]
    .join(' ')
    .toLocaleLowerCase()
    .includes(normalized)
}

function providerNodeKey(providerId: string): string {
  return `provider:${JSON.stringify(providerId)}`
}

function modelNodeKey(providerId: string, model: string): string {
  return `model:${JSON.stringify([providerId, model])}`
}

function buildRouteTree(routes: readonly RouteDescriptor[]): TreeOption[] {
  const providers = new Map<
    string,
    {
      label: string
      models: Map<
        string,
        {
          capability?: ModelCapabilityLevel
          routes: RouteDescriptor[]
        }
      >
    }
  >()
  for (const route of routes) {
    let provider = providers.get(route.providerId)
    if (!provider) {
      provider = { label: route.providerLabel, models: new Map() }
      providers.set(route.providerId, provider)
    }
    let model = provider.models.get(route.model)
    if (!model) {
      model = { capability: route.capability, routes: [] }
      provider.models.set(route.model, model)
    }
    model.routes.push(route)
  }

  return [...providers].map(([providerId, provider]) => ({
    key: providerNodeKey(providerId),
    label: provider.label,
    kind: 'provider',
    children: [...provider.models].map(([modelName, model]) => ({
      key: modelNodeKey(providerId, modelName),
      label: modelName,
      kind: 'model',
      capability: model.capability,
      children: model.routes.map((route) => ({
        key: route.key,
        label: reasoningLabel(route.reasoning),
        kind: 'reasoning',
        reasoning: route.reasoning,
        routeKey: route.key,
      })),
    })),
  }))
}

function renderTreeLabel({ option }: { option: TreeOption }): VNodeChild {
  return String(option.label ?? '')
}

function renderCapabilityTag(capability: ModelCapabilityLevel): VNodeChild {
  return h(
    NTag,
    {
      size: 'small',
      round: true,
      type: capabilityTagType(capability),
    },
    { default: () => capabilityLabel(capability) },
  )
}

function renderSourceSuffix({ option }: { option: TreeOption }): VNodeChild {
  const node = option as ModelPoolTreeNode
  return node.kind === 'model' && node.capability
    ? renderCapabilityTag(node.capability)
    : undefined
}

function renderTargetSuffix({ option }: { option: TreeOption }): VNodeChild {
  const node = option as ModelPoolTreeNode
  if (node.kind === 'model' && node.capability) {
    return renderCapabilityTag(node.capability)
  }
  if (node.kind !== 'reasoning' || !node.routeKey) return undefined
  const entry = entryByRouteKey.value.get(node.routeKey)
  if (!entry) return undefined
  const issue = entryIssue(entry)
  const belowFloor = !meetsReasoningFloor(entry.reasoning)
  return issue
    ? h(
        NTag,
        { size: 'small', type: 'error', title: issue },
        { default: () => t('modelPool.routeUnavailable') },
      )
    : belowFloor
      ? h(
          NTag,
          {
            size: 'small',
            type: 'warning',
            title: t('modelPool.belowReasoningFloorHint'),
          },
          { default: () => t('modelPool.belowReasoningFloor') },
        )
      : undefined
}

function renderEmptyTree(description: string): VNodeChild {
  return h(NEmpty, {
    class: 'model-pool-tree-empty',
    description,
    size: 'small',
  })
}

function renderSourceList({
  onCheck,
  pattern,
}: TransferListRenderProps): VNodeChild {
  const routes = selectableRoutes.value.filter(
    (route) =>
      !selectedRouteKeySet.value.has(route.key) &&
      meetsReasoningFloor(route.reasoning) &&
      matchesPattern(route, pattern),
  )
  const data = buildRouteTree(routes)
  if (!data.length) return renderEmptyTree(t('modelPool.noMatchingRoutes'))
  return h(NTree, {
    data,
    checkable: true,
    cascade: true,
    blockLine: true,
    checkOnClick: true,
    selectable: false,
    defaultExpandAll: true,
    checkedKeys: [],
    renderLabel: renderTreeLabel,
    renderSuffix: renderSourceSuffix,
    'onUpdate:checkedKeys': (keys: Array<string | number>) => {
      const additions = keys
        .map(String)
        .filter((key) => routeDescriptorByKey.value.get(key)?.available)
      onCheck([...selectedRouteKeys.value, ...additions])
    },
  })
}

function renderTargetList({
  onCheck,
  pattern,
}: TransferListRenderProps): VNodeChild {
  const routes = selectedRouteKeys.value.flatMap((key) => {
    const route = routeDescriptorByKey.value.get(key)
    return route && matchesPattern(route, pattern) ? [route] : []
  })
  const data = buildRouteTree(routes)
  if (!data.length) return renderEmptyTree(t('modelPool.empty'))
  const visibleKeys = new Set(routes.map((route) => route.key))
  return h(NTree, {
    data,
    checkable: true,
    cascade: true,
    blockLine: true,
    checkOnClick: true,
    selectable: false,
    defaultExpandAll: true,
    checkedKeys: routes.map((route) => route.key),
    renderLabel: renderTreeLabel,
    renderSuffix: renderTargetSuffix,
    'onUpdate:checkedKeys': (keys: Array<string | number>) => {
      const retainedHidden = selectedRouteKeys.value.filter(
        (key) => !visibleKeys.has(key),
      )
      const retainedVisible = keys
        .map(String)
        .filter((key) => visibleKeys.has(key))
      onCheck([...retainedHidden, ...retainedVisible])
    },
  })
}

function updateSelectedRoutes(values: Array<string | number>): void {
  pool.setSelectedRoutes(values.map(String), routeDescriptors.value)
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
    <NFlex justify="space-between" align="start" :wrap="true" :size="16">
      <div class="settings-subsection-heading">
        <h3>{{ t('modelPool.title') }}</h3>
        <p>{{ t('modelPool.hint') }}</p>
      </div>
      <NFlex align="center" :size="8">
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
      </NFlex>
    </NFlex>

    <NGrid cols="1 640:2" responsive="self" :x-gap="12" :y-gap="12">
      <NGi>
        <label class="settings-field">
          <span>{{ t('modelPool.reasoningFloor') }}</span>
          <NSelect
            v-model:value="reasoningFloor"
            :options="reasoningFloorOptions"
            data-testid="model-pool-reasoning-floor"
          />
          <small>{{ t('modelPool.reasoningFloorHint') }}</small>
        </label>
      </NGi>
    </NGrid>

    <NAlert
      v-if="selectableRoutes.length === 0"
      type="warning"
      :show-icon="true"
    >
      {{ t('modelPool.noEligibleModels') }}
    </NAlert>

    <NTransfer
      :value="selectedRouteKeys"
      :options="transferOptions"
      :source-title="t('modelPool.availableRoutes')"
      :target-title="t('modelPool.selectedRoutes')"
      :source-filter-placeholder="t('modelPool.filterRoutes')"
      :target-filter-placeholder="t('modelPool.filterRoutes')"
      :select-all-text="t('modelPool.selectAllRoutes')"
      :clear-text="t('modelPool.clearSelectedRoutes')"
      :render-source-list="renderSourceList"
      :render-target-list="renderTargetList"
      :show-selected="false"
      source-filterable
      target-filterable
      class="model-pool-transfer"
      data-testid="model-pool-transfer"
      @update:value="updateSelectedRoutes"
    />
  </section>
</template>
