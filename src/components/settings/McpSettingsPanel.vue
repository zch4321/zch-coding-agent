<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { NAlert, NButton, NModal, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { McpServerStatus } from '../../../shared/mcp'
import { useMcpStore } from '../../stores/mcp'

const mcp = useMcpStore()
const { t } = useI18n()
const trustTarget = ref<McpServerStatus>()
let refreshTimer: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  void mcp.load()
  refreshTimer = setInterval(() => void mcp.load(), 3_000)
})
onUnmounted(() => clearInterval(refreshTimer))

function toggle(server: McpServerStatus, enabled: boolean) {
  if (!enabled) {
    void mcp.disable(server.id)
    return
  }
  trustTarget.value = server
}

async function trustAndEnable() {
  const server = trustTarget.value
  if (!server) return
  await mcp.trustAndEnable(server)
  if (!mcp.error) trustTarget.value = undefined
}

function restartServer(server: McpServerStatus) {
  void mcp.restart(server)
}
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('mcp.title') }}</h2>
      <p>{{ t('mcp.hint') }}</p>
    </div>
    <div class="settings-actions">
      <NButton secondary :loading="mcp.loading" @click="mcp.reload">
        {{ t('mcp.reload') }}
      </NButton>
      <NButton secondary :loading="mcp.refreshing" @click="mcp.load">
        {{ t('common.refresh') }}
      </NButton>
    </div>
    <div class="skill-list">
      <p v-if="!mcp.items.length">{{ t('mcp.none') }}</p>
      <article
        v-for="server in mcp.items"
        :key="server.id + ':' + (server.workspace ?? 'global')"
      >
        <div>
          <strong>{{ server.label }}</strong>
          <span>{{ server.description }}</span>
          <small>
            {{ server.id }} · {{ server.scope }} · {{ server.state }} ·
            {{ t('mcp.tools', { count: server.toolCount }) }}
          </small>
          <small v-if="server.workspace">{{ server.workspace }}</small>
          <small v-if="server.pid">PID {{ server.pid }}</small>
          <small v-if="server.revision">
            revision {{ server.revision.slice(0, 12) }}
          </small>
          <NAlert v-if="server.lastError" type="error">
            {{ server.lastError }}
          </NAlert>
          <pre v-if="server.stderrTail" class="mcp-log-tail">{{
            server.stderrTail
          }}</pre>
          <NButton
            v-if="server.trusted && server.enabled"
            size="small"
            secondary
            :loading="mcp.loading"
            @click="restartServer(server)"
          >
            {{ t('mcp.restart') }}
          </NButton>
        </div>
        <NSwitch
          :value="server.enabled && server.trusted"
          :loading="mcp.loading"
          @update:value="toggle(server, $event)"
        />
      </article>
    </div>

    <NModal
      :show="Boolean(trustTarget)"
      preset="card"
      style="width: min(620px, calc(100vw - 40px))"
      :title="t('mcp.trustTitle')"
      :mask-closable="false"
      @update:show="(show) => !show && (trustTarget = undefined)"
    >
      <p>{{ t('mcp.trustHint') }}</p>
      <pre class="mcp-launch-preview">{{ trustTarget?.launchPreview }}</pre>
      <div class="settings-actions">
        <NButton @click="trustTarget = undefined">
          {{ t('common.cancel') }}
        </NButton>
        <NButton type="primary" :loading="mcp.loading" @click="trustAndEnable">
          {{ t('mcp.trustEnable') }}
        </NButton>
      </div>
    </NModal>
  </section>
</template>
