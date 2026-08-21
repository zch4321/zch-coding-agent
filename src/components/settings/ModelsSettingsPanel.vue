<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ModelPoolSettingsSection from './ModelPoolSettingsSection.vue'
import ModelRolesSettingsSection from './ModelRolesSettingsSection.vue'

const { t } = useI18n()
</script>

<template>
  <div class="settings-domain-page" data-settings-domain="models">
    <section class="settings-section">
      <div class="settings-heading">
        <h2>{{ t('settings.modelsTitle') }}</h2>
        <p>{{ t('settings.modelsHint') }}</p>
      </div>
      <ModelRolesSettingsSection />
      <ModelPoolSettingsSection />
    </section>
  </div>
</template>
