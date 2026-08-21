<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { NCollapse, NCollapseItem, NScrollbar, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ReasoningSegment, RunActivity } from '../../stores/agent-types'

const props = defineProps<{
  segments: ReasoningSegment[]
  activity?: RunActivity
}>()
const emit = defineEmits<{ 'content-resized': [] }>()
const { t } = useI18n()
const activityLabel = computed(() =>
  props.activity ? t(`chat.runActivity.${props.activity}`) : '',
)

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
            <span
              v-if="activity"
              class="run-activity"
              role="status"
              aria-live="polite"
              :data-run-activity="activity"
              :aria-label="activityLabel"
            >
              <NSpin
                class="run-activity-spinner"
                size="small"
                :show="true"
                aria-hidden="true"
              />
              <span>{{ activityLabel }}</span>
            </span>
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
