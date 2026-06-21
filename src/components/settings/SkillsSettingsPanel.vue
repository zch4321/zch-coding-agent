<script setup lang="ts">
import { onMounted } from 'vue'
import { NAlert, NButton, NInput, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSkillsStore } from '../../stores/skills'

const skills = useSkillsStore()
const { t } = useI18n()
onMounted(() => void skills.load(false))
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>{{ t('skills.title') }}</h2>
      <p>{{ t('skills.hint') }}</p>
    </div>
    <div class="settings-inline">
      <NInput
        v-model:value="skills.url"
        placeholder="https://example.com/skill.md"
      />
      <NButton
        secondary
        :loading="skills.loading"
        @click="skills.installFromUrl"
      >
        {{ t('skills.installUrl') }}
      </NButton>
    </div>
    <div class="settings-actions">
      <NButton secondary @click="skills.chooseAndInstall">
        {{ t('skills.installFile') }}
      </NButton>
      <NButton secondary :loading="skills.loading" @click="skills.load(true)">
        {{ t('skills.refresh') }}
      </NButton>
    </div>
    <div class="skill-list">
      <p v-if="!skills.items.length">{{ t('skills.none') }}</p>
      <article v-for="skill in skills.items" :key="skill.name">
        <div>
          <strong>{{ skill.name }}</strong>
          <span>{{ skill.description }}</span>
          <small>{{ skill.source }} · {{ skill.sha256.slice(0, 12) }}</small>
        </div>
        <NSwitch
          :value="skill.enabled"
          @update:value="skills.setEnabled(skill.name, $event)"
        />
      </article>
    </div>
    <NAlert
      v-if="skills.diagnostics.length"
      type="warning"
      :title="t('skills.skipped')"
    >
      <div
        v-for="item in skills.diagnostics"
        :key="item.file + ':' + item.code"
      >
        {{ item.file }}: {{ item.message }}
      </div>
    </NAlert>
    <NAlert v-if="skills.error" type="error">{{ skills.error }}</NAlert>
  </section>
</template>
