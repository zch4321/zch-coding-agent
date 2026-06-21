<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useI18n } from 'vue-i18n'
import '@xterm/xterm/css/xterm.css'
import { IPC_VERSION } from '../../shared/channels'
import type { TerminalEvent } from '../../shared/agent-events'
import type { TerminalId } from '../../shared/ids'
import type { TerminalInfo } from '../../shared/terminal'
import { useAgentStore } from '../stores/agent'
import { TerminalSequenceTracker } from '../terminal-sequence'
import UiIcon from './UiIcon.vue'

const emit = defineEmits<{
  close: []
  'maximize-change': [maximized: boolean]
  'height-change': [height: number]
}>()

interface TerminalView {
  terminal: Terminal
  fit: FitAddon
  inputDisposable: { dispose(): void }
}

const agent = useAgentStore()
const { t } = useI18n()
const terminals = ref<TerminalInfo[]>([])
const activeTerminalId = ref<TerminalId>()
const error = ref('')
const recoveryNotice = ref('')
const maximized = ref(false)
const hosts = new Map<TerminalId, HTMLElement>()
const views = new Map<TerminalId, TerminalView>()
let unsubscribe: (() => void) | undefined
let resizeObserver: ResizeObserver | undefined
let creatingSession = false
let resizeStartY = 0
let resizeStartHeight = 0
const sequence = new TerminalSequenceTracker()

function terminalLabel(terminal: TerminalInfo, index: number): string {
  const shell = terminal.shell.replace(/\\/gu, '/').split('/').at(-1)
  return shell || t('terminal.name', { index: index + 1 })
}

function setHost(terminalId: TerminalId, element: Element | null): void {
  if (element instanceof HTMLElement) {
    hosts.set(terminalId, element)
    void attachView(terminalId)
  } else {
    hosts.delete(terminalId)
  }
}

async function attachView(
  terminalId: TerminalId,
  restoreSnapshot = false,
): Promise<void> {
  const host = hosts.get(terminalId)
  const bridge = window.agentApi
  const sessionId = agent.sessionId

  if (!host || views.has(terminalId)) {
    return
  }

  const terminal = new Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: true,
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 5_000,
    theme: {
      background: '#fbfbfb',
      foreground: '#24292f',
      cursor: '#0969da',
      selectionBackground: '#add6ff',
      black: '#24292f',
      red: '#cf222e',
      green: '#116329',
      yellow: '#9a6700',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#d0d7de',
      brightBlack: '#57606a',
      brightRed: '#a40e26',
      brightGreen: '#1a7f37',
      brightYellow: '#bf8700',
      brightBlue: '#218bff',
      brightMagenta: '#a475f9',
      brightCyan: '#3192aa',
      brightWhite: '#ffffff',
    },
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(host)
  const inputDisposable = terminal.onData((data) => {
    if (!bridge || !sessionId) {
      return
    }

    void bridge.sendTerminalInput({
      version: IPC_VERSION,
      sessionId,
      terminalId,
      data,
    })
  })
  views.set(terminalId, { terminal, fit, inputDisposable })

  if (restoreSnapshot) {
    await restoreTerminal(terminalId)
  }

  if (activeTerminalId.value === terminalId) {
    fitActiveTerminal()
  }
}

function disposeView(terminalId: TerminalId): void {
  const view = views.get(terminalId)
  view?.inputDisposable.dispose()
  view?.terminal.dispose()
  views.delete(terminalId)
  hosts.delete(terminalId)
}

function fitActiveTerminal(): void {
  const bridge = window.agentApi
  const sessionId = agent.sessionId
  const terminalId = activeTerminalId.value

  if (!bridge || !sessionId || !terminalId) {
    return
  }

  const view = views.get(terminalId)

  if (!view) {
    return
  }

  view.fit.fit()
  const { cols, rows } = view.terminal
  void bridge.resizeTerminal({
    version: IPC_VERSION,
    sessionId,
    terminalId,
    cols,
    rows,
  })
}

async function loadTerminals(createWhenEmpty = false): Promise<void> {
  const bridge = window.agentApi

  if (!bridge) {
    error.value = t('terminal.bridgeUnavailable')
    return
  }

  if (!agent.sessionId && createWhenEmpty) {
    creatingSession = true

    try {
      await agent.createSession()
    } finally {
      creatingSession = false
    }
  }

  const sessionId = agent.sessionId

  if (!sessionId) {
    terminals.value = []
    activeTerminalId.value = undefined
    return
  }

  const result = await bridge.listTerminals({
    version: IPC_VERSION,
    sessionId,
  })

  if (!result.ok) {
    error.value = result.error.message
    return
  }

  terminals.value = result.value.terminals

  if (terminals.value.length === 0 && createWhenEmpty) {
    await createTerminal()
    return
  }

  if (
    !activeTerminalId.value ||
    !terminals.value.some(
      (terminal) => terminal.terminalId === activeTerminalId.value,
    )
  ) {
    activeTerminalId.value = terminals.value[0]?.terminalId
  }

  await nextTick()

  for (const terminal of terminals.value) {
    await attachView(terminal.terminalId, true)
  }
}

async function createTerminal(): Promise<void> {
  const bridge = window.agentApi
  error.value = ''

  if (!bridge) {
    error.value = t('terminal.bridgeUnavailable')
    return
  }

  if (!agent.sessionId) {
    creatingSession = true
    let created: boolean

    try {
      created = await agent.createSession()
    } finally {
      creatingSession = false
    }

    if (!created) {
      error.value = agent.error || t('terminal.createFailed')
      return
    }
  }

  const sessionId = agent.sessionId

  if (!sessionId) {
    return
  }

  const result = await bridge.openTerminal({
    version: IPC_VERSION,
    sessionId,
    cols: 100,
    rows: 30,
  })

  if (!result.ok) {
    error.value = result.error.message
    return
  }

  terminals.value.push(result.value.terminal)
  activeTerminalId.value = result.value.terminal.terminalId
  await nextTick()
  await attachView(result.value.terminal.terminalId, true)
  fitActiveTerminal()
  views.get(result.value.terminal.terminalId)?.terminal.focus()
}

async function closeTerminal(terminalId: TerminalId): Promise<void> {
  const bridge = window.agentApi
  const sessionId = agent.sessionId

  if (!bridge || !sessionId) {
    return
  }

  const result = await bridge.closeTerminal({
    version: IPC_VERSION,
    sessionId,
    terminalId,
  })

  if (!result.ok) {
    error.value = result.error.message
    return
  }

  const index = terminals.value.findIndex(
    (terminal) => terminal.terminalId === terminalId,
  )
  terminals.value = terminals.value.filter(
    (terminal) => terminal.terminalId !== terminalId,
  )
  disposeView(terminalId)

  if (activeTerminalId.value === terminalId) {
    activeTerminalId.value = terminals.value[Math.max(0, index - 1)]?.terminalId
  }

  await nextTick()
  fitActiveTerminal()
}

function selectTerminal(terminalId: TerminalId): void {
  activeTerminalId.value = terminalId
  void nextTick(() => {
    fitActiveTerminal()
    views.get(terminalId)?.terminal.focus()
  })
}

function applyTerminalEvent(event: TerminalEvent): void {
  const decision = sequence.observe(event)

  if (decision === 'ignore' || decision === 'queue') {
    return
  }

  if (decision === 'recover') {
    recoveryNotice.value = t('terminal.outputGap')
    void restoreTerminal(event.terminalId)
    return
  }

  if (event.type === 'terminal.output') {
    views.get(event.terminalId)?.terminal.write(event.chunk)
    return
  }

  const terminal = terminals.value.find(
    (candidate) => candidate.terminalId === event.terminalId,
  )

  if (terminal) {
    terminal.status = event.status
    terminal.seq = event.seq
  }
}

function handleTerminalEvent(event: TerminalEvent): void {
  if (event.sessionId !== agent.sessionId) {
    return
  }

  if (!views.has(event.terminalId)) {
    sequence.defer(event)
    return
  }

  applyTerminalEvent(event)
}

async function restoreTerminal(terminalId: TerminalId): Promise<void> {
  const bridge = window.agentApi
  const sessionId = agent.sessionId
  const view = views.get(terminalId)

  if (!bridge || !sessionId || !view) {
    return
  }

  sequence.startRecovery(terminalId)

  try {
    const result = await bridge.getTerminalSnapshot({
      version: IPC_VERSION,
      sessionId,
      terminalId,
    })

    if (!result.ok) {
      error.value = result.error.message
      sequence.cancelRecovery(terminalId)
      return
    }

    view.terminal.reset()
    view.terminal.write(result.value.data)
    const terminal = terminals.value.find(
      (candidate) => candidate.terminalId === terminalId,
    )

    if (terminal) {
      Object.assign(terminal, result.value.terminal)
    }

    const queued = sequence.completeRecovery(
      terminalId,
      result.value.terminal.seq,
    )

    for (const event of queued.sort((left, right) => left.seq - right.seq)) {
      applyTerminalEvent(event)
    }
    recoveryNotice.value = result.value.truncated
      ? t('terminal.restoredTruncated')
      : ''
  } catch (restoreError) {
    sequence.cancelRecovery(terminalId)
    error.value =
      restoreError instanceof Error
        ? restoreError.message
        : t('terminal.restoreFailed')
    recoveryNotice.value = ''
  }
}

function toggleMaximized(): void {
  maximized.value = !maximized.value
  emit('maximize-change', maximized.value)
  void nextTick(fitActiveTerminal)
}

function continuePanelResize(event: PointerEvent): void {
  const maximum = Math.max(160, window.innerHeight - 180)
  emit(
    'height-change',
    Math.min(
      maximum,
      Math.max(160, resizeStartHeight + resizeStartY - event.clientY),
    ),
  )
}

function finishPanelResize(): void {
  window.removeEventListener('pointermove', continuePanelResize)
  window.removeEventListener('pointerup', finishPanelResize)
}

function beginPanelResize(event: PointerEvent): void {
  if (maximized.value) return
  const panel = (event.currentTarget as HTMLElement).closest('.terminal-panel')
  if (!(panel instanceof HTMLElement)) return
  event.preventDefault()
  resizeStartY = event.clientY
  resizeStartHeight = panel.getBoundingClientRect().height
  window.addEventListener('pointermove', continuePanelResize)
  window.addEventListener('pointerup', finishPanelResize, { once: true })
}

watch(
  () => agent.sessionId,
  async () => {
    if (creatingSession) {
      return
    }

    sequence.reset()
    for (const terminalId of [...views.keys()]) {
      disposeView(terminalId)
    }
    await loadTerminals(false)
  },
  { flush: 'sync' },
)

watch(activeTerminalId, () => void nextTick(fitActiveTerminal))

onMounted(async () => {
  unsubscribe = window.agentApi?.onTerminalEvent((envelope) =>
    handleTerminalEvent(envelope.event),
  )
  resizeObserver = new ResizeObserver(() => fitActiveTerminal())
  const panel = document.querySelector('.terminal-panel')

  if (panel) {
    resizeObserver.observe(panel)
  }

  await loadTerminals(true)
})

onUnmounted(() => {
  finishPanelResize()
  unsubscribe?.()
  resizeObserver?.disconnect()

  for (const terminalId of [...views.keys()]) {
    disposeView(terminalId)
  }
})
</script>

<template>
  <section class="terminal-panel" :class="{ maximized }">
    <div
      class="terminal-resize-handle"
      role="separator"
      :aria-label="t('terminal.resize')"
      aria-orientation="horizontal"
      tabindex="0"
      @pointerdown="beginPanelResize"
    ></div>
    <header class="terminal-toolbar">
      <div
        class="terminal-tabs"
        role="tablist"
        :aria-label="t('terminal.terminals')"
      >
        <div
          v-for="(terminal, index) in terminals"
          :key="terminal.terminalId"
          class="terminal-tab"
          :class="{ active: terminal.terminalId === activeTerminalId }"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="terminal.terminalId === activeTerminalId"
            @click="selectTerminal(terminal.terminalId)"
          >
            <UiIcon name="terminal" />
            <span>{{ terminalLabel(terminal, index) }}</span>
            <small v-if="terminal.status !== 'running'">{{
              terminal.status
            }}</small>
          </button>
          <button
            type="button"
            class="terminal-tab-close"
            :aria-label="t('terminal.close')"
            :title="t('terminal.close')"
            @click="closeTerminal(terminal.terminalId)"
          >
            <UiIcon name="close" />
          </button>
        </div>
      </div>

      <div class="terminal-actions">
        <button
          type="button"
          :aria-label="t('terminal.new')"
          :title="t('terminal.new')"
          @click="createTerminal"
        >
          <UiIcon name="plus" />
        </button>
        <button
          type="button"
          :aria-label="
            maximized ? t('terminal.restore') : t('terminal.maximize')
          "
          :title="maximized ? t('terminal.restore') : t('terminal.maximize')"
          @click="toggleMaximized"
        >
          <UiIcon :name="maximized ? 'restore' : 'maximize-panel'" />
        </button>
        <button
          type="button"
          :aria-label="t('terminal.hide')"
          :title="t('terminal.hide')"
          @click="emit('close')"
        >
          <UiIcon name="chevron-down" />
        </button>
      </div>
    </header>

    <p v-if="error" class="terminal-error">{{ error }}</p>
    <p v-if="recoveryNotice" class="terminal-notice">
      {{ recoveryNotice }}
    </p>
    <div v-if="terminals.length === 0" class="terminal-empty">
      <span>{{ t('terminal.empty') }}</span>
      <button type="button" @click="createTerminal">
        {{ t('terminal.new') }}
      </button>
    </div>
    <div v-else class="terminal-views">
      <div
        v-for="terminal in terminals"
        v-show="terminal.terminalId === activeTerminalId"
        :key="terminal.terminalId"
        :ref="
          (element) => setHost(terminal.terminalId, element as Element | null)
        "
        class="terminal-surface"
      ></div>
    </div>
  </section>
</template>
