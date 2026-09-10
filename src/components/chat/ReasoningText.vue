<script setup lang="ts">
import { useStreamText } from '../../composables/use-stream-text'
import type { ReasoningSegment } from '../../stores/agent-types'

const props = defineProps<{ segment: ReasoningSegment }>()
const text = useStreamText(
  () => props.segment.text,
  () => Boolean(props.segment.live),
)
</script>

<template>
  <pre class="reasoning-content">{{ text }}</pre>
</template>
