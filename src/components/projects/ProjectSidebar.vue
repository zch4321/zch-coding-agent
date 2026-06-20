<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAgentStore } from '../../stores/agent'
import UiIcon from '../UiIcon.vue'

defineEmits<{
  create: []
  open: [conversationId: string]
  rename: [conversationId: string]
  delete: [conversationId: string]
}>()

const agent = useAgentStore()
const searchQuery = ref('')
const sortedProjects = computed(() =>
  agent.projects.map((project) => ({
    ...project,
    conversations: agent.conversations
      .filter((conversation) => conversation.projectPath === project.path)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
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
      <span>New conversation</span>
    </button>

    <label class="conversation-search">
      <UiIcon name="search" />
      <input
        v-model="searchQuery"
        type="search"
        placeholder="Search conversations"
        aria-label="Search conversations"
      />
    </label>

    <div class="project-list">
      <template v-if="searchQuery.trim()">
        <p class="sidebar-section-title">Search results</p>
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
            <span>{{ conversation.title }}</span>
            <small>{{ conversation.match }}</small>
            <time :datetime="conversation.updatedAt">
              {{ new Date(conversation.updatedAt).toLocaleString() }}
            </time>
          </button>
        </section>
        <p v-if="searchGroups.length === 0" class="sidebar-empty">
          No matching conversations
        </p>
      </template>

      <template v-else>
        <p class="sidebar-section-title">Projects</p>
        <section
          v-for="project in sortedProjects"
          :key="project.path"
          class="project-group"
        >
          <div class="project-heading" :title="project.path">
            <UiIcon name="chevron-down" />
            <UiIcon name="folder" />
            <strong>{{ project.name }}</strong>
          </div>
          <div class="conversation-list">
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
                {{ conversation.title }}
              </button>
              <div class="conversation-actions">
                <button
                  type="button"
                  aria-label="Rename conversation"
                  title="Rename"
                  @click="$emit('rename', conversation.id)"
                >
                  <UiIcon name="edit" />
                </button>
                <button
                  type="button"
                  aria-label="Delete conversation"
                  title="Delete"
                  @click="$emit('delete', conversation.id)"
                >
                  <UiIcon name="trash" />
                </button>
              </div>
            </div>
            <p v-if="project.conversations.length === 0" class="sidebar-empty">
              No conversations
            </p>
          </div>
        </section>
        <div v-if="sortedProjects.length === 0" class="sidebar-empty-state">
          <UiIcon name="folder" />
          <p>No workspace yet</p>
          <button type="button" @click="agent.chooseWorkspace">
            Choose workspace
          </button>
        </div>
      </template>
    </div>
  </aside>
</template>
