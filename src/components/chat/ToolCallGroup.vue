<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { NCollapse, NCollapseItem } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ToolActivity } from '../../stores/agent-types'
import ToolCallCard from './ToolCallCard.vue'

const props = defineProps<{ tools: ToolActivity[] }>()
const emit = defineEmits<{ 'content-resized': [] }>()
const { t } = useI18n()
const lastToolName = computed(() => props.tools.at(-1)?.tool ?? '')

function notifyContentResized(): void {
  void nextTick(() => emit('content-resized'))
}
</script>

<template>
  <article class="timeline-disclosure tool-call-group">
    <NCollapse
      arrow-placement="right"
      @update:expanded-names="notifyContentResized"
    >
      <NCollapseItem name="tools">
        <template #header>
          <div class="timeline-disclosure-header">
            <span>{{ t('chat.toolCall') }}</span>
            <span aria-hidden="true">·</span>
            <strong>{{ lastToolName }}</strong>
          </div>
        </template>
        <div class="timeline-disclosure-list tool-call-group-list">
          <ToolCallCard
            v-for="tool in tools"
            :key="tool.callId"
            :tool="tool"
            @content-resized="notifyContentResized"
          />
        </div>
      </NCollapseItem>
    </NCollapse>
  </article>
</template>
