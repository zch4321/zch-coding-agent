<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  NButton,
  NDropdown,
  NAlert,
  NInput,
  NPopover,
  NSelect,
  NTag,
  NTooltip,
  type DropdownOption,
  type GlobalThemeOverrides,
  type InputInst,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { IPC_VERSION } from '../../../shared/channels'
import type { PermissionMode } from '../../../shared/config'
import type {
  ContextAttachmentChip,
  ContextAttachmentKind,
} from '../../../shared/context'
import { useAgentStore } from '../../stores/agent'
import { useSkillsStore } from '../../stores/skills'
import { useNotificationStore } from '../../stores/notifications'
import {
  detectComposerSuggestionTrigger,
  formatWorkspaceExpansionPath,
  formatWorkspaceSuggestionPath,
  replaceComposerRange,
  SLASH_COMMANDS,
  workspaceSuggestionQuery,
  type ComposerSuggestionItem,
  type ComposerSuggestionTrigger,
} from './composer-suggestions'
import ComposerSuggestionPanel from './ComposerSuggestionPanel.vue'
import UiIcon from '../UiIcon.vue'

const emit = defineEmits<{
  mode: [value: PermissionMode]
  provider: []
}>()
const agent = useAgentStore()
const skills = useSkillsStore()
const notifications = useNotificationStore()
const { t } = useI18n()
const composerInput = ref<InputInst>()
const suggestionTrigger = ref<ComposerSuggestionTrigger>()
const suggestionItems = ref<ComposerSuggestionItem[]>([])
const suggestionLoading = ref(false)
const activeSuggestionIndex = ref(0)
const skillsLoadedOnce = ref(false)
let suggestionRequestGeneration = 0
let suggestionRefreshTimer: number | undefined
let suppressNextSuggestionRefresh = false
const composerInputThemeOverrides = {
  border: '0',
  borderHover: '0',
  borderFocus: '0',
  boxShadowFocus: 'none',
  colorDisabled: 'transparent',
} satisfies NonNullable<GlobalThemeOverrides['Input']>

const modeOptions = computed(() => [
  { label: t('chat.readonly'), value: 'readonly' },
  { label: t('chat.auto'), value: 'auto' },
  { label: t('chat.confirm'), value: 'confirm' },
  { label: t('chat.yolo'), value: 'yolo' },
])
const contextOptions = computed<DropdownOption[]>(() => [
  { label: t('chat.addFileContext'), key: 'file' },
  { label: t('chat.addDirectoryContext'), key: 'directory' },
])
// Context attachment and mode controls are disabled while a run is active or
// an approval is pending: live interjections are text-only, so the context
// dropdown/chips and @file suggestions must not imply otherwise. The textarea
// itself stays enabled (see textareaDisabled) so the user can type an
// interjection.
const inputDisabled = computed(
  () =>
    !agent.workspacePath ||
    agent.startPending ||
    Boolean(agent.activeRunId) ||
    Boolean(agent.pendingApproval),
)
const textareaDisabled = computed(() => !agent.workspacePath)
const sendHint = computed(() => {
  if (!agent.workspacePath) return t('chat.chooseHint')
  if (!agent.credentialConfigured) return t('chat.apiKeyHint')
  if (!agent.providerNoticeAccepted) return t('chat.noticeHint')
  if (agent.activeRunId) return t('chat.interjectionHint')
  return t('chat.inputHint')
})
const suggestionPanelVisible = computed(() => Boolean(suggestionTrigger.value))
const suggestionTitle = computed(() => {
  switch (suggestionTrigger.value?.kind) {
    case 'slash':
      return t('chat.suggestions.commandsTitle')
    case 'skill':
      return t('chat.suggestions.skillsTitle')
    case 'context':
      return t('chat.suggestions.contextTitle')
    default:
      return ''
  }
})
const suggestionEmptyText = computed(() => {
  switch (suggestionTrigger.value?.kind) {
    case 'skill':
      return t('chat.suggestions.noSkills')
    case 'context':
      return t('chat.suggestions.noFiles')
    default:
      return t('chat.suggestions.noCommands')
  }
})

function textareaElement(): HTMLTextAreaElement | undefined {
  return composerInput.value?.textareaElRef ?? undefined
}

function inputCursor(): number {
  const textarea = textareaElement()
  return textarea?.selectionStart ?? agent.input.length
}

function focusInput(cursor?: number) {
  void nextTick(() => {
    const textarea = textareaElement()
    if (!textarea) return
    textarea.focus()
    if (cursor !== undefined) textarea.setSelectionRange(cursor, cursor)
  })
}

function clearSuggestions() {
  cancelSuggestionRefreshTimer()
  suggestionRequestGeneration += 1
  suggestionTrigger.value = undefined
  suggestionItems.value = []
  suggestionLoading.value = false
  activeSuggestionIndex.value = 0
}

function slashSuggestions(query: string): ComposerSuggestionItem[] {
  const normalized = query.toLowerCase()
  return SLASH_COMMANDS.filter((item) =>
    item.command.startsWith(normalized),
  ).map((item) => ({
    id: `slash:${item.command}`,
    label: `/${item.command}`,
    detail: t(`chat.suggestions.commands.${item.command}`),
    icon: 'terminal',
    replacement: item.usage,
  }))
}

async function skillSuggestions(
  query: string,
  generation: number,
): Promise<ComposerSuggestionItem[]> {
  if (!skillsLoadedOnce.value) {
    suggestionLoading.value = true
    await skills.load(false)
    skillsLoadedOnce.value = true
  }
  if (generation !== suggestionRequestGeneration) return []

  const normalized = query.toLowerCase()
  return skills.items
    .filter(
      (skill) =>
        skill.enabled && skill.name.toLowerCase().startsWith(normalized),
    )
    .slice(0, 8)
    .map((skill) => ({
      id: `skill:${skill.name}`,
      label: skill.name,
      detail: skill.description,
      icon: 'app',
      replacement: `${skill.name} `,
    }))
}

async function contextSuggestions(
  query: string,
  generation: number,
): Promise<ComposerSuggestionItem[]> {
  const bridge = window.agentApi
  const workspace = agent.workspacePath
  const projectId = agent.selectedProjectId
  if (!bridge || !workspace || !projectId) return []

  const lookup = workspaceSuggestionQuery(query)
  suggestionLoading.value = true
  const result = await bridge.listWorkspaceDirectory({
    version: IPC_VERSION,
    projectId,
    path: lookup.directory,
  })

  if (
    generation !== suggestionRequestGeneration ||
    workspace !== agent.workspacePath ||
    (result.ok && result.value.workspace !== workspace)
  ) {
    return []
  }

  if (!result.ok) {
    notifications.error({
      code: result.error.code,
      message: result.error.message,
      ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
    })
    return []
  }

  const normalizedFilter = lookup.filter.toLowerCase()
  const items: ComposerSuggestionItem[] = []
  if (lookup.directory !== '.' && lookup.filter.length === 0) {
    items.push({
      id: `context:choose-directory:${lookup.directory}`,
      label: t('chat.suggestions.chooseDirectoryLabel'),
      detail: t('chat.suggestions.chooseDirectoryDetail', {
        path: lookup.directory,
      }),
      icon: 'folder',
      attachment: { kind: 'directory', path: lookup.directory },
    })
  }

  items.push(
    ...result.value.entries
      .filter((entry) => entry.name.toLowerCase().startsWith(normalizedFilter))
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1
        return left.name.localeCompare(right.name)
      })
      .slice(0, 10)
      .map((entry) => {
        const path = formatWorkspaceSuggestionPath(lookup.directory, entry.name)
        return {
          id: `context:${entry.type}:${path}`,
          label: entry.type === 'directory' ? `${entry.name}/` : entry.name,
          detail:
            entry.type === 'directory'
              ? t('chat.suggestions.directoryDetail', { path })
              : t('chat.suggestions.fileDetail', { path }),
          icon:
            entry.type === 'directory'
              ? ('folder' as const)
              : ('file' as const),
          ...(entry.type === 'directory'
            ? { expandTo: formatWorkspaceExpansionPath(path) }
            : { attachment: { kind: 'file' as const, path } }),
        }
      }),
  )
  return items
}

function cancelSuggestionRefreshTimer() {
  if (suggestionRefreshTimer !== undefined) {
    window.clearTimeout(suggestionRefreshTimer)
    suggestionRefreshTimer = undefined
  }
}

async function refreshSuggestions() {
  if (inputDisabled.value) {
    clearSuggestions()
    return
  }

  const trigger = detectComposerSuggestionTrigger(agent.input, inputCursor())
  if (!trigger) {
    clearSuggestions()
    return
  }

  const generation = ++suggestionRequestGeneration
  suggestionTrigger.value = trigger
  activeSuggestionIndex.value = 0
  suggestionLoading.value = false

  if (trigger.kind === 'slash') {
    suggestionItems.value = slashSuggestions(trigger.query)
    return
  }

  const items =
    trigger.kind === 'skill'
      ? await skillSuggestions(trigger.query, generation)
      : await contextSuggestions(trigger.query, generation)

  if (generation !== suggestionRequestGeneration) return
  suggestionItems.value = items
  suggestionLoading.value = false
}

function scheduleSuggestionRefresh() {
  cancelSuggestionRefreshTimer()
  suggestionRefreshTimer = window.setTimeout(() => {
    suggestionRefreshTimer = undefined
    void refreshSuggestions()
  }, 80)
}

function replaceComposerInput(start: number, end: number, replacement: string) {
  suppressNextSuggestionRefresh = true
  agent.input = replaceComposerRange(agent.input, start, end, replacement)
}

function contextChipFromSuggestion(
  item: ComposerSuggestionItem,
): ContextAttachmentChip | undefined {
  if (!item.attachment) return undefined
  return {
    kind: item.attachment.kind,
    path: item.attachment.path,
    source: 'mention',
  }
}

function selectSuggestion(item: ComposerSuggestionItem) {
  const trigger = suggestionTrigger.value
  if (!trigger) return

  if (item.expandTo) {
    const replacement = `@${item.expandTo}`
    const cursor = trigger.replaceStart + replacement.length
    replaceComposerInput(trigger.replaceStart, trigger.replaceEnd, replacement)
    focusInput(cursor)
    suggestionItems.value = []
    suggestionLoading.value = true
    void nextTick(() => refreshSuggestions())
    return
  }

  const attachment = contextChipFromSuggestion(item)
  if (attachment) {
    agent.addContextAttachments([attachment])
    replaceComposerInput(trigger.replaceStart, trigger.replaceEnd, '')
    clearSuggestions()
    focusInput(trigger.replaceStart)
    return
  }

  if (!item.replacement) return
  replaceComposerInput(
    trigger.replaceStart,
    trigger.replaceEnd,
    item.replacement,
  )
  clearSuggestions()
  focusInput(trigger.replaceStart + item.replacement.length)
}

function selectActiveSuggestion() {
  const item = suggestionItems.value[activeSuggestionIndex.value]
  if (item) selectSuggestion(item)
}

function moveSuggestion(delta: number) {
  const total = suggestionItems.value.length
  if (!total) return
  activeSuggestionIndex.value =
    (activeSuggestionIndex.value + delta + total) % total
}

function handleKeydown(event: KeyboardEvent) {
  if (!event.isComposing && suggestionPanelVisible.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSuggestion(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSuggestion(-1)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      selectActiveSuggestion()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      clearSuggestions()
      return
    }
  }

  if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  void (agent.activeRunId ? agent.sendInterjection() : agent.sendMessage())
}

function handleKeyup(event: KeyboardEvent) {
  if (
    event.key === 'ArrowDown' ||
    event.key === 'ArrowUp' ||
    event.key === 'Enter' ||
    event.key === 'Tab' ||
    event.key === 'Escape'
  ) {
    return
  }
  scheduleSuggestionRefresh()
}

function handleContextSelect(key: string | number) {
  if (key === 'file' || key === 'directory') {
    void agent.chooseContextAttachment(key as ContextAttachmentKind)
  }
}

async function handleProviderSelect(value: string | number) {
  const providerId = String(value)
  if (
    providerId === agent.activeProviderId ||
    agent.activeRunId ||
    agent.pendingApproval
  ) {
    return
  }

  await agent.setActiveProvider(providerId)
}

watch(
  () => agent.input,
  () => {
    if (suppressNextSuggestionRefresh) {
      suppressNextSuggestionRefresh = false
      return
    }
    scheduleSuggestionRefresh()
  },
)
watch(inputDisabled, (disabled) => {
  if (disabled) clearSuggestions()
})
</script>

<template>
  <footer class="message-input-area">
    <NAlert
      v-if="agent.bridgeAvailable && !agent.providerNoticeAccepted"
      type="info"
      :title="t('chat.providerNotice')"
      class="composer-notice"
    >
      {{ t('chat.providerNoticeText') }}
      <div class="notice-action">
        <NButton
          size="small"
          type="primary"
          @click="agent.acceptProviderNotice"
        >
          {{ t('chat.understand') }}
        </NButton>
      </div>
    </NAlert>
    <div v-if="agent.contextAttachments.length" class="composer-context-chips">
      <NTooltip
        v-for="attachment in agent.contextAttachments"
        :key="attachment.kind + ':' + attachment.path"
      >
        <template #trigger>
          <NTag
            class="context-chip"
            round
            size="small"
            closable
            @close="
              agent.removeContextAttachment(attachment.path, attachment.kind)
            "
          >
            <template #icon>
              <UiIcon
                :name="attachment.kind === 'directory' ? 'folder' : 'file'"
              />
            </template>
            <span>{{ attachment.path }}</span>
          </NTag>
        </template>
        {{ attachment.path }}
      </NTooltip>
    </div>
    <NPopover
      trigger="manual"
      placement="top-start"
      raw
      :show="suggestionPanelVisible"
      :show-arrow="false"
      :to="false"
    >
      <template #trigger>
        <NInput
          ref="composerInput"
          v-model:value="agent.input"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 7 }"
          :placeholder="sendHint"
          :disabled="textareaDisabled"
          :theme-overrides="composerInputThemeOverrides"
          @keydown="handleKeydown"
          @click="scheduleSuggestionRefresh"
          @keyup="handleKeyup"
          @focus="scheduleSuggestionRefresh"
        />
      </template>
      <ComposerSuggestionPanel
        :items="suggestionItems"
        :active-index="activeSuggestionIndex"
        :title="suggestionTitle"
        :loading="suggestionLoading"
        :empty-text="suggestionEmptyText"
        @hover="activeSuggestionIndex = $event"
        @select="selectSuggestion"
      />
    </NPopover>
    <div class="message-input-toolbar">
      <div class="input-selectors">
        <NDropdown
          trigger="click"
          :options="contextOptions"
          :disabled="inputDisabled"
          @select="handleContextSelect"
        >
          <NButton
            size="small"
            secondary
            circle
            :aria-label="t('chat.addFileContext')"
            :disabled="inputDisabled"
          >
            <template #icon><UiIcon name="plus" /></template>
          </NButton>
        </NDropdown>
        <NSelect
          :value="agent.composerProviderId"
          style="width: min(180px, 24vw); min-width: 120px; flex: 0 1 180px"
          size="small"
          :options="agent.providerOptions"
          :disabled="
            Boolean(
              agent.startPending || agent.activeRunId || agent.pendingApproval,
            )
          "
          filterable
          @update:value="handleProviderSelect"
        />
        <NSelect
          :value="agent.composerModel"
          style="width: min(220px, 28vw); min-width: 0; flex: 1 1 auto"
          size="small"
          :options="agent.composerModelOptions"
          filterable
          tag
          @update:value="agent.setProviderModel"
        />
        <NTooltip>
          <template #trigger>
            <NButton
              class="provider-settings-button"
              quaternary
              circle
              size="small"
              :aria-label="t('chat.providerSettings')"
              @click="emit('provider')"
            >
              <template #icon><UiIcon name="settings" /></template>
            </NButton>
          </template>
          {{ t('chat.providerSettings') }}
        </NTooltip>
        <NTooltip :disabled="!agent.modeLockedByWriter">
          <template #trigger>
            <NSelect
              :value="agent.modeLockedByWriter ? 'readonly' : agent.mode"
              class="mode-select"
              style="width: 112px"
              size="small"
              :options="modeOptions"
              :disabled="
                Boolean(
                  agent.startPending ||
                  agent.activeRunId ||
                  agent.pendingApproval ||
                  agent.modeLockedByWriter,
                )
              "
              @update:value="emit('mode', $event as PermissionMode)"
            />
          </template>
          {{ agent.modeLockTooltip }}
        </NTooltip>
      </div>
      <NTooltip v-if="agent.activeRunId">
        <template #trigger>
          <div class="run-actions">
            <NButton
              class="send-button interject"
              circle
              type="primary"
              :aria-label="t('chat.interjectionSend')"
              :disabled="!agent.canInterject"
              @click="agent.sendInterjection"
            >
              <template #icon><UiIcon name="send" /></template>
            </NButton>
            <NButton
              class="send-button stop"
              circle
              type="error"
              :aria-label="t('chat.stop')"
              :disabled="agent.runStatus === 'cancelling'"
              @click="() => agent.interruptRun()"
            >
              <template #icon><UiIcon name="stop" /></template>
            </NButton>
          </div>
        </template>
        {{ t('chat.interjectionSend') }} / {{ t('chat.stop') }}
      </NTooltip>
      <NTooltip v-else>
        <template #trigger>
          <NButton
            class="send-button"
            circle
            type="primary"
            :aria-label="t('chat.send')"
            :disabled="!agent.canSend"
            @click="agent.sendMessage"
          >
            <template #icon><UiIcon name="send" /></template>
          </NButton>
        </template>
        {{ t('chat.send') }}
      </NTooltip>
    </div>
  </footer>
</template>
