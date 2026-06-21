<script setup lang="ts">
import { onMounted } from 'vue'
import { NAlert, NButton, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'
import { useTraceStore } from '../../stores/traces'

const agent = useAgentStore()
const traces = useTraceStore()
const { t } = useI18n()
onMounted(() => void traces.load())

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
        {{ traces.replay.closed ? t('logging.closed') : t('logging.active') }}
      </p>
      <NAlert v-if="traces.actionMessage" type="info">
        {{ traces.actionMessage }}
      </NAlert>
      <NAlert v-if="traces.error" type="error">{{ traces.error }}</NAlert>
    </div>
  </section>
</template>
