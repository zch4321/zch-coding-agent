<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NList,
  NListItem,
  NSpace,
  NSpin,
  NTag,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { IPC_VERSION } from '../../../shared/channels'
import type { SessionListCursor, SessionRecord } from '../../../shared/session'
import { useAgentReplicaStore } from '../../stores/agent-replica'
import { useNotificationStore } from '../../stores/notifications'
import ConfirmDialog from '../dialogs/ConfirmDialog.vue'

type ArchivedSession = Extract<SessionRecord, { lifecycle: 'archived' }>

const { locale, t } = useI18n()
const replica = useAgentReplicaStore()
const notifications = useNotificationStore()
const records = ref<ArchivedSession[]>([])
const loading = ref(false)
const hasMore = ref(false)
const nextBefore = ref<SessionListCursor>()
const pendingSessionId = ref<string>()
const deleteTarget = ref<ArchivedSession>()
const deletePending = ref(false)
const projectNames = computed(
  () => new Map(replica.projects.map((project) => [project.id, project.name])),
)

function archivedOnly(items: readonly SessionRecord[]): ArchivedSession[] {
  return items.filter(
    (item): item is ArchivedSession => item.lifecycle === 'archived',
  )
}

function mergeArchived(items: readonly ArchivedSession[]): void {
  const byId = new Map(records.value.map((record) => [record.id, record]))
  for (const item of items) byId.set(item.id, structuredClone(item))
  records.value = [...byId.values()].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.id.localeCompare(left.id),
  )
}

function formatArchivedAt(value: string): string {
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

async function loadArchived(reset = false): Promise<void> {
  const api = window.agentApi
  if (!api || loading.value) return
  loading.value = true
  try {
    const before = reset ? undefined : nextBefore.value
    const result = await api.listSessions({
      version: IPC_VERSION,
      lifecycle: 'archived',
      ...(before
        ? {
            before: {
              updatedAt: before.updatedAt,
              sessionId: before.sessionId,
            },
          }
        : {}),
      limit: 100,
    })
    if (!result.ok) {
      notifications.error({
        code: result.error.code,
        message: result.error.message,
      })
      return
    }
    if (reset) records.value = []
    mergeArchived(archivedOnly(result.value.page.records))
    hasMore.value = result.value.page.hasMore
    nextBefore.value = result.value.page.hasMore
      ? structuredClone(result.value.page.nextBefore)
      : undefined
  } finally {
    loading.value = false
  }
}

async function restoreSession(session: ArchivedSession): Promise<void> {
  const api = window.agentApi
  if (!api || pendingSessionId.value) return
  pendingSessionId.value = session.id
  try {
    const result = await api.restoreSession({
      version: IPC_VERSION,
      sessionId: session.id,
      expectedRevision: session.revision,
    })
    if (!result.ok) {
      notifications.error({
        code: result.error.code,
        message: result.error.message,
        sessionId: session.id,
      })
      await loadArchived(true)
      return
    }
    await replica.reconcile(result.value.commit)
    records.value = records.value.filter((record) => record.id !== session.id)
  } finally {
    pendingSessionId.value = undefined
  }
}

function requestDelete(session: ArchivedSession): void {
  if (pendingSessionId.value) return
  deleteTarget.value = session
}

function updateDeleteDialog(show: boolean): void {
  if (!show && !deletePending.value) deleteTarget.value = undefined
}

async function deleteArchivedSession(): Promise<void> {
  const api = window.agentApi
  const session = deleteTarget.value
  if (!api || !session || deletePending.value) return
  deletePending.value = true
  pendingSessionId.value = session.id
  try {
    const result = await api.deleteSession({
      version: IPC_VERSION,
      sessionId: session.id,
      expectedRevision: session.revision,
    })
    if (!result.ok) {
      notifications.error({
        code: result.error.code,
        message: result.error.message,
        sessionId: session.id,
      })
      await loadArchived(true)
      return
    }
    await replica.reconcile(result.value.commit)
    records.value = records.value.filter((record) => record.id !== session.id)
    deleteTarget.value = undefined
  } finally {
    deletePending.value = false
    pendingSessionId.value = undefined
  }
}

onMounted(() => void loadArchived(true))
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('settings.archivedTitle') }}</h2>
      <p>{{ t('settings.archivedHint') }}</p>
    </div>

    <NAlert type="info" :show-icon="true">
      {{ t('settings.archivedSafety') }}
    </NAlert>

    <NSpin :show="loading && records.length === 0">
      <NList v-if="records.length > 0" bordered class="archived-session-list">
        <NListItem v-for="session in records" :key="session.id">
          <div class="archived-session-row">
            <div class="archived-session-details">
              <strong :title="session.title">{{ session.title }}</strong>
              <NSpace size="small" align="center" wrap>
                <NTag size="small" :bordered="false">
                  {{
                    projectNames.get(session.projectId) ||
                    t('settings.archivedUnknownProject')
                  }}
                </NTag>
                <span>
                  {{
                    t('settings.archivedAt', {
                      time: formatArchivedAt(session.archivedAt),
                    })
                  }}
                </span>
              </NSpace>
            </div>
            <NSpace class="archived-session-actions" size="small" wrap>
              <NButton
                size="small"
                secondary
                type="primary"
                :loading="pendingSessionId === session.id && !deletePending"
                :disabled="Boolean(pendingSessionId)"
                @click="restoreSession(session)"
              >
                {{ t('settings.restoreArchived') }}
              </NButton>
              <NButton
                size="small"
                secondary
                type="error"
                :disabled="Boolean(pendingSessionId)"
                @click="requestDelete(session)"
              >
                {{ t('settings.deleteArchived') }}
              </NButton>
            </NSpace>
          </div>
        </NListItem>
      </NList>
      <NEmpty v-else :description="t('settings.archivedEmpty')" />
    </NSpin>

    <div v-if="hasMore" class="settings-actions">
      <NButton :loading="loading" secondary @click="loadArchived()">
        {{ t('settings.loadMoreArchived') }}
      </NButton>
    </div>

    <ConfirmDialog
      :show="Boolean(deleteTarget)"
      :title="t('settings.deleteArchivedTitle')"
      :positive-text="t('settings.deleteArchived')"
      :negative-text="t('common.cancel')"
      :loading="deletePending"
      type="error"
      positive-type="error"
      @update:show="updateDeleteDialog"
      @positive="deleteArchivedSession"
    >
      {{
        t('settings.deleteArchivedConfirm', {
          title: deleteTarget?.title ?? '',
        })
      }}
    </ConfirmDialog>
  </section>
</template>
