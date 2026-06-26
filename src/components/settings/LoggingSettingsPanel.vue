<script setup lang="ts">
import { computed, onMounted } from 'vue'
import {
  NAlert,
  NButton,
  NCollapse,
  NCollapseItem,
  NInputNumber,
  NSelect,
  NSwitch,
  NTag,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'
import { useTraceStore } from '../../stores/traces'

const agent = useAgentStore()
const traces = useTraceStore()
const { t } = useI18n()
onMounted(() => void traces.load())
const promptRequest = computed(() => traces.selectedPromptRequest)
const promptLayers = computed(
  () => promptRequest.value?.promptBuild?.layers ?? [],
)
const promptMessages = computed(() => promptRequest.value?.messages ?? [])
const replayInterjections = computed(() =>
  (traces.replay?.interjections ?? []).slice(-20),
)

function providerMetric(value: number | null | undefined, suffix = '') {
  return value === null || value === undefined
    ? t('logging.unavailable')
    : Math.round(value).toLocaleString() + suffix
}

function clearClosedTraces() {
  if (window.confirm(t('logging.clearConfirm'))) {
    void traces.clearClosed()
  }
}

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function promptMessageTitle(message: unknown, index: number) {
  const role =
    message && typeof message === 'object' && !Array.isArray(message)
      ? Reflect.get(message, 'role')
      : undefined
  return `#${index} · ${typeof role === 'string' ? role : 'message'}`
}

function interjectionTitle(interjection: {
  interjectionId: string
  status: string
  history: unknown[]
}) {
  return `${interjection.status} · ${interjection.interjectionId} · ${interjection.history.length}`
}
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('logging.title') }}</h2>
      <p>{{ t('logging.hint') }}</p>
    </div>
    <div class="settings-switch-row">
      <div>
        <strong>{{ t('logging.full') }}</strong>
        <p>{{ t('logging.fullHint') }}</p>
      </div>
      <NSwitch v-model:value="agent.loggingForm.enabled" />
    </div>
    <label class="settings-field">
      <span>{{ t('logging.retention') }}</span>
      <NInputNumber
        v-model:value="agent.loggingForm.retentionDays"
        :min="1"
        :max="3650"
      />
    </label>
    <label class="settings-field">
      <span>{{ t('logging.maxSize') }}</span>
      <NInputNumber
        v-model:value="agent.loggingForm.maxTotalMegabytes"
        :min="1"
        :max="10000"
      />
    </label>
    <NButton type="primary" @click="agent.saveLogging">
      {{ t('logging.save') }}
    </NButton>
    <div class="settings-actions">
      <NButton secondary @click="traces.openDirectory">
        {{ t('logging.openDirectory') }}
      </NButton>
      <NButton secondary :loading="traces.loading" @click="traces.load">
        {{ t('logging.refresh') }}
      </NButton>
      <NButton secondary type="error" @click="clearClosedTraces">
        {{ t('logging.clear') }}
      </NButton>
    </div>

    <div v-if="traces.providerStats" class="trace-stats">
      <article>
        <span>{{ t('logging.requests') }}</span>
        <strong>{{ traces.providerStats.requestCount }}</strong>
      </article>
      <article>
        <span>{{ t('logging.totalTokens') }}</span>
        <strong>{{ providerMetric(traces.providerStats.totalTokens) }}</strong>
      </article>
      <article>
        <span>{{ t('logging.cacheHit') }}</span>
        <strong>{{
          providerMetric(traces.providerStats.cacheHitTokens)
        }}</strong>
      </article>
      <article>
        <span>{{ t('logging.cacheMiss') }}</span>
        <strong>{{
          providerMetric(traces.providerStats.cacheMissTokens)
        }}</strong>
      </article>
      <article>
        <span>{{ t('logging.averageTtft') }}</span>
        <strong>{{
          providerMetric(traces.providerStats.averageTtftMs, ' ms')
        }}</strong>
      </article>
      <article>
        <span>{{ t('logging.averageLatency') }}</span>
        <strong>{{
          providerMetric(traces.providerStats.averageTotalMs, ' ms')
        }}</strong>
      </article>
    </div>

    <div class="trace-debug">
      <h3>{{ t('logging.replayFork') }}</h3>
      <NSelect
        v-model:value="traces.selectedId"
        :options="traces.options"
        clearable
        :placeholder="t('logging.selectTrace')"
      />
      <div class="settings-actions">
        <NButton
          secondary
          :disabled="!traces.selectedId"
          @click="traces.replaySelected"
        >
          {{ t('logging.replay') }}
        </NButton>
      </div>
      <label class="settings-field">
        <span>{{ t('logging.forkEvent') }}</span>
        <NSelect
          v-model:value="traces.forkEventId"
          :options="traces.forkPointOptions"
          filterable
          tag
          placeholder="event-..."
        />
      </label>
      <NButton
        secondary
        :disabled="!traces.selectedId || !traces.forkEventId.trim()"
        @click="traces.forkSelected"
      >
        {{ t('logging.fork') }}
      </NButton>
      <p v-if="traces.replay" class="settings-footnote">
        {{ t('logging.messages', { count: traces.replay.messages.length }) }} ·
        {{ t('logging.tools', { count: traces.replay.toolCount }) }} ·
        {{ t('logging.approvals', { count: traces.replay.approvalCount }) }} ·
        {{
          t('logging.interjections', {
            count: traces.replay.interjections.length,
          })
        }}
        ·
        {{ traces.replay.closed ? t('logging.closed') : t('logging.active') }}
      </p>
      <NCollapse v-if="replayInterjections.length" class="trace-interjections">
        <NCollapseItem
          v-for="interjection in replayInterjections"
          :key="interjection.interjectionId"
          :title="interjectionTitle(interjection)"
        >
          <div class="trace-interjection-history">
            <article
              v-for="entry in interjection.history"
              :key="entry.seq + ':' + entry.status"
            >
              <NTag size="small">{{ entry.status }}</NTag>
              <span>#{{ entry.seq }}</span>
              <span>{{ entry.createdAt }}</span>
              <span v-if="entry.injectedAfterToolBatchId">
                {{ entry.injectedAfterToolBatchId }}
              </span>
              <pre>{{ entry.content }}</pre>
            </article>
          </div>
        </NCollapseItem>
      </NCollapse>
      <NAlert v-if="traces.actionMessage" type="info">
        {{ traces.actionMessage }}
      </NAlert>
      <NAlert v-if="traces.error" type="error">{{ traces.error }}</NAlert>
    </div>

    <div v-if="traces.replay" class="prompt-inspector">
      <h3>{{ t('logging.promptInspector') }}</h3>
      <label class="settings-field">
        <span>{{ t('logging.promptRequest') }}</span>
        <NSelect
          v-model:value="traces.promptRequestEventId"
          :options="traces.promptRequestOptions"
          filterable
          :placeholder="t('logging.promptRequestPlaceholder')"
        />
      </label>
      <div v-if="promptRequest?.promptBuild" class="prompt-build-summary">
        <article>
          <span>{{ t('logging.promptMessages') }}</span>
          <strong>{{ promptRequest.promptBuild.messageCount }}</strong>
        </article>
        <article>
          <span>{{ t('logging.promptLayers') }}</span>
          <strong>{{ promptRequest.promptBuild.ledgerMessageCount }}</strong>
        </article>
        <article>
          <span>{{ t('logging.promptEstimatedTokens') }}</span>
          <strong>{{
            promptRequest.promptBuild.estimatedTokens.toLocaleString()
          }}</strong>
        </article>
        <article>
          <span>{{ t('logging.promptOmitted') }}</span>
          <strong>{{
            promptRequest.promptBuild.omittedHistoryMessages
          }}</strong>
        </article>
      </div>
      <div v-if="promptLayers.length" class="prompt-layer-list">
        <article
          v-for="layer in promptLayers"
          :key="layer.seq"
          class="prompt-layer-row"
        >
          <NTag size="small" :type="layer.trusted ? 'success' : 'warning'">
            {{ layer.kind }}
          </NTag>
          <span>{{ layer.role }}</span>
          <span>{{ layer.source }}</span>
          <span>#{{ layer.messageIndex }}</span>
          <span>{{ layer.estimatedTokens.toLocaleString() }} tokens</span>
          <span>{{ layer.sha256.slice(0, 12) }}</span>
        </article>
      </div>
      <NCollapse v-if="promptMessages.length" accordion>
        <NCollapseItem
          v-for="(message, index) in promptMessages"
          :key="index"
          :title="promptMessageTitle(message, index)"
        >
          <pre class="prompt-message-json">{{ jsonText(message) }}</pre>
        </NCollapseItem>
      </NCollapse>
    </div>
  </section>
</template>
