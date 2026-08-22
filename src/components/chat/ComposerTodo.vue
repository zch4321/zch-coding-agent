<script setup lang="ts">
import { computed } from 'vue'
import {
  NButton,
  NCheckbox,
  NFlex,
  NList,
  NListItem,
  NPopover,
  NScrollbar,
  NText,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { TodoItemStatus, TodoState } from '../../../shared/todo'
import UiIcon from '../UiIcon.vue'

const props = defineProps<{ todo: TodoState }>()
const { t } = useI18n()

const progress = computed(() => ({
  completed: props.todo.items.filter((item) => item.status === 'completed')
    .length,
  total: props.todo.items.length,
}))
const currentItem = computed(
  () =>
    props.todo.items.find((item) => item.status === 'in_progress') ??
    props.todo.items.find((item) => item.status === 'pending'),
)

function itemDepth(status: TodoItemStatus): 3 | undefined {
  return status === 'pending' ? 3 : undefined
}
</script>

<template>
  <div v-if="currentItem" class="composer-todo-anchor">
    <NPopover trigger="hover" placement="top-start" :show-arrow="false">
      <template #trigger>
        <NButton
          class="composer-todo-preview"
          attr-type="button"
          size="small"
          secondary
          block
          :aria-label="`${t('chat.todo')}: ${currentItem.step}`"
        >
          <UiIcon name="check" />
          <NText class="composer-todo-status" depth="3">
            {{ t(`chat.todoStatus.${currentItem.status}`) }}
          </NText>
          <span class="composer-todo-step" :title="currentItem.step">
            {{ currentItem.step }}
          </span>
          <NText class="composer-todo-count" depth="3">
            {{
              t('chat.todoProgress', {
                completed: progress.completed,
                total: progress.total,
              })
            }}
          </NText>
        </NButton>
      </template>

      <div class="composer-todo-popover">
        <header>
          <NText strong>{{ t('chat.todo') }}</NText>
          <NText depth="3">
            {{
              t('chat.todoProgress', {
                completed: progress.completed,
                total: progress.total,
              })
            }}
          </NText>
        </header>
        <NScrollbar class="composer-todo-scroll">
          <NText
            v-if="todo.explanation"
            class="composer-todo-explanation"
            depth="3"
          >
            {{ todo.explanation }}
          </NText>
          <NList :show-divider="false">
            <NListItem
              v-for="(item, index) in todo.items"
              :key="`${index}:${item.step}`"
            >
              <NFlex align="center" :size="8" :wrap="false">
                <NCheckbox
                  :checked="item.status === 'completed'"
                  :indeterminate="item.status === 'in_progress'"
                  :aria-label="t(`chat.todoStatus.${item.status}`)"
                  disabled
                />
                <NText
                  class="composer-todo-list-step"
                  :delete="item.status === 'completed'"
                  :depth="itemDepth(item.status)"
                  :strong="item.status === 'in_progress'"
                >
                  {{ item.step }}
                </NText>
              </NFlex>
            </NListItem>
          </NList>
        </NScrollbar>
      </div>
    </NPopover>
  </div>
</template>
