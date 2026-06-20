<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NAlert, NButton, NCollapse, NCollapseItem } from 'naive-ui'
import type { ToolActivity } from '../../stores/agent'
import { useAgentStore } from '../../stores/agent'
import MarkdownBlock from '../MarkdownBlock.vue'
import UiIcon from '../UiIcon.vue'

defineProps<{ projectName: string }>()

const agent = useAgentStore()
const scrollElement = ref<HTMLElement>()
const followingOutput = ref(true)
const chronologicalTools = computed(() => [...agent.tools].reverse())

function okContent(tool: ToolActivity): unknown {
  const result = tool.result

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined
  }

  return 'status' in result && result.status === 'ok' && 'content' in result
    ? result.content
    : undefined
}

function toolResultSummary(tool: ToolActivity): string {
  const result = tool.result

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return tool.status === 'proposed' ? 'Proposed' : 'Completed'
  }

  if ('status' in result && result.status !== 'ok') {
    return String(result.status)
  }

  return 'Completed'
}

function handleScroll() {
  const element = scrollElement.value
  if (!element) return
  followingOutput.value =
    element.scrollHeight - element.scrollTop - element.clientHeight < 48
}

async function scrollToBottom(force = false) {
  if (!followingOutput.value && !force) return
  await nextTick()
  const element = scrollElement.value
  if (element) element.scrollTop = element.scrollHeight
  followingOutput.value = true
}

watch(
  () => [
    agent.messages.length,
    agent.messages.at(-1)?.text.length ?? 0,
    agent.messages.at(-1)?.reasoning.length ?? 0,
    agent.tools.length,
    agent.pendingApproval?.callId,
  ],
  () => void scrollToBottom(),
)
</script>

<template>
  <section class="conversation-timeline">
    <div
      ref="scrollElement"
      class="conversation-scroll"
      aria-label="Conversation messages"
      @scroll.passive="handleScroll"
    >
      <NAlert
        v-if="!agent.bridgeAvailable && agent.initialized"
        type="warning"
        title="Desktop bridge unavailable"
        class="inline-alert"
      >
        Open the Electron application to use workspace and Agent actions.
      </NAlert>
      <NAlert
        v-if="agent.bridgeAvailable && !agent.providerNoticeAccepted"
        type="info"
        title="Provider data notice"
        class="inline-alert"
      >
        Messages, selected code and bounded tool results may be sent to the
        configured Provider. Only the notice version and acceptance time are
        stored.
        <div class="notice-action">
          <NButton
            size="small"
            type="primary"
            @click="agent.acceptProviderNotice"
          >
            I understand
          </NButton>
        </div>
      </NAlert>
      <NAlert
        v-if="agent.agentEventGap"
        type="warning"
        title="Conversation event gap"
        class="inline-alert"
        closable
        @close="agent.agentEventGap = ''"
      >
        {{ agent.agentEventGap }}
      </NAlert>

      <article
        v-for="message in agent.messages"
        :key="message.id"
        class="chat-message"
        :class="message.role"
        :style="{ order: message.order ?? 0 }"
      >
        <div class="message-meta">
          <strong>{{ message.role === 'user' ? 'You' : 'Agent' }}</strong>
          <span
            v-if="
              message.role === 'assistant' &&
              message.runId === agent.activeRunId
            "
          >
            Streaming
          </span>
        </div>
        <MarkdownBlock :content="message.text || '...'" />
        <NCollapse v-if="message.reasoning" class="reasoning">
          <NCollapseItem title="Reasoning" name="reasoning">
            <pre>{{ message.reasoning }}</pre>
          </NCollapseItem>
        </NCollapse>
      </article>

      <article
        v-for="tool in chronologicalTools"
        :key="tool.callId"
        class="tool-call-card"
        :style="{ order: tool.order ?? 0 }"
      >
        <div class="tool-call-header">
          <div>
            <span class="tool-kicker">Tool call</span>
            <strong>{{ tool.tool }}</strong>
          </div>
          <span
            class="tool-status"
            :class="tool.status === 'completed' ? 'complete' : ''"
          >
            {{ toolResultSummary(tool) }}
          </span>
        </div>
        <p v-if="tool.reason" class="tool-reason">{{ tool.reason }}</p>
        <NCollapse>
          <NCollapseItem title="Arguments" :name="tool.callId + ':args'">
            <pre>{{ JSON.stringify(tool.args, null, 2) }}</pre>
          </NCollapseItem>
          <NCollapseItem
            v-if="okContent(tool)"
            title="Result"
            :name="tool.callId + ':result'"
          >
            <pre>{{ JSON.stringify(tool.result, null, 2) }}</pre>
          </NCollapseItem>
        </NCollapse>
      </article>

      <article
        v-if="agent.pendingApproval"
        class="approval-card"
        :style="{ order: agent.pendingApproval.order }"
      >
        <div class="approval-header">
          <div>
            <span class="tool-kicker">Approval required</span>
            <strong>{{ agent.pendingApproval.tool }}</strong>
          </div>
          <span>{{ agent.pendingApproval.kind }}</span>
        </div>
        <p>{{ agent.pendingApproval.reason }}</p>
        <dl class="approval-meta">
          <div>
            <dt>Workspace scope</dt>
            <dd>{{ projectName }}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{{ agent.pendingApproval.expiresAt }}</dd>
          </div>
        </dl>
        <pre class="approval-args">{{
          JSON.stringify(agent.pendingApproval.args, null, 2)
        }}</pre>
        <ul class="policy-signals">
          <li
            v-for="signal in agent.pendingApproval.signals"
            :key="signal.code + signal.detail"
          >
            <UiIcon name="warning" />{{ signal.detail }}
          </li>
        </ul>
        <pre v-if="agent.pendingApproval.diff" class="approval-diff">{{
          agent.pendingApproval.diff
        }}</pre>
        <div
          v-if="agent.pendingApproval.rememberArgConstraints"
          class="approval-remember-preview"
        >
          <strong>Remembered scope</strong>
          <pre>{{
            JSON.stringify(
              agent.pendingApproval.rememberArgConstraints,
              null,
              2,
            )
          }}</pre>
        </div>
        <div class="approval-actions">
          <NButton
            type="primary"
            :loading="agent.approvalSubmitting"
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('allow')"
          >
            {{
              agent.pendingApproval.kind === 'context'
                ? 'Allow context'
                : 'Approve'
            }}
          </NButton>
          <NButton
            v-if="agent.pendingApproval.rememberable"
            secondary
            type="primary"
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('allow', true)"
          >
            Approve & remember
          </NButton>
          <NButton
            secondary
            :disabled="agent.approvalSubmitting"
            @click="agent.decideApproval('deny')"
          >
            {{
              agent.pendingApproval.kind === 'context'
                ? 'Withhold context'
                : 'Deny'
            }}
          </NButton>
        </div>
      </article>

      <div
        v-if="
          agent.messages.length === 0 &&
          chronologicalTools.length === 0 &&
          !agent.pendingApproval
        "
        class="conversation-empty"
      >
        <span class="empty-icon"><UiIcon name="app" /></span>
        <template v-if="!agent.workspacePath">
          <h2>Open a workspace</h2>
          <p>Choose a project folder to start a local conversation.</p>
          <NButton type="primary" @click="agent.chooseWorkspace">
            Choose workspace
          </NButton>
        </template>
        <template v-else>
          <h2>What should we work on?</h2>
          <p>
            Ask the Agent to inspect code, explain behavior or prepare a
            reviewed change.
          </p>
        </template>
      </div>

      <button
        v-if="!followingOutput"
        class="back-to-bottom"
        type="button"
        @click="scrollToBottom(true)"
      >
        Back to bottom
      </button>
    </div>
    <NAlert
      v-if="agent.error"
      type="error"
      title="Request failed"
      class="conversation-error-overlay"
      closable
      @close="agent.error = ''"
    >
      {{ agent.error }}
    </NAlert>
  </section>
</template>
