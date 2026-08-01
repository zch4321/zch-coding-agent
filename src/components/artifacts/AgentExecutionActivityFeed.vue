<script setup lang="ts">
import { computed } from 'vue'
import { NCollapse, NCollapseItem } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type {
  AgentExecutionActivity,
  AgentExecutionSummary,
} from '../../../shared/agent-execution'
import type { ToolActivity } from '../../stores/agent-types'
import MarkdownBlock from '../MarkdownBlock.vue'
import ToolCallCard from '../chat/ToolCallCard.vue'

const props = defineProps<{
  summary: AgentExecutionSummary
  activities: AgentExecutionActivity[]
}>()
const { t } = useI18n()

const displayActivities = computed(() =>
  props.activities.map((activity) => ({
    activity,
    tool:
      activity.type === 'tool'
        ? ({
            callId: activity.callId,
            runId: props.summary.parentRunId,
            tool: activity.tool,
            args: activity.args,
            reason: activity.reason,
            status: activity.status,
            ...(activity.result === undefined
              ? {}
              : { result: activity.result }),
          } satisfies ToolActivity)
        : undefined,
  })),
)
</script>

<template>
  <div class="agent-execution-activity-list">
    <template
      v-for="item in displayActivities"
      :key="item.activity.type + ':' + item.activity.id"
    >
      <NCollapse
        v-if="item.activity.type === 'reasoning'"
        class="agent-execution-reasoning"
        arrow-placement="right"
      >
        <NCollapseItem :name="item.activity.id">
          <template #header>{{ t('artifact.agentReasoning') }}</template>
          <pre>{{ item.activity.text }}</pre>
        </NCollapseItem>
      </NCollapse>
      <ToolCallCard
        v-else-if="item.activity.type === 'tool' && item.tool"
        :tool="item.tool"
        compact
      />
      <article
        v-else-if="item.activity.type === 'message'"
        class="agent-execution-message"
      >
        <MarkdownBlock :content="item.activity.text" />
      </article>
    </template>
  </div>
</template>
