<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { BackgroundTaskTarget } from '../../../shared/background-tasks'
import type { SessionId } from '../../../shared/ids'
import { useBackgroundTaskStore } from '../../stores/background-tasks'

const props = defineProps<{
  target: BackgroundTaskTarget
  sessionId: SessionId
  active: boolean
  stopping?: boolean
}>()
const background = useBackgroundTaskStore()
const { t } = useI18n()
const request = computed(
  () =>
    background.stops[
      props.target.kind === 'terminal'
        ? `terminal:${props.target.terminalId}`
        : props.target.executionId
    ],
)
const stopping = computed(
  () =>
    props.active &&
    !request.value?.error &&
    (props.stopping || request.value?.accepted),
)
</script>

<template>
  <div v-if="active" class="background-stop-control" @click.stop @keydown.stop>
    <NTooltip :disabled="!request?.error">
      <template #trigger>
        <NButton
          size="tiny"
          tertiary
          :type="request?.error ? 'error' : 'default'"
          :loading="request?.pending"
          :disabled="request?.pending || stopping"
          :aria-label="
            t(
              target.kind === 'terminal'
                ? 'artifact.closeTerminal'
                : 'artifact.stopTask',
            )
          "
          @click="background.stop(sessionId, target)"
        >
          {{
            t(
              request?.pending
                ? 'artifact.stopRequesting'
                : stopping
                  ? 'artifact.stopping'
                  : request?.error
                    ? 'artifact.retryStop'
                    : target.kind === 'terminal'
                      ? 'artifact.closeTerminal'
                      : 'artifact.stopTask',
            )
          }}
        </NButton>
      </template>
      <span role="alert">{{ request?.error }}</span>
    </NTooltip>
    <span v-if="request?.error" class="background-stop-error" role="alert">{{
      request.error
    }}</span>
  </div>
</template>

<style scoped>
.background-stop-control {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.background-stop-error {
  max-width: 160px;
  color: var(--error-color, #d03050);
  font-size: 11px;
  overflow-wrap: anywhere;
}
</style>
