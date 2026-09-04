<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NButton,
  NCollapse,
  NCollapseItem,
  NEmpty,
  NInput,
  NList,
  NListItem,
  NScrollbar,
  NTag,
  NTooltip,
  type GlobalThemeOverrides,
} from 'naive-ui'
import { useAgentStore } from '../../stores/agent'
import { palette } from '../../theme/naive-theme'
import { useI18n } from 'vue-i18n'
import UiIcon from '../UiIcon.vue'

const emit = defineEmits<{
  add: []
  create: [workspacePath?: string]
  open: [sessionId: string]
  rename: [sessionId: string]
  export: [sessionId: string]
  delete: [sessionId: string]
  settings: []
}>()

const agent = useAgentStore()
const { t } = useI18n()
const searchQuery = ref('')
const collapsedProjects = reactive(new Set<string>())
let searchGeneration = 0
const sidebarListThemeOverrides = {
  color: palette.surface,
  colorHover: palette.surfaceHover,
  borderColor: 'transparent',
} satisfies NonNullable<GlobalThemeOverrides['List']>

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
const expandedProjectPaths = computed(() =>
  sortedProjects.value
    .filter((project) => !collapsedProjects.has(project.path))
    .map((project) => project.path),
)
const searchGroups = computed(() => {
  if (!searchQuery.value.trim()) return []
  return agent.projects
    .map((project) => ({
      ...project,
      conversations: agent.searchHits
        .filter((hit) => hit.session.projectId === project.id)
        .flatMap((hit) => {
          const conversation = agent.conversations.find(
            (conversation) => conversation.id === hit.session.id,
          )
          return conversation
            ? [{ ...conversation, match: hit.match.snippet }]
            : []
        }),
    }))
    .filter((project) => project.conversations.length > 0)
})

watch(searchQuery, (value) => {
  const generation = ++searchGeneration
  window.setTimeout(() => {
    if (generation !== searchGeneration) return
    void agent.searchSessions(value)
  }, 180)
})

function updateExpandedProjects(
  names: string | number | Array<string | number> | null,
) {
  const expanded = new Set(
    (Array.isArray(names) ? names : names === null ? [] : [names]).map(String),
  )
  for (const project of sortedProjects.value) {
    if (expanded.has(project.path)) collapsedProjects.delete(project.path)
    else collapsedProjects.add(project.path)
  }
}
</script>

<template>
  <aside class="project-sidebar">
    <div class="new-conversation-row">
      <NButton
        class="new-conversation-button"
        secondary
        @click="emit('create')"
      >
        <UiIcon name="plus" />
        <span>{{ t('app.newConversation') }}</span>
      </NButton>
      <NTooltip>
        <template #trigger>
          <NButton
            class="import-conversation-button"
            :aria-label="t('sidebar.import')"
            secondary
            disabled
          >
            <UiIcon name="upload" />
          </NButton>
        </template>
        {{ t('sidebar.durableImportExportPending') }}
      </NTooltip>
    </div>

    <NInput
      v-model:value="searchQuery"
      class="conversation-search"
      type="text"
      size="small"
      clearable
      :placeholder="t('sidebar.search')"
      :aria-label="t('sidebar.search')"
    >
      <template #prefix><UiIcon name="search" /></template>
    </NInput>

    <NScrollbar class="project-list" content-style="padding: 1em">
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
          <NList
            :show-divider="false"
            hoverable
            clickable
            class="conversation-search-results"
            :theme-overrides="sidebarListThemeOverrides"
          >
            <NListItem
              v-for="conversation in project.conversations"
              :key="conversation.id"
              style="padding: 0"
            >
              <NButton
                text
                block
                class="conversation-item search-result"
                @click="emit('open', conversation.id)"
              >
                <span class="conversation-item-content">
                  <span>{{
                    displayConversationTitle(conversation.title)
                  }}</span>
                  <span
                    v-if="conversationBadges(conversation).length"
                    class="conversation-badges"
                  >
                    <NTag
                      v-for="badge in conversationBadges(conversation)"
                      :key="badge"
                      size="small"
                      round
                      :bordered="false"
                    >
                      {{ badge }}
                    </NTag>
                  </span>
                  <small>{{ conversation.match }}</small>
                  <time :datetime="conversation.updatedAt">
                    {{ new Date(conversation.updatedAt).toLocaleString() }}
                  </time>
                </span>
              </NButton>
            </NListItem>
          </NList>
        </section>
        <NEmpty
          v-if="searchGroups.length === 0"
          size="small"
          class="sidebar-empty"
          :description="t('sidebar.noMatches')"
        />
      </template>

      <template v-else>
        <div class="sidebar-section-heading">
          <p class="sidebar-section-title">{{ t('sidebar.projects') }}</p>
          <NTooltip>
            <template #trigger>
              <NButton
                class="add-project-button"
                :aria-label="t('sidebar.addWorkspace')"
                quaternary
                circle
                size="small"
                @click="emit('add')"
              >
                <UiIcon name="plus" />
              </NButton>
            </template>
            {{ t('sidebar.addWorkspace') }}
          </NTooltip>
        </div>
        <NCollapse
          :expanded-names="expandedProjectPaths"
          :trigger-areas="['main', 'arrow']"
          display-directive="show"
          class="project-groups"
          @update:expanded-names="updateExpandedProjects"
        >
          <NCollapseItem
            v-for="project in sortedProjects"
            :key="project.path"
            :name="project.path"
            class="project-group"
          >
            <template #header>
              <NTooltip>
                <template #trigger>
                  <span
                    class="project-heading"
                    :aria-expanded="!collapsedProjects.has(project.path)"
                  >
                    <UiIcon name="folder" />
                    <strong>{{ project.name }}</strong>
                  </span>
                </template>
                {{ project.path }}
              </NTooltip>
            </template>
            <template #header-extra>
              <NTooltip>
                <template #trigger>
                  <NButton
                    quaternary
                    circle
                    size="small"
                    class="project-new-conversation-button"
                    :aria-label="t('sidebar.newConversationInProject')"
                    @click.stop="createProjectConversation(project.path)"
                  >
                    <UiIcon name="plus" />
                  </NButton>
                </template>
                {{ t('sidebar.newConversationInProject') }}
              </NTooltip>
            </template>
            <NList
              :show-divider="false"
              hoverable
              clickable
              class="conversation-list"
              :theme-overrides="sidebarListThemeOverrides"
            >
              <NListItem
                v-for="conversation in project.conversations"
                :key="conversation.id"
                class="conversation-row"
                style="padding: 0"
                :class="{
                  active: conversation.id === agent.activeConversationId,
                }"
              >
                <div class="conversation-row-content">
                  <NButton
                    text
                    class="conversation-item"
                    @click="emit('open', conversation.id)"
                  >
                    <span class="conversation-item-content">
                      <span>{{
                        displayConversationTitle(conversation.title)
                      }}</span>
                      <span
                        v-if="conversationBadges(conversation).length"
                        class="conversation-badges"
                      >
                        <NTag
                          v-for="badge in conversationBadges(conversation)"
                          :key="badge"
                          size="small"
                          round
                          :bordered="false"
                        >
                          {{ badge }}
                        </NTag>
                      </span>
                    </span>
                  </NButton>
                  <div class="conversation-actions">
                    <NTooltip>
                      <template #trigger>
                        <NButton
                          quaternary
                          circle
                          size="small"
                          :aria-label="t('sidebar.export')"
                          @click="emit('export', conversation.id)"
                        >
                          <UiIcon name="download" />
                        </NButton>
                      </template>
                      {{ t('sidebar.exportTitle') }}
                    </NTooltip>
                    <NTooltip>
                      <template #trigger>
                        <NButton
                          quaternary
                          circle
                          size="small"
                          :aria-label="t('sidebar.rename')"
                          @click="emit('rename', conversation.id)"
                        >
                          <UiIcon name="edit" />
                        </NButton>
                      </template>
                      {{ t('sidebar.renameTitle') }}
                    </NTooltip>
                    <NTooltip>
                      <template #trigger>
                        <NButton
                          quaternary
                          circle
                          size="small"
                          :aria-label="t('sidebar.delete')"
                          :disabled="agent.conversationIsBusy(conversation.id)"
                          @click="emit('delete', conversation.id)"
                        >
                          <UiIcon name="trash" />
                        </NButton>
                      </template>
                      {{
                        agent.conversationIsBusy(conversation.id)
                          ? t('sidebar.busyActionBlocked')
                          : t('sidebar.deleteTitle')
                      }}
                    </NTooltip>
                  </div>
                </div>
              </NListItem>
              <NListItem
                v-if="project.conversations.length === 0"
                style="padding: 8px"
              >
                <NEmpty
                  size="small"
                  class="sidebar-empty"
                  :description="t('sidebar.noConversations')"
                />
              </NListItem>
            </NList>
          </NCollapseItem>
        </NCollapse>
        <NButton
          v-if="agent.sessionHasMore"
          class="load-older-sessions-button"
          block
          secondary
          size="small"
          :loading="agent.loading"
          @click="agent.loadOlderSessions()"
        >
          {{ t('sidebar.loadOlderSessions') }}
        </NButton>
        <NEmpty
          v-if="sortedProjects.length === 0"
          class="sidebar-empty-state"
          :description="t('sidebar.noWorkspace')"
        >
          <template #icon><UiIcon name="folder" /></template>
          <template #extra>
            <NButton text type="primary" @click="agent.chooseWorkspace">
              {{ t('sidebar.addWorkspace') }}
            </NButton>
          </template>
        </NEmpty>
      </template>
    </NScrollbar>

    <div class="project-sidebar-footer">
      <NButton
        class="sidebar-settings-button"
        block
        quaternary
        @click="emit('settings')"
      >
        <UiIcon name="settings" />
        <span>{{ t('app.settings') }}</span>
      </NButton>
    </div>
  </aside>
</template>
