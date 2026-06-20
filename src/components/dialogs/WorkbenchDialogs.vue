<script setup lang="ts">
import { NAlert, NButton, NInput, NModal, NSpace } from 'naive-ui'

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
</script>

<template>
  <NModal
    :show="yoloOpen"
    preset="card"
    class="risk-modal"
    title="Enable Yolo mode?"
    @update:show="emit('update:yoloOpen', $event)"
  >
    <NAlert type="error" title="Host-level side effects">
      Yolo skips risk policy, sensitive-data confirmation, model approval and
      human approval. File changes execute immediately, and command tools may
      affect the host. Workspace path invariants still apply.
    </NAlert>
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:yoloOpen', false)">Cancel</NButton>
      <NButton type="error" @click="emit('confirm-yolo')">
        Enable Yolo
      </NButton>
    </NSpace>
  </NModal>

  <NModal
    :show="renameOpen"
    preset="card"
    class="small-modal"
    title="Rename conversation"
    @update:show="emit('update:renameOpen', $event)"
  >
    <NInput
      :value="renameValue"
      maxlength="120"
      @update:value="emit('update:renameValue', $event)"
    />
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:renameOpen', false)">Cancel</NButton>
      <NButton type="primary" @click="emit('confirm-rename')">Rename</NButton>
    </NSpace>
  </NModal>

  <NModal
    :show="deleteOpen"
    preset="card"
    class="small-modal"
    title="Delete conversation?"
    @update:show="emit('update:deleteOpen', $event)"
  >
    <p>
      This removes local conversation history and closes its runtime resources.
      Workspace files are not deleted.
    </p>
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:deleteOpen', false)">Cancel</NButton>
      <NButton type="error" @click="emit('confirm-delete')">Delete</NButton>
    </NSpace>
  </NModal>

  <NModal
    :show="switchOpen"
    preset="card"
    class="small-modal"
    title="Interrupt the active run?"
    @update:show="emit('update:switchOpen', $event)"
  >
    <p>
      Switching conversations interrupts the active run and closes its runtime
      session. Persistent terminal processes in that session will also close.
    </p>
    <NSpace justify="end" class="modal-actions">
      <NButton @click="emit('update:switchOpen', false)">Cancel</NButton>
      <NButton type="error" @click="emit('confirm-switch')">
        Interrupt and switch
      </NButton>
    </NSpace>
  </NModal>
</template>
