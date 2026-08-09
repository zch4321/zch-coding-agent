<script setup lang="ts">
import { NButton, NPopconfirm } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  modelId: string
  disabledReason: string
  deleteModel: (modelId: string) => Promise<boolean>
}>()
const { t } = useI18n()

/** Returns the owning Provider form's complete save-and-delete operation. */
function confirmDelete(): Promise<boolean> {
  return props.deleteModel(props.modelId)
}
</script>

<template>
  <div class="provider-model-actions" :title="disabledReason">
    <NPopconfirm
      :positive-text="t('common.delete')"
      :negative-text="t('common.cancel')"
      :disabled="Boolean(disabledReason)"
      @positive-click="confirmDelete"
    >
      <template #trigger>
        <NButton
          size="tiny"
          type="error"
          secondary
          :disabled="Boolean(disabledReason)"
        >
          {{ t('common.delete') }}
        </NButton>
      </template>
      {{ t('settings.deleteModelText', { model: modelId }) }}
    </NPopconfirm>
  </div>
</template>
