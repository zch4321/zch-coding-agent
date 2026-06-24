<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { NTooltip } from 'naive-ui'
import { useAgentStore } from '../../stores/agent'
import { useI18n } from 'vue-i18n'
import UiIcon from '../UiIcon.vue'

const emit = defineEmits<{
  add: []
  create: [workspacePath?: string]
  open: [conversationId: string]
  rename: [conversationId: string]
  delete: [conversationId: string]
  export: [conversationId: string]
  import: []
}>()

const agent = useAgentStore()
const { t } = useI18n()
const searchQuery = ref('')
const collapsedProjects = reactive(new Set<string>())

function toggleProject(path: string) {
  if (collapsedProjects.has(path)) collapsedProjects.delete(path)
  else collapsedProjects.add(path)
}

function createProjectConversation(workspacePath: string) {
  if (collapsedProjects.has(workspacePath)) {
    collapsedProjects.delete(workspacePath)
  }
  emit('create', workspacePath)
}

function displayConversationTitle(title: string) {
  return title === 'New conversation' ? t('app.newConversation') : title
}
function conversationBadges(conversation: {
  parentId?: string
  importedFrom?: string
}): string[] {
  const badges: string[] = []
  if (conversation.parentId) badges.push(t('chat.forkedBadge'))
  if (conversation.importedFrom) badges.push(t('chat.importedBadge'))
  return badges
}
const compareConversations = (
  left: (typeof agent.conversations)[number],
  right: (typeof agent.conversations)[number],
) =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  right.createdAt.localeCompare(left.createdAt) ||
  left.id.localeCompare(right.id)
const sortedProjects = computed(() =>
  agent.projects.map((project) => ({
    ...project,
    conversations: agent.conversations
      .filter((conversation) => conversation.projectPath === project.path)
      .sort(compareConversations),
  })),
)
const searchGroups = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  if (!query) return []

  return sortedProjects.value
    .map((project) => ({
      ...project,
      conversations: project.conversations
        .filter(
          (conversation) =>
            conversation.title.toLocaleLowerCase().includes(query) ||
            conversation.messages.some((message) =>
              message.text.toLocaleLowerCase().includes(query),
            ),
        )
        .map((conversation) => {
          const matchingMessage = conversation.messages.find((message) =>
            message.text.toLocaleLowerCase().includes(query),
          )
          return {
            ...conversation,
            match:
              matchingMessage?.text.replace(/\s+/g, ' ').slice(0, 90) ??
              conversation.title,
          }
        }),
    }))
    .filter((project) => project.conversations.length > 0)
})
</script>

<template>
  <aside class="project-sidebar">
    <div class="new-conversation-row">
      <button
        class="new-conversation-button"
        type="button"
        @click="emit('create')"
      >
        <UiIcon name="plus" />
        <span>{{ t('app.newConversation') }}</span>
      </button>
      <NTooltip>
        <template #trigger>
          <button
            type="button"
            class="import-conversation-button"
            :aria-label="t('sidebar.import')"
            :disabled="Boolean(agent.activeRunId || agent.pendingApproval)"
            @click="emit('import')"
          >
            <UiIcon name="upload" />
          </button>
        </template>
        {{ t('sidebar.import') }}
      </NTooltip>
    </div>

    <label class="conversation-search">
      <UiIcon name="search" />
      <input
        v-model="searchQuery"
        type="search"
        :placeholder="t('sidebar.search')"
        :aria-label="t('sidebar.search')"
      />
    </label>

    <div class="project-list">
      <template v-if="searchQuery.trim()">
        <p class="sidebar-section-title">{{ t('sidebar.searchResults') }}</p>
        <section
          v-for="project in searchGroups"
          :key="project.path"
          class="project-group search-group"
        >
          <NTooltip>
            <template #trigger>
              <div class="project-heading">
                <UiIcon name="folder" />
                <strong>{{ project.name }}</strong>
              </div>
            </template>
            {{ project.path }}
          </NTooltip>
          <button
            v-for="conversation in project.conversations"
            :key="conversation.id"
            class="conversation-item search-result"
            type="button"
            @click="emit('open', conversation.id)"
          >
            <span>{{ displayConversationTitle(conversation.title) }}</span>
            <small>{{ conversation.match }}</small>
            <time :datetime="conversation.updatedAt">
              {{ new Date(conversation.updatedAt).toLocaleString() }}
            </time>
          </button>
        </section>
        <p v-if="searchGroups.length === 0" class="sidebar-empty">
          {{ t('sidebar.noMatches') }}
        </p>
      </template>

      <template v-else>
        <div class="sidebar-section-heading">
          <p class="sidebar-section-title">{{ t('sidebar.projects') }}</p>
          <NTooltip>
            <template #trigger>
              <button
                type="button"
                class="add-project-button"
                :aria-label="t('sidebar.addWorkspace')"
                @click="emit('add')"
              >
                <UiIcon name="plus" />
              </button>
            </template>
            {{ t('sidebar.addWorkspace') }}
          </NTooltip>
        </div>
        <section
          v-for="project in sortedProjects"
          :key="project.path"
          class="project-group"
        >
          <div class="project-heading-row">
            <NTooltip>
              <template #trigger>
                <button
                  type="button"
                  class="project-heading"
                  :aria-expanded="!collapsedProjects.has(project.path)"
                  @click="toggleProject(project.path)"
                >
                  <UiIcon
                    :name="
                      collapsedProjects.has(project.path)
                        ? 'chevron-right'
                        : 'chevron-down'
                    "
                  />
                  <UiIcon name="folder" />
                  <strong>{{ project.name }}</strong>
                </button>
              </template>
              {{ project.path }}
            </NTooltip>
            <NTooltip>
              <template #trigger>
                <button
                  type="button"
                  class="project-new-conversation-button"
                  :aria-label="t('sidebar.newConversationInProject')"
                  @click="createProjectConversation(project.path)"
                >
                  <UiIcon name="plus" />
                </button>
              </template>
              {{ t('sidebar.newConversationInProject') }}
            </NTooltip>
          </div>
          <div
            v-show="!collapsedProjects.has(project.path)"
            class="conversation-list"
          >
            <div
              v-for="conversation in project.conversations"
              :key="conversation.id"
              class="conversation-row"
              :class="{
                active: conversation.id === agent.activeConversationId,
              }"
            >
              <button
                class="conversation-item"
                type="button"
                @click="emit('open', conversation.id)"
              >
                {{ displayConversationTitle(conversation.title) }}
                <span
                  v-if="conversationBadges(conversation).length"
                  class="conversation-badges"
                >
                  <em
                    v-for="badge in conversationBadges(conversation)"
                    :key="badge"
                    >{{ badge }}</em
                  >
                </span>
              </button>
              <div class="conversation-actions">
                <NTooltip>
                  <template #trigger>
                    <button
                      type="button"
                      :aria-label="t('sidebar.export')"
                      @click="emit('export', conversation.id)"
                    >
                      <UiIcon name="download" />
                    </button>
                  </template>
                  {{ t('sidebar.exportTitle') }}
                </NTooltip>
                <NTooltip>
                  <template #trigger>
                    <button
                      type="button"
                      :aria-label="t('sidebar.rename')"
                      @click="emit('rename', conversation.id)"
                    >
                      <UiIcon name="edit" />
                    </button>
                  </template>
                  {{ t('sidebar.renameTitle') }}
                </NTooltip>
                <NTooltip>
                  <template #trigger>
                    <button
                      type="button"
                      :aria-label="t('sidebar.delete')"
                      @click="emit('delete', conversation.id)"
                    >
                      <UiIcon name="trash" />
                    </button>
                  </template>
                  {{ t('sidebar.deleteTitle') }}
                </NTooltip>
              </div>
            </div>
            <p v-if="project.conversations.length === 0" class="sidebar-empty">
              {{ t('sidebar.noConversations') }}
            </p>
          </div>
        </section>
        <div v-if="sortedProjects.length === 0" class="sidebar-empty-state">
          <UiIcon name="folder" />
          <p>{{ t('sidebar.noWorkspace') }}</p>
          <button type="button" @click="agent.chooseWorkspace">
            {{ t('sidebar.addWorkspace') }}
          </button>
        </div>
      </template>
    </div>
  </aside>
</template>
