<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

defineProps<{
  projectName: string
}>()

const agent = useAgentStore()
const { t } = useI18n()
</script>

<template>
  <article
    v-if="agent.pendingApproval"
    class="approval-card"
    :style="{ order: agent.pendingApproval.order }"
  >
    <div class="approval-header">
      <div>
        <span class="tool-kicker">{{ t('chat.approvalRequired') }}</span>
        <strong>{{ agent.pendingApproval.tool }}</strong>
      </div>
      <span>{{ agent.pendingApproval.kind }}</span>
    </div>
    <p>{{ agent.pendingApproval.reason }}</p>
    <dl class="approval-meta">
      <div>
        <dt>{{ t('chat.workspaceScope') }}</dt>
        <dd>{{ projectName }}</dd>
      </div>
      <div>
        <dt>{{ t('chat.expires') }}</dt>
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
      <strong>{{ t('chat.rememberedScope') }}</strong>
      <pre>{{
        JSON.stringify(agent.pendingApproval.rememberArgConstraints, null, 2)
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
            ? t('chat.allowContext')
            : t('common.approve')
        }}
      </NButton>
      <NButton
        v-if="agent.pendingApproval.rememberable"
        secondary
        type="primary"
        :disabled="agent.approvalSubmitting"
        @click="agent.decideApproval('allow', true)"
      >
        {{ t('chat.approveRemember') }}
      </NButton>
      <NButton
        secondary
        :disabled="agent.approvalSubmitting"
        @click="agent.decideApproval('deny')"
      >
        {{
          agent.pendingApproval.kind === 'context'
            ? t('chat.withholdContext')
            : t('common.deny')
        }}
      </NButton>
    </div>
  </article>
</template>
