<script setup lang="ts">
import { ref, watch } from 'vue'
import { renderCode } from '../../markdown'

const props = defineProps<{ path: string; content: string }>()
const html = ref('')
let renderToken = 0

function languageForPath(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase()
  switch (extension) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'json':
    case 'json5':
      return 'json'
    case 'md':
      return 'markdown'
    case 'sh':
    case 'bash':
    case 'ps1':
      return 'shellscript'
    default:
      return 'text'
  }
}

watch(
  () => [props.path, props.content] as const,
  async ([path, content]) => {
    const token = (renderToken += 1)
    const rendered = await renderCode(content, languageForPath(path))
    if (token === renderToken) html.value = rendered
  },
  { immediate: true },
)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- Shiki escapes source text before producing bounded highlighting markup. -->
  <div class="file-code-highlight" v-html="html"></div>
</template>
