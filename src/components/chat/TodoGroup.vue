<script setup lang="ts">
import {
  NCard,
  NCheckbox,
  NEmpty,
  NFlex,
  NList,
  NListItem,
  NTag,
  NText,
} from 'naive-ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TodoItemStatus, TodoState } from '../../../shared/todo'

const props = defineProps<{ todo: TodoState }>()
const { t } = useI18n()
const progress = computed(() => ({
  completed: props.todo.items.filter((item) => item.status === 'completed')
    .length,
  total: props.todo.items.length,
}))

function itemDepth(status: TodoItemStatus): 3 | undefined {
  return status === 'pending' ? 3 : undefined
}
</script>

<template>
  <NCard class="todo-group" size="small">
    <template #header>{{ t('chat.todo') }}</template>
    <template #header-extra>
      <NTag size="small" round :bordered="false">
        {{
          t('chat.todoProgress', {
            completed: progress.completed,
            total: progress.total,
          })
        }}
      </NTag>
    </template>

    <NFlex vertical :size="8">
      <NText v-if="todo.explanation" depth="3">
        {{ todo.explanation }}
      </NText>
      <NList v-if="todo.items.length" :show-divider="false">
        <NListItem v-for="(item, index) in todo.items" :key="index">
          <NFlex align="center" :size="8" :wrap="false">
            <NCheckbox
              :checked="item.status === 'completed'"
              :indeterminate="item.status === 'in_progress'"
              :aria-label="t(`chat.todoStatus.${item.status}`)"
              disabled
            />
            <NText
              class="todo-step"
              :delete="item.status === 'completed'"
              :depth="itemDepth(item.status)"
              :strong="item.status === 'in_progress'"
            >
              {{ item.step }}
            </NText>
          </NFlex>
        </NListItem>
      </NList>
      <NEmpty v-else size="small" :description="t('chat.todoEmpty')" />
    </NFlex>
  </NCard>
</template>
