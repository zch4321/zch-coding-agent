<script setup lang="ts">
import { onMounted } from 'vue'
import { NAlert, NButton, NInput, NSwitch } from 'naive-ui'
import { useSkillsStore } from '../../stores/skills'

const skills = useSkillsStore()
onMounted(() => void skills.load(false))
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading">
      <h2>Skills</h2>
      <p>
        Install bounded instruction files. New skills remain disabled until you
        explicitly enable them.
      </p>
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
        Install URL
      </NButton>
    </div>
    <div class="settings-actions">
      <NButton secondary @click="skills.chooseAndInstall">
        Install file
      </NButton>
      <NButton secondary :loading="skills.loading" @click="skills.load(true)">
        Refresh
      </NButton>
    </div>
    <div class="skill-list">
      <p v-if="!skills.items.length">No valid skills found.</p>
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
      title="Some skill files were skipped"
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
