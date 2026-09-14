<script setup lang="ts">
import { NButton, NImage, NImageGroup, NFlex, NText, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  attachmentPreviewUrl,
  type Attachment,
} from '../../../shared/attachments'
import type { AttachmentImportJob } from '../../stores/attachment-inputs'

withDefaults(
  defineProps<{
    attachments: Attachment[]
    pending?: AttachmentImportJob[]
    removable?: boolean
    reattachable?: boolean
    disabled?: boolean
    compact?: boolean
  }>(),
  {
    pending: () => [],
    removable: false,
    reattachable: false,
    disabled: false,
    compact: false,
  },
)
const emit = defineEmits<{
  remove: [id: string]
  cancel: [id: string]
  reattach: [attachment: Attachment]
}>()
const { t } = useI18n()

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`
}
</script>

<template>
  <NImageGroup>
    <NFlex
      class="attachment-previews"
      :size="8"
      align="start"
      aria-label="Attachments"
    >
      <NFlex
        v-for="attachment in attachments"
        :key="attachment.id"
        :vertical="!compact"
        :align="compact ? 'center' : undefined"
        :size="4"
        class="attachment-preview"
        :class="{ compact }"
        :data-attachment-id="attachment.id"
      >
        <NImage
          v-if="attachment.kind === 'image'"
          :src="attachmentPreviewUrl(attachment.id)"
          :preview-src="attachmentPreviewUrl(attachment.id, 'preview')"
          :alt="attachment.name"
          :width="compact ? 64 : 112"
          :height="compact ? 48 : 80"
          object-fit="contain"
          lazy
        />
        <NFlex vertical :size="2" class="attachment-details">
          <NText :title="attachment.name" class="attachment-name">{{
            attachment.name
          }}</NText>
          <NText depth="3">{{ sizeLabel(attachment.byteSize) }}</NText>
        </NFlex>
        <NButton
          v-if="removable"
          size="tiny"
          quaternary
          :disabled="disabled"
          :aria-label="`${t('attachments.remove')} ${attachment.name}`"
          @click="emit('remove', attachment.id)"
          >{{ t('attachments.remove') }}</NButton
        >
        <NButton
          v-if="reattachable"
          size="tiny"
          quaternary
          :disabled="disabled"
          @click="emit('reattach', attachment)"
          >{{ t('attachments.reattach') }}</NButton
        >
      </NFlex>
      <NTag
        v-for="job in pending"
        :key="job.id"
        :closable="!job.cancelled"
        @close="emit('cancel', job.id)"
      >
        {{ job.name || t('attachments.clipboard') }} ·
        {{ t('attachments.importing') }} {{ job.progress }}%
      </NTag>
    </NFlex>
  </NImageGroup>
</template>

<style scoped>
.attachment-previews {
  padding: 8px 0;
}
.attachment-preview {
  max-width: 160px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.attachment-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attachment-preview.compact {
  max-width: 300px;
}
.attachment-details {
  min-width: 0;
  max-width: 160px;
}
</style>
