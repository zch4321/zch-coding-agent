<script setup lang="ts">
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { PlanItem } from '../../../shared/orchestration'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

const agent = useAgentStore()
const { t } = useI18n()

const planProgress = computed(() => {
  const items = agent.plan?.items ?? []
  const completed = items.filter((item) => item.status === 'completed').length
  return { completed, total: items.length }
})
const planWorkflowStatus = computed(() => agent.plan?.status ?? 'active')
const canReviewPlan = computed(
  () =>
    planWorkflowStatus.value === 'awaiting_review' &&
    Boolean(agent.sessionId) &&
    !agent.activeRunId &&
    !agent.pendingApproval,
)

function planStatusClass(item: PlanItem): string {
  return `status-${item.status.replace(/_/g, '-')}`
}

function planWorkflowStatusClass(): string {
  return `state-${planWorkflowStatus.value.replace(/_/g, '-')}`
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString()
}
</script>

<template>
  <section class="artifact-content plan-view">
    <template v-if="agent.plan">
      <header class="plan-panel-header">
        <div>
          <div class="plan-title-row">
            <span>{{ t('artifact.plan') }}</span>
            <span class="plan-state-badge" :class="planWorkflowStatusClass()">
              {{ t(`artifact.planState.${planWorkflowStatus}`) }}
            </span>
          </div>
          <strong>{{ agent.plan.objective }}</strong>
        </div>
        <small>
          {{
            t('artifact.planProgress', {
              completed: planProgress.completed,
              total: planProgress.total,
            })
          }}
        </small>
      </header>
      <div
        v-if="planWorkflowStatus === 'awaiting_review'"
        class="plan-review-actions"
      >
        <NButton
          type="primary"
          size="small"
          :disabled="!canReviewPlan"
          @click="agent.approvePlan"
        >
          {{ t('artifact.approvePlan') }}
        </NButton>
        <NButton
          secondary
          size="small"
          :disabled="!canReviewPlan"
          @click="agent.rejectPlan"
        >
          {{ t('artifact.rejectPlan') }}
        </NButton>
        <small>{{ t('artifact.planReviewHint') }}</small>
      </div>
      <p v-if="agent.plan.warning" class="plan-warning">
        <UiIcon name="warning" />{{ agent.plan.warning }}
      </p>
      <ol v-if="agent.plan.items.length" class="artifact-plan-list">
        <li
          v-for="item in agent.plan.items"
          :key="item.id"
          :class="planStatusClass(item)"
        >
          <div class="plan-item-main">
            <span class="plan-status-dot" aria-hidden="true"></span>
            <div>
              <strong>{{ item.title }}</strong>
              <small>
                {{ t(`artifact.planStatus.${item.status}`) }} ·
                {{ formatTimestamp(item.updatedAt) }}
              </small>
            </div>
          </div>
          <p v-if="item.result">{{ item.result }}</p>
          <p v-if="item.evidence" class="plan-evidence">
            {{ item.evidence }}
          </p>
        </li>
      </ol>
      <p v-else class="artifact-message">{{ t('artifact.planNoItems') }}</p>
      <footer class="plan-panel-footer">
        <span>
          {{
            t('artifact.planContinuations', {
              count: agent.plan.continuationCount,
            })
          }}
        </span>
        <span>{{ formatTimestamp(agent.plan.updatedAt) }}</span>
      </footer>
    </template>
    <div v-else class="artifact-empty">
      <UiIcon name="check" />
      <h2>{{ t('artifact.noPlan') }}</h2>
      <p>{{ t('artifact.noPlanHint') }}</p>
    </div>
  </section>
</template>
