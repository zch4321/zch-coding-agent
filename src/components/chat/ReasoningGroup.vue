<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue'
import {
  NCollapse,
  NCollapseItem,
  NFlex,
  NScrollbar,
  NSpin,
  type ScrollbarInst,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ProviderRetryState } from '../../../shared/agent-events'
import type { ReasoningSegment, RunActivity } from '../../stores/agent-types'
import { useScrollFollow } from '../../composables/use-scroll-follow'
import { conversationResumeKey } from './scroll-follow-context'
import ReasoningText from './ReasoningText.vue'

const props = defineProps<{
  segments: ReasoningSegment[]
  activity?: RunActivity
  providerRetry?: ProviderRetryState
}>()
const emit = defineEmits<{ 'content-resized': [] }>()
const { t } = useI18n()
const scrollbar = ref<ScrollbarInst>()
const content = ref<HTMLElement>()
const expanded = ref(false)
const hasLive = computed(() => props.segments.some((segment) => segment.live))
const resumeVersion = inject(conversationResumeKey, ref(0))
const follow = useScrollFollow({
  content: () => content.value,
  scroll: () => scrollbar.value?.scrollTo({ top: Number.MAX_SAFE_INTEGER }),
  initialFollowing: false,
})
watch(resumeVersion, () => {
  if (expanded.value && hasLive.value) follow.resume()
})
const activityLabel = computed(() => {
  if (props.providerRetry) {
    return t('chat.runActivity.retrying_model', props.providerRetry)
  }
  return props.activity ? t(`chat.runActivity.${props.activity}`) : ''
})

function notifyContentResized(
  names: string | number | Array<string | number> | null,
): void {
  expanded.value = Array.isArray(names)
    ? names.includes('reasoning')
    : names === 'reasoning'
  if (expanded.value && hasLive.value) follow.resume()
  else follow.pause()
  void nextTick(() => emit('content-resized'))
}
</script>

<template>
  <article
    class="timeline-disclosure reasoning-group"
    @wheel.capture.passive="follow.onWheel"
    @keydown.capture="follow.onKeydown"
    @touchstart.capture.passive="follow.onTouchstart"
    @touchmove.capture.passive="follow.onTouchmove"
  >
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
          ref="scrollbar"
          class="timeline-disclosure-list reasoning-segment-scroll"
          @scroll="follow.onScroll"
        >
          <div ref="content" class="reasoning-segment-list">
            <ReasoningText
              v-for="segment in segments"
              :key="segment.id"
              :segment="segment"
            />
          </div>
        </NScrollbar>
      </NCollapseItem>
    </NCollapse>
  </article>
</template>
