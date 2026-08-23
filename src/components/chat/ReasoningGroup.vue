<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { NCollapse, NCollapseItem, NFlex, NScrollbar, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ProviderRetryState } from '../../../shared/agent-events'
import type { ReasoningSegment, RunActivity } from '../../stores/agent-types'

const props = defineProps<{
  segments: ReasoningSegment[]
  activity?: RunActivity
  providerRetry?: ProviderRetryState
}>()
const emit = defineEmits<{ 'content-resized': [] }>()
const { t } = useI18n()
const activityLabel = computed(() => {
  if (props.providerRetry) {
    return t('chat.runActivity.retrying_model', props.providerRetry)
  }
  return props.activity ? t(`chat.runActivity.${props.activity}`) : ''
})

function notifyContentResized(): void {
  void nextTick(() => emit('content-resized'))
}
</script>

<template>
  <article class="timeline-disclosure reasoning-group">
    <NCollapse
      arrow-placement="right"
      @update:expanded-names="notifyContentResized"
    >
      <NCollapseItem name="reasoning" :disabled="segments.length === 0">
        <template #header>
          <div class="timeline-disclosure-header reasoning-disclosure-header">
            <span>{{ t('chat.reasoning') }}</span>
            <NFlex
              v-if="activity"
              class="run-activity"
              inline
              align="center"
              :size="4"
              :wrap="false"
              role="status"
              aria-live="polite"
              :data-run-activity="activity"
              :aria-label="activityLabel"
            >
              <NSpin
                class="run-activity-spinner"
                :size="12"
                :stroke-width="16"
                :show="true"
                aria-hidden="true"
              />
              <span>{{ activityLabel }}</span>
            </NFlex>
          </div>
        </template>
        <NScrollbar
          v-if="segments.length"
          class="timeline-disclosure-list reasoning-segment-scroll"
          content-class="reasoning-segment-list"
        >
          <pre
            v-for="segment in segments"
            :key="segment.id"
            class="reasoning-content"
            >{{ segment.text }}</pre
          >
        </NScrollbar>
      </NCollapseItem>
    </NCollapse>
  </article>
</template>
