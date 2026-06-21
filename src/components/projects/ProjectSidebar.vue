<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useAgentStore } from '../../stores/agent'
import { useI18n } from 'vue-i18n'
import UiIcon from '../UiIcon.vue'

defineEmits<{
  add: []
  create: []
  open: [conversationId: string]
  rename: [conversationId: string]
  delete: [conversationId: string]
}>()

const agent = useAgentStore()
const { t } = useI18n()
const searchQuery = ref('')
const collapsedProjects = reactive(new Set<string>())

function toggleProject(path: string) {
  if (collapsedProjects.has(path)) collapsedProjects.delete(path)
  else collapsedProjects.add(path)
}

function displayConversationTitle(title: string) {
  return title === 'New conversation' ? t('app.newConversation') : title
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
    <button
      class="new-conversation-button"
      type="button"
      @click="$emit('create')"
    >
      <UiIcon name="plus" />
      <span>{{ t('app.newConversation') }}</span>
    </button>

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
          <div class="project-heading" :title="project.path">
            <UiIcon name="folder" />
            <strong>{{ project.name }}</strong>
          </div>
          <button
            v-for="conversation in project.conversations"
            :key="conversation.id"
            class="conversation-item search-result"
            type="button"
            @click="$emit('open', conversation.id)"
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
          <button
            type="button"
            class="add-project-button"
            :aria-label="t('sidebar.addWorkspace')"
            :title="t('sidebar.addWorkspace')"
            @click="$emit('add')"
          >
            <UiIcon name="plus" />
          </button>
        </div>
        <section
          v-for="project in sortedProjects"
          :key="project.path"
          class="project-group"
        >
          <button
            type="button"
            class="project-heading"
            :title="project.path"
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
                @click="$emit('open', conversation.id)"
              >
                {{ displayConversationTitle(conversation.title) }}
              </button>
              <div class="conversation-actions">
                <button
                  type="button"
                  :aria-label="t('sidebar.rename')"
                  :title="t('sidebar.renameTitle')"
                  @click="$emit('rename', conversation.id)"
                >
                  <UiIcon name="edit" />
                </button>
                <button
                  type="button"
                  :aria-label="t('sidebar.delete')"
                  :title="t('sidebar.deleteTitle')"
                  @click="$emit('delete', conversation.id)"
                >
                  <UiIcon name="trash" />
                </button>
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
