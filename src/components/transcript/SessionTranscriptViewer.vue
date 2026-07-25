<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCheckbox,
  NCheckboxGroup,
  NCollapse,
  NCollapseItem,
  NModal,
  NSpin,
  NTag,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { SessionTranscriptCategory } from '../../../shared/session-transcript'
import { useTraceStore, type TranscriptEntryView } from '../../stores/traces'
import ConfirmDialog from '../dialogs/ConfirmDialog.vue'

const traces = useTraceStore()
const { t } = useI18n()
const categories: SessionTranscriptCategory[] = [
  'user',
  'assistant',
  'reasoning',
  'internal',
  'tool',
  'approval',
  'provider',
  'runtime',
  'terminal',
]
const selectedCategories = ref<SessionTranscriptCategory[]>([...categories])
const exportDialogOpen = ref(false)
const exportPending = ref(false)
const collapsedKinds = new Set([
  'tool',
  'provider_request',
  'provider_response',
  'terminal',
  'usage',
  'runtime',
  'run',
  'session',
])

const filteredEntries = computed(() => {
  const selected = new Set(selectedCategories.value)
  return traces.transcriptEntries.filter((entry) =>
    entry.categories.some((category) =>
      selected.has(category as SessionTranscriptCategory),
    ),
  )
})

const groups = computed(() => {
  const byKey = new Map<
    string,
    { key: string; label: string; entries: TranscriptEntryView[] }
  >()
  for (const entry of filteredEntries.value) {
    const key = entry.runId ?? 'session'
    const group = byKey.get(key) ?? {
      key,
      label: entry.runId
        ? `${t('transcript.run')} ${entry.runId}`
        : t('transcript.session'),
      entries: [],
    }
    group.entries.push(entry)
    byKey.set(key, group)
  }
  return [...byKey.values()]
})

function close() {
  traces.closeTranscript()
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function request(entry: TranscriptEntryView) {
  return entry.requestEventId
    ? traces.transcriptRequests[entry.requestEventId]
    : undefined
}

function loadRequest(entry: TranscriptEntryView) {
  if (entry.requestEventId) {
    void traces.loadTranscriptRequest(entry.requestEventId)
  }
}

function defaultExpandedEntryNames(entries: TranscriptEntryView[]): string[] {
  return entries
    .filter((entry) => !collapsedKinds.has(entry.kind))
    .map((entry) => entry.id)
}

async function confirmExport() {
  if (exportPending.value) return
  exportPending.value = true
  try {
    await traces.exportTranscript(true)
    exportDialogOpen.value = false
  } finally {
    exportPending.value = false
  }
}
</script>

<template>
  <NModal
    :show="traces.transcriptOpen"
    preset="card"
    class="transcript-modal"
    style="width: min(1180px, 94vw); height: min(860px, 92vh)"
    content-style="overflow: auto"
    :title="t('transcript.title')"
    :bordered="false"
    @update:show="!$event && close()"
  >
    <template #header-extra>
      <div class="transcript-actions">
        <NButton
          secondary
          size="small"
          :disabled="!traces.transcriptTraceId"
          @click="traces.loadTranscript(true)"
        >
          {{ t('transcript.refresh') }}
        </NButton>
        <NButton
          type="primary"
          size="small"
          :disabled="!traces.transcriptTraceId"
          @click="exportDialogOpen = true"
        >
          {{ t('transcript.export') }}
        </NButton>
      </div>
    </template>

    <NAlert v-if="traces.transcriptUnavailable" type="warning">
      {{ t('transcript.unavailable') }}
    </NAlert>
    <NAlert v-if="traces.transcriptError" type="error">
      {{ traces.transcriptError }}
    </NAlert>

    <template v-if="traces.transcriptMetadata">
      <div class="transcript-meta">
        <NTag>{{ traces.transcriptMetadata.traceId }}</NTag>
        <NTag :type="traces.transcriptMetadata.active ? 'warning' : 'success'">
          {{
            traces.transcriptMetadata.active
              ? t('transcript.active')
              : t('transcript.closed')
          }}
        </NTag>
        <span>{{ traces.transcriptMetadata.model }}</span>
        <span>{{ traces.transcriptMetadata.mode }}</span>
        <span>#{{ traces.transcriptMetadata.lastSeq }}</span>
      </div>

      <NCheckboxGroup
        v-model:value="selectedCategories"
        class="transcript-filters"
      >
        <NCheckbox
          v-for="category in categories"
          :key="category"
          :value="category"
          :label="t(`transcript.categories.${category}`)"
        />
      </NCheckboxGroup>

      <NSpin :show="traces.transcriptLoading">
        <div class="transcript-groups">
          <section v-for="group in groups" :key="group.key">
            <h3>{{ group.label }}</h3>
            <NCollapse
              :default-expanded-names="defaultExpandedEntryNames(group.entries)"
            >
              <NCollapseItem
                v-for="entry in group.entries"
                :key="entry.id"
                :name="entry.id"
                class="transcript-entry"
                :data-kind="entry.kind"
              >
                <template #header>
                  <div class="transcript-entry-header">
                    <span>#{{ entry.seq }}</span>
                    <time :datetime="entry.ts">{{ entry.ts }}</time>
                    <strong>{{ entry.title }}</strong>
                    <NTag
                      v-for="category in entry.categories"
                      :key="category"
                      size="small"
                    >
                      {{ category }}
                    </NTag>
                  </div>
                </template>
                <div class="transcript-entry-body">
                  <pre v-if="entry.text">{{ entry.text }}</pre>
                  <pre v-if="entry.data">{{ json(entry.data) }}</pre>
                  <div v-if="entry.requestEventId" class="request-snapshot">
                    <NButton
                      v-if="!request(entry)"
                      secondary
                      size="small"
                      @click="loadRequest(entry)"
                    >
                      {{ t('transcript.loadRequest') }}
                    </NButton>
                    <template v-else>
                      <pre>{{ json(request(entry)?.messages) }}</pre>
                      <NButton
                        v-if="request(entry)?.nextCursor"
                        secondary
                        size="small"
                        :loading="request(entry)?.loading"
                        @click="loadRequest(entry)"
                      >
                        {{ t('transcript.loadMoreMessages') }}
                      </NButton>
                    </template>
                  </div>
                </div>
              </NCollapseItem>
            </NCollapse>
          </section>
        </div>
      </NSpin>

      <NButton
        v-if="traces.transcriptNextCursor"
        block
        secondary
        :loading="traces.transcriptLoading"
        @click="traces.loadTranscript(false)"
      >
        {{ t('transcript.loadMore') }}
        ({{ traces.transcriptEntries.length }}/{{ traces.transcriptTotal }})
      </NButton>
    </template>
  </NModal>
  <ConfirmDialog
    v-model:show="exportDialogOpen"
    :title="t('transcript.exportWarningTitle')"
    :positive-text="t('transcript.confirmExport')"
    :negative-text="t('common.cancel')"
    :loading="exportPending"
    type="warning"
    @positive="confirmExport"
  >
    {{ t('transcript.exportWarningText') }}
  </ConfirmDialog>
</template>

<style scoped>
.transcript-actions,
.transcript-meta,
.transcript-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.transcript-meta,
.transcript-filters {
  margin-bottom: 14px;
}

.transcript-groups {
  display: grid;
  gap: 18px;
}

.transcript-groups h3 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.transcript-entry {
  margin-bottom: 7px;
  padding: 0 11px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--background);
}

.transcript-entry-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.transcript-entry-header time,
.transcript-entry-header > span:first-child {
  color: var(--text-secondary);
  font-size: 12px;
}

.transcript-entry-body {
  padding-bottom: 11px;
}

.transcript-entry pre {
  max-width: 100%;
  max-height: 420px;
  margin: 8px 0 0;
  padding: 10px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-radius: 6px;
  background: var(--surface);
  font:
    12px/1.55 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

.request-snapshot {
  margin-top: 10px;
}
</style>
