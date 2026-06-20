<script setup lang="ts">
defineProps<{
  name:
    | 'app'
    | 'panel-left'
    | 'panel-right'
    | 'settings'
    | 'minimize'
    | 'maximize'
    | 'close'
    | 'plus'
    | 'search'
    | 'chevron-down'
    | 'chevron-right'
    | 'folder'
    | 'file'
    | 'explorer'
    | 'diff'
    | 'send'
    | 'stop'
    | 'edit'
    | 'trash'
    | 'arrow-left'
    | 'check'
    | 'warning'
    | 'terminal'
    | 'maximize-panel'
    | 'restore'
}>()
</script>

<template>
  <svg
    class="ui-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <g v-if="name === 'app'">
      <path d="m9 7-5 5 5 5" />
      <path d="m15 7 5 5-5 5" />
      <path d="m14 4-4 16" />
    </g>
    <g v-else-if="name === 'panel-left'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </g>
    <g v-else-if="name === 'panel-right'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </g>
    <g v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"
      />
    </g>
    <path v-else-if="name === 'minimize'" d="M6 12h12" />
    <rect
      v-else-if="name === 'maximize'"
      x="6"
      y="6"
      width="12"
      height="12"
      rx="1"
    />
    <g v-else-if="name === 'close'">
      <path d="m7 7 10 10" />
      <path d="m17 7-10 10" />
    </g>
    <g v-else-if="name === 'plus'">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </g>
    <g v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </g>
    <path v-else-if="name === 'chevron-down'" d="m7 9 5 5 5-5" />
    <path v-else-if="name === 'chevron-right'" d="m9 7 5 5-5 5" />
    <g v-else-if="name === 'folder'">
      <path d="M3 7.5h7l2 2h9v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1.5" />
    </g>
    <g v-else-if="name === 'file'">
      <path d="M6 3h8l4 4v14H6Z" />
      <path d="M14 3v5h4" />
    </g>
    <g v-else-if="name === 'explorer'">
      <path d="M4 5h6l2 2h8v12H4Z" />
      <path d="M4 10h16" />
    </g>
    <g v-else-if="name === 'diff'">
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v8" />
      <path d="M8 6h4a6 6 0 0 1 6 6v4" />
      <path d="M15 9h6" />
      <path d="M18 6v6" />
    </g>
    <g v-else-if="name === 'send'">
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </g>
    <rect
      v-else-if="name === 'stop'"
      x="7"
      y="7"
      width="10"
      height="10"
      rx="2"
    />
    <g v-else-if="name === 'edit'">
      <path d="m14 5 5 5" />
      <path d="M4 20h4L19 9l-4-4L4 16Z" />
    </g>
    <g v-else-if="name === 'trash'">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="m6 7 1 14h10l1-14" />
      <path d="M10 11v6M14 11v6" />
    </g>
    <g v-else-if="name === 'arrow-left'">
      <path d="m14 6-6 6 6 6" />
      <path d="M8 12h12" />
    </g>
    <path v-else-if="name === 'check'" d="m5 12 4 4L19 6" />
    <g v-else-if="name === 'warning'">
      <path d="M12 3 2.5 20h19Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </g>
    <g v-else-if="name === 'terminal'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </g>
    <g v-else-if="name === 'maximize-panel'">
      <path d="M8 4H4v4" />
      <path d="m4 4 6 6" />
      <path d="M16 20h4v-4" />
      <path d="m20 20-6-6" />
    </g>
    <g v-else-if="name === 'restore'">
      <path d="M9 4H4v5" />
      <path d="m4 4 6 6" />
      <path d="M15 20h5v-5" />
      <path d="m20 20-6-6" />
    </g>
  </svg>
</template>
