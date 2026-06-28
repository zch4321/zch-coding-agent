<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useAgentStore } from '../../stores/agent'

const agent = useAgentStore()
const { t } = useI18n()
</script>

<template>
  <section v-if="agent.goal" class="orchestration-panel">
    <article class="orchestration-card">
      <div class="orchestration-card-header">
        <span>{{ t('chat.goal') }}</span>
        <strong>{{ agent.goal.status }}</strong>
      </div>
      <p>{{ agent.goal.objective }}</p>
      <small v-if="agent.goal.summary">{{ agent.goal.summary }}</small>
      <small v-else-if="agent.goal.blockReason">
        {{ agent.goal.blockReason }}
      </small>
    </article>
  </section>
</template>
