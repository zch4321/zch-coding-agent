<script setup lang="ts">
import { NButton, NImage, NImageGroup, NFlex, NText, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  attachmentPreviewUrl,
  type Attachment,
} from '../../../shared/attachments'
import type { AttachmentImportJob } from '../../stores/attachment-inputs'
import UiIcon from '../UiIcon.vue'

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
        :class="{ compact, 'attachment-image': attachment.kind === 'image' }"
        :data-attachment-id="attachment.id"
      >
        <NImage
          v-if="attachment.kind === 'image'"
          :src="attachmentPreviewUrl(attachment.id)"
          :preview-src="attachmentPreviewUrl(attachment.id, 'preview')"
          :alt="attachment.name"
          :width="compact ? 128 : 192"
          :height="compact ? 72 : 108"
          :img-props="{ style: { borderRadius: '8px' } }"
          object-fit="cover"
          lazy
        />
        <NFlex v-else vertical :size="2" class="attachment-details">
          <NText :title="attachment.name" class="attachment-name">{{
            attachment.name
          }}</NText>
          <NText depth="3">{{ sizeLabel(attachment.byteSize) }}</NText>
        </NFlex>
        <NFlex
          v-if="removable || reattachable"
          class="attachment-actions"
          :size="4"
        >
          <NButton
            v-if="removable"
            class="attachment-action"
            size="tiny"
            quaternary
            :circle="attachment.kind === 'image'"
            :disabled="disabled"
            :title="t('attachments.remove')"
            :aria-label="`${t('attachments.remove')} ${attachment.name}`"
            @click="emit('remove', attachment.id)"
          >
            <template v-if="attachment.kind === 'image'" #icon>
              <UiIcon name="close" />
            </template>
            <span v-if="attachment.kind === 'file'">{{
              t('attachments.remove')
            }}</span>
          </NButton>
          <NButton
            v-if="reattachable"
            class="attachment-action"
            size="tiny"
            quaternary
            :circle="attachment.kind === 'image'"
            :disabled="disabled"
            :title="t('attachments.reattach')"
            :aria-label="t('attachments.reattach')"
            @click="emit('reattach', attachment)"
          >
            <template v-if="attachment.kind === 'image'" #icon>
              <UiIcon name="plus" />
            </template>
            <span v-if="attachment.kind === 'file'">{{
              t('attachments.reattach')
            }}</span>
          </NButton>
        </NFlex>
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
.attachment-preview.attachment-image {
  position: relative;
  max-width: 192px;
  padding: 0;
  border: 0;
}
.attachment-image .attachment-actions {
  position: absolute;
  top: 4px;
  right: 4px;
}
.attachment-image .attachment-action {
  background: var(--surface);
}
.attachment-image:not(.compact) .attachment-actions {
  opacity: 0;
}
.attachment-image:hover .attachment-actions,
.attachment-image:focus-within .attachment-actions {
  opacity: 1;
}
.attachment-details {
  min-width: 0;
  max-width: 160px;
}
</style>
