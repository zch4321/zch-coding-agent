<script setup lang="ts">
import { computed, h } from 'vue'
import { NMenu, type MenuOption } from 'naive-ui'
import type { ComposerSuggestionItem } from './composer-suggestions'
import UiIcon from '../UiIcon.vue'

const props = defineProps<{
  items: ComposerSuggestionItem[]
  activeIndex: number
  title: string
  loading?: boolean
  emptyText?: string
}>()

const emit = defineEmits<{
  select: [item: ComposerSuggestionItem]
  hover: [index: number]
}>()

const selectedKey = computed(() => props.items[props.activeIndex]?.id ?? null)
const menuOptions = computed<MenuOption[]>(() =>
  props.items.map((item, index) => ({
    key: item.id,
    label: () =>
      h('span', { class: 'composer-suggestion-label' }, [
        h('strong', item.label),
        h('small', item.detail),
      ]),
    icon: () => h(UiIcon, { name: item.icon }),
    props: {
      onMouseenter: () => emit('hover', index),
      onMousedown: (event: MouseEvent) => {
        event.preventDefault()
        emit('select', item)
      },
    },
  })),
)
const menuThemeOverrides = {
  itemHeight: '34px',
  itemColorActive: '#ddf4ff',
  itemColorActiveHover: '#ddf4ff',
  itemTextColorActive: '#0969da',
  itemTextColorActiveHover: '#0969da',
  itemIconColorActive: '#0969da',
  itemIconColorActiveHover: '#0969da',
}

function handleUpdateValue(key: string | number) {
  const item = props.items.find((candidate) => candidate.id === key)
  if (item) emit('select', item)
}
</script>

<template>
  <section class="composer-suggestions" role="listbox" :aria-label="title">
    <header>
      <span>{{ title }}</span>
      <small v-if="loading">{{ $t('common.loading') }}</small>
    </header>
    <p v-if="!items.length && !loading" class="composer-suggestions-empty">
      {{ emptyText }}
    </p>
    <NMenu
      v-if="items.length"
      class="composer-suggestion-menu"
      :options="menuOptions"
      :value="selectedKey"
      :icon-size="15"
      :root-indent="8"
      :indent="8"
      :theme-overrides="menuThemeOverrides"
      @update:value="handleUpdateValue"
    />
  </section>
</template>
