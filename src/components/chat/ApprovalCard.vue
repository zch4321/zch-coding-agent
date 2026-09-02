<script setup lang="ts">
import {
  NAlert,
  NButton,
  NDescriptions,
  NDescriptionsItem,
  NList,
  NListItem,
  NScrollbar,
  NTag,
  NThing,
} from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ModelCapabilityLevel } from '../../../shared/config'
import type { AgentToolAccess } from '../../../shared/agent-execution'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

defineProps<{
  projectName: string
}>()

const agent = useAgentStore()
const { t } = useI18n()

interface SwarmApprovalTask {
  name: string
  task: string
  requiredCapability: ModelCapabilityLevel
  agentCount: number
  toolAccess: AgentToolAccess
}

interface SwarmApprovalArgs {
  sharedContext: string
  tasks: SwarmApprovalTask[]
}

const capabilities = new Set<ModelCapabilityLevel>([
  'light',
  'standard',
  'strong',
])
const toolAccessValues = new Set<AgentToolAccess>(['readonly', 'inherit'])
const capabilityLabels: Record<ModelCapabilityLevel, string> = {
  light: 'settings.capabilityLight',
  standard: 'settings.capabilityStandard',
  strong: 'settings.capabilityStrong',
}

function swarmArgsFromValue(value: unknown): SwarmApprovalArgs | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const sharedContext = Reflect.get(value, 'sharedContext')
  const tasks = Reflect.get(value, 'tasks')
  if (
    typeof sharedContext !== 'string' ||
    !sharedContext.trim() ||
    !Array.isArray(tasks) ||
    tasks.length === 0
  ) {
    return undefined
  }
  const parsed: SwarmApprovalTask[] = []
  for (const candidate of tasks) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      return undefined
    }
    const name = Reflect.get(candidate, 'name')
    const task = Reflect.get(candidate, 'task')
    const requiredCapability = Reflect.get(candidate, 'requiredCapability')
    const agentCount = Reflect.get(candidate, 'agentCount')
    const toolAccess = Reflect.get(candidate, 'toolAccess')
    if (
      typeof name !== 'string' ||
      typeof task !== 'string' ||
      !capabilities.has(requiredCapability as ModelCapabilityLevel) ||
      !Number.isSafeInteger(agentCount) ||
      agentCount < 1 ||
      !toolAccessValues.has(toolAccess as AgentToolAccess)
    ) {
      return undefined
    }
    parsed.push({
      name,
      task,
      requiredCapability: requiredCapability as ModelCapabilityLevel,
      agentCount,
      toolAccess: toolAccess as AgentToolAccess,
    })
  }
  return { sharedContext, tasks: parsed }
}

const isSwarmApproval = computed(
  () => agent.pendingApproval?.tool === 'swarm_run',
)
const swarmArgs = computed(() =>
  isSwarmApproval.value
    ? swarmArgsFromValue(agent.pendingApproval?.args)
    : undefined,
)
const swarmTasks = computed(() => swarmArgs.value?.tasks)
const swarmAgentCount = computed(
  () =>
    swarmTasks.value?.reduce((total, task) => total + task.agentCount, 0) ?? 0,
)

function swarmCapabilityLabel(capability: ModelCapabilityLevel): string {
  return t(capabilityLabels[capability])
}

function swarmToolAccessLabel(toolAccess: AgentToolAccess): string {
  return t(
    toolAccess === 'readonly'
      ? 'chat.swarmToolReadonly'
      : 'chat.swarmToolInherit',
  )
}
</script>

<template>
  <article v-if="agent.pendingApproval" class="approval-card">
    <header class="approval-header">
      <div>
        <span class="tool-kicker">{{ t('chat.approvalRequired') }}</span>
        <strong>
          {{
            isSwarmApproval
              ? t('chat.swarmApprovalTitle')
              : agent.pendingApproval.tool
          }}
        </strong>
      </div>
      <NTag round size="small" type="warning">
        {{
          isSwarmApproval
            ? t('chat.swarmApprovalTag')
            : agent.pendingApproval.kind
        }}
      </NTag>
    </header>
    <NScrollbar
      class="approval-card-body"
      content-class="approval-card-body-content"
    >
      <p class="approval-reason">{{ agent.pendingApproval.reason }}</p>
      <template v-if="isSwarmApproval">
        <NAlert
          class="swarm-approval-warning"
          type="warning"
          :title="t('chat.swarmApprovalNoticeTitle')"
        >
          {{ t('chat.swarmApprovalNotice') }}
        </NAlert>
        <NDescriptions
          class="approval-meta"
          label-placement="top"
          :column="2"
          size="small"
          bordered
        >
          <NDescriptionsItem :label="t('chat.workspaceScope')">
            {{ projectName }}
          </NDescriptionsItem>
          <NDescriptionsItem :label="t('chat.expires')">
            {{ agent.pendingApproval.expiresAt }}
          </NDescriptionsItem>
          <NDescriptionsItem :label="t('chat.swarmTaskCount')">
            {{ swarmTasks?.length ?? 0 }}
          </NDescriptionsItem>
          <NDescriptionsItem :label="t('chat.swarmTotalAgents')">
            {{ swarmAgentCount }}
          </NDescriptionsItem>
        </NDescriptions>
        <section
          v-if="swarmArgs"
          class="swarm-approval-shared-context"
          aria-labelledby="swarm-shared-context-title"
        >
          <strong id="swarm-shared-context-title">
            {{ t('chat.swarmSharedContext') }}
          </strong>
          <p>{{ swarmArgs.sharedContext }}</p>
        </section>
        <NList v-if="swarmArgs" class="swarm-approval-tasks" bordered>
          <NListItem
            v-for="(task, index) in swarmTasks"
            :key="`${index}:${task.name}`"
          >
            <NThing :title="task.name">
              <template #description>
                <div class="swarm-approval-task-meta">
                  <NTag size="small" :bordered="false">
                    {{ swarmCapabilityLabel(task.requiredCapability) }}
                  </NTag>
                  <NTag size="small" :bordered="false">
                    {{ t('chat.swarmAgents', { count: task.agentCount }) }}
                  </NTag>
                  <NTag size="small" :bordered="false">
                    {{ swarmToolAccessLabel(task.toolAccess) }}
                  </NTag>
                </div>
              </template>
              <p class="swarm-approval-task-text">{{ task.task }}</p>
            </NThing>
          </NListItem>
        </NList>
        <template v-else>
          <NAlert type="error" :title="t('chat.swarmInvalidArguments')" />
          <pre class="approval-args">{{
            JSON.stringify(agent.pendingApproval.args, null, 2)
          }}</pre>
        </template>
      </template>
      <template v-else>
        <NDescriptions
          class="approval-meta"
          label-placement="top"
          :column="2"
          size="small"
          bordered
        >
          <NDescriptionsItem :label="t('chat.workspaceScope')">
            {{ projectName }}
          </NDescriptionsItem>
          <NDescriptionsItem :label="t('chat.expires')">
            {{ agent.pendingApproval.expiresAt }}
          </NDescriptionsItem>
        </NDescriptions>
        <pre class="approval-args">{{
          JSON.stringify(agent.pendingApproval.args, null, 2)
        }}</pre>
      </template>
      <ul class="policy-signals">
        <li
          v-for="signal in agent.pendingApproval.signals"
          :key="signal.code + signal.detail"
        >
          <UiIcon name="warning" />{{ signal.detail }}
        </li>
      </ul>
      <div
        v-if="agent.pendingApproval.rememberArgConstraints"
        class="approval-remember-preview"
      >
        <strong>{{ t('chat.rememberedScope') }}</strong>
        <pre>{{
          JSON.stringify(agent.pendingApproval.rememberArgConstraints, null, 2)
        }}</pre>
      </div>
    </NScrollbar>
    <div class="approval-actions">
      <NButton
        type="primary"
        :loading="agent.approvalSubmitting"
        :disabled="agent.approvalSubmitting"
        @click="
          agent.decideApproval({
            decision: 'allow',
          })
        "
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
        @click="
          agent.decideApproval({
            decision: 'allow',
            remember: true,
          })
        "
      >
        {{ t('chat.approveRemember') }}
      </NButton>
      <NButton
        secondary
        :disabled="agent.approvalSubmitting"
        @click="
          agent.decideApproval({
            decision: 'deny',
          })
        "
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
