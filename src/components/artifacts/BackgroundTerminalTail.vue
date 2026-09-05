<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NScrollbar, NSpin, type ScrollbarInst } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { BackgroundTerminal } from '../../../shared/background-tasks'
import type { SessionId } from '../../../shared/ids'
import { IPC_VERSION } from '../../../shared/channels'

const props = defineProps<{
  terminal: BackgroundTerminal
  sessionId: SessionId
  backendInstanceId: string
  visible: boolean
}>()
const { t } = useI18n()
const scrollbar = ref<ScrollbarInst | null>(null)
const content = ref('')
const error = ref<string>()
const truncated = ref(false)
const loaded = ref(false)
const loading = ref(false)
const following = ref(true)
const documentVisible = ref(document.visibilityState !== 'hidden')
const copied = ref(false)
const finished = computed(
  () =>
    props.terminal.status === 'closed' || props.terminal.status === 'failed',
)
const identity = computed(
  () =>
    `${props.backendInstanceId}:${props.sessionId}:${props.terminal.terminalId}`,
)
const enabled = computed(
  () => props.visible && documentVisible.value && following.value,
)
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let disposed = false
let scrolling = false
let finalRead = false

function clearTimer(): void {
  if (timer) clearTimeout(timer)
  timer = undefined
}
function schedule(): void {
  clearTimer()
  if (
    enabled.value &&
    !disposed &&
    !loading.value &&
    !(finished.value && finalRead)
  )
    timer = setTimeout(() => void refresh(), 1000)
}
async function refresh(): Promise<void> {
  if (!enabled.value || disposed || loading.value) return
  clearTimer()
  loading.value = true
  const requestGeneration = generation
  const requestIdentity = identity.value
  const wasFinished = finished.value
  try {
    const result = await window.agentApi?.getBackgroundTerminalTail({
      version: IPC_VERSION,
      parentSessionId: props.sessionId,
      backendInstanceId: props.backendInstanceId,
      terminalId: props.terminal.terminalId,
    })
    if (
      disposed ||
      requestGeneration !== generation ||
      requestIdentity !== identity.value ||
      !enabled.value
    )
      return
    if (!result?.ok) {
      error.value =
        result?.error.message ?? t('artifact.terminalLogUnavailable')
      return
    }
    if (result.value.cursor.backendInstanceId !== props.backendInstanceId)
      return
    if (!result.value.available) {
      error.value = result.value.error ?? t('artifact.terminalLogUnavailable')
      return
    }
    content.value = result.value.content
    truncated.value = result.value.truncated
    error.value = undefined
    loaded.value = true
    finalRead = wasFinished
    scrolling = true
    try {
      await nextTick()
      if (requestGeneration === generation && enabled.value)
        scrollbar.value?.scrollTo({ top: Number.MAX_SAFE_INTEGER })
      await nextTick()
    } finally {
      scrolling = false
    }
  } catch (failure) {
    if (!disposed && requestGeneration === generation)
      error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    if (requestGeneration === generation && enabled.value)
      finalRead = wasFinished
    loading.value = false
    if (enabled.value && requestGeneration !== generation) void refresh()
    else schedule()
  }
}
function onScroll(event: Event): void {
  if (scrolling || !loaded.value) return
  const target = event.target as HTMLElement
  if (target.scrollHeight - target.scrollTop - target.clientHeight > 24)
    following.value = false
}
function resume(): void {
  finalRead = false
  if (!following.value) following.value = true
  else if (enabled.value) void refresh()
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(content.value)
    copied.value = true
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  }
}
function visibilityChanged(): void {
  documentVisible.value = document.visibilityState !== 'hidden'
}
watch(identity, () => {
  generation += 1
  content.value = ''
  error.value = undefined
  loaded.value = false
  copied.value = false
  finalRead = false
  if (!following.value) following.value = true
  else if (enabled.value) void refresh()
})
watch(
  enabled,
  (value) => {
    generation += 1
    clearTimer()
    if (value) {
      finalRead = false
      void refresh()
    }
  },
  { immediate: true },
)
watch(finished, () => {
  finalRead = false
  if (enabled.value) void refresh()
})
onMounted(() =>
  document.addEventListener('visibilitychange', visibilityChanged),
)
onBeforeUnmount(() => {
  disposed = true
  generation += 1
  clearTimer()
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <section class="background-terminal-tail">
    <div class="background-log-toolbar">
      <span>{{
        t(following ? 'artifact.followingLog' : 'artifact.followingPaused')
      }}</span>
      <NButton v-if="!following || error" size="tiny" text @click="resume">{{
        t(error ? 'artifact.agentRetry' : 'artifact.resumeFollowing')
      }}</NButton>
      <NButton size="tiny" text :disabled="!content" @click="copy">{{
        t(copied ? 'artifact.logCopied' : 'artifact.copyLog')
      }}</NButton>
    </div>
    <p v-if="error" class="artifact-error" role="alert">{{ error }}</p>
    <NSpin v-if="loading && !loaded" size="small" />
    <p v-if="truncated" class="background-log-note">
      {{ t('artifact.logTruncated') }}
    </p>
    <NScrollbar
      ref="scrollbar"
      class="background-log-scroll"
      x-scrollable
      @scroll="onScroll"
    >
      <pre class="background-log-text">{{
        content || (loaded ? t('artifact.terminalLogEmpty') : '')
      }}</pre>
    </NScrollbar>
  </section>
</template>

<style scoped>
.background-terminal-tail {
  min-width: 0;
}
.background-log-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.background-log-toolbar > span,
.background-log-note {
  color: var(--text-muted);
  font-size: 12px;
}
.background-log-scroll {
  max-height: 320px;
}
.background-log-text {
  margin: 0;
  padding: 8px;
  font: 12px/1.6 var(--font-mono, monospace);
  white-space: pre;
}
</style>
