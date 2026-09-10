<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import {
  markdownSectionPreview,
  renderMarkdownSection,
  type MarkdownSection,
} from '../markdown'

const props = defineProps<{ section: MarkdownSection; streaming: boolean }>()
const html = ref('')
let generation = 0
watch(
  () => [props.section, props.streaming] as const,
  ([section, streaming]) => {
    const ticket = ++generation
    html.value = markdownSectionPreview(section, streaming)
    if (section.fences.some((fence) => !streaming || fence.closed)) {
      void renderMarkdownSection(section, streaming)
        .then((rendered) => {
          if (ticket === generation) html.value = rendered
        })
        .catch(() => {
          // Keep the escaped preview if the worker or a grammar cannot render.
        })
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  generation += 1
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- Markdown disallows raw HTML and highlighted code is escaped by Shiki. -->
  <div class="markdown-section" v-html="html"></div>
</template>
