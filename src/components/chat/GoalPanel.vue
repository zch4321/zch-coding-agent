<script setup lang="ts">
import { NCard, NTag, type TagProps } from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'

const agent = useAgentStore()
const { t } = useI18n()

const goalStatusType = computed<TagProps['type']>(() => {
  if (agent.goal?.status === 'completed') return 'success'
  if (agent.goal?.status === 'blocked') return 'error'
  if (agent.goal?.status === 'paused') return 'warning'
  return 'info'
})
</script>

<template>
  <section v-if="agent.goal" class="orchestration-panel">
    <NCard class="orchestration-card" size="small">
      <template #header>{{ t('chat.goal') }}</template>
      <template #header-extra>
        <NTag round size="small" :type="goalStatusType">
          {{ agent.goal.status }}
        </NTag>
      </template>
      <p>{{ agent.goal.objective }}</p>
      <small v-if="agent.goal.summary">{{ agent.goal.summary }}</small>
      <small v-else-if="agent.goal.blockReason">
        {{ agent.goal.blockReason }}
      </small>
    </NCard>
  </section>
</template>
