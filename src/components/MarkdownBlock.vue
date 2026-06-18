<script setup lang="ts">
import { ref, watch } from 'vue'
import { renderMarkdown } from '../markdown'

const props = defineProps<{
  content: string
}>()

const html = ref('')
let renderToken = 0

watch(
  () => props.content,
  async (content) => {
    const token = (renderToken += 1)
    const rendered = await renderMarkdown(content || '')

    if (token === renderToken) {
      html.value = rendered
    }
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
  <!-- eslint-disable-next-line vue/no-v-html -- Markdown renderer disables raw HTML and validates link protocols. -->
  <div class="markdown" @click="handleClick" v-html="html"></div>
</template>
