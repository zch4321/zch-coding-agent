<script setup lang="ts">
import { NButton, NDialog, NModal, NSpace } from 'naive-ui'

withDefaults(
  defineProps<{
    show: boolean
    title: string
    positiveText: string
    negativeText: string
    type?: 'default' | 'error' | 'info' | 'success' | 'warning'
    positiveType?: 'default' | 'error' | 'primary' | 'success' | 'warning'
    loading?: boolean
  }>(),
  {
    type: 'warning',
    positiveType: 'primary',
    loading: false,
  },
)

const emit = defineEmits<{
  'update:show': [value: boolean]
  positive: []
}>()
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="!loading"
    :close-on-esc="!loading"
    transform-origin="center"
    @update:show="emit('update:show', $event)"
  >
    <NDialog
      :title="title"
      :type="type"
      :closable="!loading"
      style="width: min(440px, calc(100vw - 32px))"
      @close="emit('update:show', false)"
    >
      <slot />
      <template #action>
        <NSpace justify="end">
          <NButton :disabled="loading" @click="emit('update:show', false)">
            {{ negativeText }}
          </NButton>
          <NButton
            :type="positiveType"
            :loading="loading"
            @click="emit('positive')"
          >
            {{ positiveText }}
          </NButton>
        </NSpace>
      </template>
    </NDialog>
  </NModal>
</template>
