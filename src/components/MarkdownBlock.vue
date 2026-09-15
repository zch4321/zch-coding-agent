<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import {
  parseMarkdownSections,
  type MarkdownSection as Section,
} from '../markdown'
import { useStreamText } from '../composables/use-stream-text'
import MarkdownSection from './MarkdownSection.vue'

const props = defineProps<{
  content: string
  streaming?: boolean
  contextReferences?: boolean
}>()

const content = useStreamText(
  () => props.content,
  () => Boolean(props.streaming),
)
const sections = shallowRef<Section[]>([])

watch(
  [content, () => props.contextReferences],
  ([value, contextReferences]) => {
    sections.value = parseMarkdownSections(
      value,
      sections.value,
      contextReferences,
    )
  },
  { immediate: true },
)

function handleClick(event: MouseEvent) {
  const target = event.target

  if (!(target instanceof HTMLElement)) {
    return
  }

  const link = target.closest('a')

  if (link) {
    event.preventDefault()
  }
}
</script>

<template>
  <div class="markdown" @click="handleClick">
    <MarkdownSection
      v-for="section in sections"
      :key="section.id"
      :section="section"
      :streaming="Boolean(streaming)"
    />
  </div>
</template>
