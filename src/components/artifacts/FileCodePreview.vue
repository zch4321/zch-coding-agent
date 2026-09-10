<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { renderCode } from '../../markdown'
import { cachedCodeHtml, plainCodeHtml } from '../../markdown-code'

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
    const language = languageForPath(path)
    html.value = cachedCodeHtml(content, language) ?? plainCodeHtml(content)
    try {
      const rendered = await renderCode(content, language)
      if (token === renderToken) html.value = rendered
    } catch {
      // Keep the escaped preview when the highlighting worker is unavailable.
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  renderToken += 1
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- Shiki escapes source text before producing bounded highlighting markup. -->
  <div class="file-code-highlight" v-html="html"></div>
</template>
