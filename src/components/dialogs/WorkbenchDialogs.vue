<script setup lang="ts">
import { NAlert, NButton, NInput, NModal, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'

defineProps<{
  yoloOpen: boolean
  renameOpen: boolean
  renameValue: string
  deleteOpen: boolean
  switchOpen: boolean
}>()
const emit = defineEmits<{
  'update:yoloOpen': [value: boolean]
  'update:renameOpen': [value: boolean]
  'update:renameValue': [value: string]
  'update:deleteOpen': [value: boolean]
  'update:switchOpen': [value: boolean]
  'confirm-yolo': []
  'confirm-rename': []
  'confirm-delete': []
  'confirm-switch': []
}>()
const { t } = useI18n()
</script>

<template>
  <NModal
    :show="yoloOpen"
    preset="card"
    class="risk-modal"
    :title="t('dialogs.yoloTitle')"
    @update:show="emit('update:yoloOpen', $event)"
  >
    <NAlert type="error" :title="t('dialogs.yoloRisk')">
      {{ t('dialogs.yoloText') }}
    </NAlert>
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:yoloOpen', false)">{{
        t('common.cancel')
      }}</NButton>
      <NButton type="error" @click="emit('confirm-yolo')">
        {{ t('dialogs.enableYolo') }}
      </NButton>
    </NSpace>
  </NModal>

  <NModal
    :show="renameOpen"
    preset="card"
    class="small-modal"
    :title="t('dialogs.renameTitle')"
    @update:show="emit('update:renameOpen', $event)"
  >
    <NInput
      :value="renameValue"
      maxlength="120"
      @update:value="emit('update:renameValue', $event)"
    />
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:renameOpen', false)">{{
        t('common.cancel')
      }}</NButton>
      <NButton type="primary" @click="emit('confirm-rename')">{{
        t('dialogs.rename')
      }}</NButton>
    </NSpace>
  </NModal>

  <NModal
    :show="deleteOpen"
    preset="card"
    class="small-modal"
    :title="t('dialogs.deleteTitle')"
    @update:show="emit('update:deleteOpen', $event)"
  >
    <p>
      {{ t('dialogs.deleteText') }}
    </p>
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:deleteOpen', false)">{{
        t('common.cancel')
      }}</NButton>
      <NButton type="error" @click="emit('confirm-delete')">{{
        t('common.delete')
      }}</NButton>
    </NSpace>
  </NModal>

  <NModal
    :show="switchOpen"
    preset="card"
    class="small-modal"
    :title="t('dialogs.switchTitle')"
    @update:show="emit('update:switchOpen', $event)"
  >
    <p>
      {{ t('dialogs.switchText') }}
    </p>
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:switchOpen', false)">{{
        t('common.cancel')
      }}</NButton>
      <NButton type="error" @click="emit('confirm-switch')">
        {{ t('dialogs.interruptSwitch') }}
      </NButton>
    </NSpace>
  </NModal>
</template>
