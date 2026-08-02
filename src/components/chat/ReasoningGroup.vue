<script setup lang="ts">
import { nextTick } from 'vue'
import { NCollapse, NCollapseItem, NScrollbar, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ReasoningSegment } from '../../stores/agent-types'

defineProps<{
  segments: ReasoningSegment[]
  streaming: boolean
}>()
const emit = defineEmits<{ 'content-resized': [] }>()
const { t } = useI18n()

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
      <NCollapseItem name="reasoning">
        <template #header>
          <div class="timeline-disclosure-header">
            <span>{{ t('chat.reasoning') }}</span>
            <NTag v-if="streaming" round size="small" type="info">
              {{ t('chat.streaming') }}
            </NTag>
          </div>
        </template>
        <NScrollbar
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
