<script setup lang="ts">
import { onMounted } from 'vue'
import { NAlert, NButton, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import { useAgentStore } from '../../stores/agent'
import { useTraceStore } from '../../stores/traces'

const agent = useAgentStore()
const traces = useTraceStore()
onMounted(() => void traces.load())

function providerMetric(value: number | null | undefined, suffix = '') {
  return value === null || value === undefined
    ? 'Provider not provided'
    : Math.round(value).toLocaleString() + suffix
}

function clearClosedTraces() {
  if (
    window.confirm(
      'Delete every closed trace? Active session traces will be preserved.',
    )
  ) {
    void traces.clearClosed()
  }
}
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>Logging</h2>
      <p>
        Capture final requests, responses, tools, approvals, usage and timing.
        Streaming chunks are not written.
      </p>
    </div>
    <div class="settings-switch-row">
      <div>
        <strong>Full trace logging</strong>
        <p>May contain prompts, code, tool arguments and outputs.</p>
      </div>
      <NSwitch v-model:value="agent.loggingForm.enabled" />
    </div>
    <label class="settings-field">
      <span>Retention days</span>
      <NInputNumber
        v-model:value="agent.loggingForm.retentionDays"
        :min="1"
        :max="3650"
      />
    </label>
    <label class="settings-field">
      <span>Maximum total size (MB)</span>
      <NInputNumber
        v-model:value="agent.loggingForm.maxTotalMegabytes"
        :min="1"
        :max="10000"
      />
    </label>
    <NButton type="primary" @click="agent.saveLogging">
      Save logging settings
    </NButton>
    <div class="settings-actions">
      <NButton secondary @click="traces.openDirectory">
        Open log directory
      </NButton>
      <NButton secondary :loading="traces.loading" @click="traces.load">
        Refresh traces
      </NButton>
      <NButton secondary type="error" @click="clearClosedTraces">
        Clear closed traces
      </NButton>
    </div>

    <div v-if="traces.providerStats" class="trace-stats">
      <article>
        <span>Requests</span>
        <strong>{{ traces.providerStats.requestCount }}</strong>
      </article>
      <article>
        <span>Total tokens</span>
        <strong>{{ providerMetric(traces.providerStats.totalTokens) }}</strong>
      </article>
      <article>
        <span>Cache hit tokens</span>
        <strong>{{
          providerMetric(traces.providerStats.cacheHitTokens)
        }}</strong>
      </article>
      <article>
        <span>Cache miss tokens</span>
        <strong>{{
          providerMetric(traces.providerStats.cacheMissTokens)
        }}</strong>
      </article>
      <article>
        <span>Average TTFT</span>
        <strong>{{
          providerMetric(traces.providerStats.averageTtftMs, ' ms')
        }}</strong>
      </article>
      <article>
        <span>Average latency</span>
        <strong>{{
          providerMetric(traces.providerStats.averageTotalMs, ' ms')
        }}</strong>
      </article>
    </div>

    <div class="trace-debug">
      <h3>Offline replay and fork</h3>
      <NSelect
        v-model:value="traces.selectedId"
        :options="traces.options"
        clearable
        placeholder="Select a trace"
      />
      <div class="settings-actions">
        <NButton
          secondary
          :disabled="!traces.selectedId"
          @click="traces.replaySelected"
        >
          Replay offline
        </NButton>
      </div>
      <label class="settings-field">
        <span>Fork from llm.request event ID</span>
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
        Fork with current provider
      </NButton>
      <p v-if="traces.replay" class="settings-footnote">
        {{ traces.replay.messages.length }} messages ·
        {{ traces.replay.toolCount }} tools ·
        {{ traces.replay.approvalCount }} approvals ·
        {{ traces.replay.closed ? 'closed' : 'active' }}
      </p>
      <NAlert v-if="traces.actionMessage" type="info">
        {{ traces.actionMessage }}
      </NAlert>
      <NAlert v-if="traces.error" type="error">{{ traces.error }}</NAlert>
    </div>
  </section>
</template>
