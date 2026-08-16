<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch, type WatchStopHandle } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentChangesStore } from '../../stores/agent-changes'
import { useModelRolesStore } from '../../stores/model-roles'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useAgentSettingsStore } from '../../stores/agent-settings'
import { useAgentShellStore } from '../../stores/agent-shell'
import { useMcpStore } from '../../stores/mcp'
import { useModelPoolSettingsStore } from '../../stores/model-pool-settings'
import {
  useNotificationStore,
  type UiNotification,
} from '../../stores/notifications'
import { useSkillsStore } from '../../stores/skills'
import { useTraceStore } from '../../stores/traces'

const MAX_ACTIVE_MESSAGES = 5
const WARNING_DURATION_MS = 10_000

const message = useMessage()
const { t } = useI18n()
const notifications = useNotificationStore()
const shell = useAgentShellStore()
const settings = useAgentSettingsStore()
const modelRoles = useModelRolesStore()
const replica = useAgentReplicaStore()
const changes = useAgentChangesStore()
const mcp = useMcpStore()
const modelPool = useModelPoolSettingsStore()
const skills = useSkillsStore()
const traces = useTraceStore()
const errorWatchers: WatchStopHandle[] = []
let activeCount = 0

function sessionTitle(notification: UiNotification): string | undefined {
  if (!notification.sessionId) return undefined
  return replica.sessions.find(
    (session) => session.id === notification.sessionId,
  )?.title
}

function content(notification: UiNotification): string {
  const title = sessionTitle(notification)
  return title
    ? t('notifications.sessionMessage', {
        title,
        message: notification.message,
      })
    : notification.message
}

function drain(): void {
  while (
    activeCount < MAX_ACTIVE_MESSAGES &&
    notifications.pending.length > 0
  ) {
    const notification = notifications.take()
    if (!notification) return
    activeCount += 1
    const onAfterLeave = () => {
      activeCount = Math.max(0, activeCount - 1)
      notifications.release(notification.dedupeKey)
      queueMicrotask(drain)
    }
    message[notification.severity](content(notification), {
      closable: true,
      duration: notification.severity === 'warning' ? WARNING_DURATION_MS : 0,
      keepAliveOnHover: true,
      onAfterLeave,
    })
  }
}

function forwardStoreError(
  code: string,
  read: () => string,
  clear: () => void,
): void {
  errorWatchers.push(
    watch(
      read,
      (error) => {
        if (!error) return
        notifications.error({ code, message: error })
        clear()
      },
      { flush: 'sync' },
    ),
  )
}

watch(() => notifications.pending.length, drain, { flush: 'post' })
watch(
  () => [shell.initialized, shell.bridgeAvailable] as const,
  ([initialized, bridgeAvailable]) => {
    if (initialized && !bridgeAvailable) {
      notifications.warning({
        code: 'BRIDGE_UNAVAILABLE',
        message: t('chat.bridgeHint'),
      })
    }
  },
  { flush: 'post' },
)

forwardStoreError(
  'SETTINGS_OPERATION_FAILED',
  () => settings.error,
  () => {
    settings.error = ''
  },
)
forwardStoreError(
  'APPROVAL_SETTINGS_OPERATION_FAILED',
  () => modelRoles.error,
  () => {
    modelRoles.error = ''
  },
)
forwardStoreError(
  'MODEL_POOL_SETTINGS_OPERATION_FAILED',
  () => modelPool.error,
  () => {
    modelPool.error = ''
  },
)
forwardStoreError(
  'REPLICA_OPERATION_FAILED',
  () => replica.error,
  () => {
    replica.error = ''
  },
)
forwardStoreError(
  'FILE_CHANGE_OPERATION_FAILED',
  () => changes.error,
  () => {
    changes.error = ''
  },
)
forwardStoreError(
  'MCP_OPERATION_FAILED',
  () => mcp.error,
  () => {
    mcp.error = ''
  },
)
forwardStoreError(
  'SKILL_OPERATION_FAILED',
  () => skills.error,
  () => {
    skills.error = ''
  },
)
forwardStoreError(
  'TRACE_OPERATION_FAILED',
  () => traces.error,
  () => {
    traces.error = ''
  },
)
forwardStoreError(
  'TRANSCRIPT_OPERATION_FAILED',
  () => traces.transcriptError,
  () => {
    traces.transcriptError = ''
  },
)

onMounted(drain)
onBeforeUnmount(() => {
  for (const stop of errorWatchers.splice(0)) stop()
})
</script>

<template>
  <span hidden aria-hidden="true"></span>
</template>
