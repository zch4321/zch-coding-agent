<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NList,
  NListItem,
  NSpace,
  NTag,
  NTooltip,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { ProjectId } from '../../../shared/ids'
import { useAgentStore, type ProjectView } from '../../stores/agent'
import ConfirmDialog from '../dialogs/ConfirmDialog.vue'

const agent = useAgentStore()
const { t } = useI18n()
const removeTarget = ref<ProjectView>()
const removePendingProjectId = ref<ProjectId>()
const projectRows = computed(() =>
  agent.projects.map((project) => {
    const conversations = agent.conversations.filter(
      (conversation) => conversation.projectId === project.id,
    )
    return {
      ...project,
      activeConversationCount: conversations.length,
      busy: conversations.some((conversation) =>
        agent.conversationIsBusy(conversation.id),
      ),
      current: project.id === agent.selectedProjectId,
    }
  }),
)

/** Opens the destructive confirmation for one idle Project. */
function requestRemove(project: ProjectView): void {
  if (removePendingProjectId.value) return
  removeTarget.value = project
}

/** Closes the confirmation only while no removal request is in flight. */
function updateRemoveDialog(show: boolean): void {
  if (!show && !removePendingProjectId.value) removeTarget.value = undefined
}

/** Removes the selected Project while keeping the dialog open on failure. */
async function removeProject(): Promise<void> {
  const project = removeTarget.value
  if (!project || removePendingProjectId.value) return
  removePendingProjectId.value = project.id
  try {
    if (await agent.removeProject(project.id)) removeTarget.value = undefined
  } finally {
    removePendingProjectId.value = undefined
  }
}
</script>

<template>
  <section class="settings-section">
    <div class="settings-heading settings-heading-with-actions">
      <div>
        <h2>{{ t('settings.projectTitle') }}</h2>
        <p>{{ t('settings.projectHint') }}</p>
      </div>
      <NButton type="primary" @click="agent.chooseWorkspace">
        {{ t('settings.addProject') }}
      </NButton>
    </div>

    <NAlert type="info" :show-icon="true">
      {{ t('settings.projectRemovalSafety') }}
    </NAlert>

    <NList v-if="projectRows.length > 0" bordered class="project-settings-list">
      <NListItem v-for="project in projectRows" :key="project.id">
        <div class="project-settings-row">
          <div class="project-settings-details">
            <div class="project-settings-title">
              <strong :title="project.name">{{ project.name }}</strong>
              <NTag
                v-if="project.current"
                size="small"
                type="info"
                :bordered="false"
              >
                {{ t('settings.currentProject') }}
              </NTag>
            </div>
            <code class="project-settings-path" :title="project.path">
              {{ project.path }}
            </code>
            <span class="project-settings-meta">
              {{
                t('settings.activeConversationCount', {
                  count: project.activeConversationCount,
                })
              }}
            </span>
          </div>
          <NSpace class="project-settings-actions" size="small">
            <NTooltip :disabled="!project.busy">
              <template #trigger>
                <span>
                  <NButton
                    size="small"
                    secondary
                    type="error"
                    :loading="removePendingProjectId === project.id"
                    :disabled="project.busy || Boolean(removePendingProjectId)"
                    @click="requestRemove(project)"
                  >
                    {{ t('settings.removeProject') }}
                  </NButton>
                </span>
              </template>
              {{ t('settings.removeProjectBusy') }}
            </NTooltip>
          </NSpace>
        </div>
      </NListItem>
    </NList>

    <NEmpty v-else :description="t('settings.projectEmpty')">
      <template #extra>
        <NButton type="primary" @click="agent.chooseWorkspace">
          {{ t('settings.addProject') }}
        </NButton>
      </template>
    </NEmpty>

    <ConfirmDialog
      :show="Boolean(removeTarget)"
      :title="t('settings.removeProjectTitle')"
      :positive-text="t('settings.removeProject')"
      :negative-text="t('common.cancel')"
      :loading="Boolean(removePendingProjectId)"
      type="warning"
      positive-type="error"
      @update:show="updateRemoveDialog"
      @positive="removeProject"
    >
      {{
        t('settings.removeConfirm', {
          name: removeTarget?.name ?? '',
          path: removeTarget?.path ?? '',
        })
      }}
    </ConfirmDialog>
  </section>
</template>
