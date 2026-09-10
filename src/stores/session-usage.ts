import { defineStore } from 'pinia'
import { ref } from 'vue'
import { Value } from '@sinclair/typebox/value'
import type { SessionId } from '../../shared/ids'
import {
  SessionUsageSnapshotSchema,
  type SessionUsageSnapshot,
} from '../../shared/session-usage'

const CACHE_KEY = 'session-usage'
const MAX_CACHED_SESSIONS = 20
const MAX_CACHE_LENGTH = 1_000_000

/** Keeps replaceable display summaries separate from runtime overlays and durable replicas. */
export const useSessionUsageStore = defineStore('session-usage', () => {
  const snapshots = ref<Record<string, SessionUsageSnapshot>>({})
  const loading = ref<Record<string, boolean>>({})
  const pending = new Map<SessionId, Promise<void>>()
  const dirty = new Set<SessionId>()
  const generations = new Map<SessionId, number>()
  let restored = false

  /** Restores a bounded cache of numeric summaries; corrupt cache data is discarded. */
  function restore(): void {
    if (restored) return
    restored = true
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw || raw.length > MAX_CACHE_LENGTH) return
      const entries: unknown = JSON.parse(raw)
      if (!Array.isArray(entries)) return
      for (const entry of entries.slice(-MAX_CACHED_SESSIONS)) {
        if (Value.Check(SessionUsageSnapshotSchema, entry))
          snapshots.value[entry.sessionId] = entry
      }
    } catch {
      /* Cache availability never prevents backend refresh. */
    }
  }

  function persist(): void {
    try {
      const entries = Object.values(snapshots.value)
        .slice(-MAX_CACHED_SESSIONS)
        .map((snapshot) => ({
          ...snapshot,
          context: snapshot.context
            ? {
                ...snapshot.context,
                categories: snapshot.context.categories.map((group) => ({
                  ...group,
                  entries: [],
                })),
              }
            : null,
          all: compactSummary(snapshot.all),
          currentRun: snapshot.currentRun
            ? {
                ...snapshot.currentRun,
                summary: compactSummary(snapshot.currentRun.summary),
              }
            : null,
        }))
      let raw = JSON.stringify(entries)
      while (raw.length > MAX_CACHE_LENGTH && entries.length) {
        entries.shift()
        raw = JSON.stringify(entries)
      }
      localStorage.setItem(CACHE_KEY, raw)
    } catch {
      /* The in-memory snapshot remains usable if storage is unavailable. */
    }
  }

  /** Coalesces invalidations and re-queries when a commit arrives during an outstanding read. */
  function refresh(sessionId: SessionId): Promise<void> {
    restore()
    const api = window.agentApi
    if (!api?.getSessionUsage) return Promise.resolve()
    dirty.add(sessionId)
    const existing = pending.get(sessionId)
    if (existing) return existing
    const generation = generations.get(sessionId) ?? 0
    const work = async () => {
      loading.value[sessionId] = true
      try {
        do {
          dirty.delete(sessionId)
          try {
            const result = await api.getSessionUsage({ version: 1, sessionId })
            if (generation !== (generations.get(sessionId) ?? 0)) return
            if (result.ok && result.value.sessionId === sessionId) {
              delete snapshots.value[sessionId]
              snapshots.value[sessionId] = result.value
              const keys = Object.keys(snapshots.value)
              for (const key of keys.slice(0, -MAX_CACHED_SESSIONS))
                delete snapshots.value[key]
              persist()
            } else if (!result.ok && result.error.code === 'NOT_FOUND') {
              remove(sessionId)
              return
            }
          } catch {
            /* Keep the last display until the next refresh succeeds. */
          }
        } while (dirty.has(sessionId))
      } finally {
        delete loading.value[sessionId]
        pending.delete(sessionId)
      }
    }
    const promise = work()
    pending.set(sessionId, promise)
    return promise
  }

  /** Removes a deleted Session and prevents an older response from resurrecting its cache. */
  function remove(sessionId: SessionId): void {
    generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1)
    dirty.delete(sessionId)
    delete snapshots.value[sessionId]
    persist()
  }

  return { snapshots, loading, restore, refresh, remove }
})

function compactSummary(
  summary: SessionUsageSnapshot['all'],
): SessionUsageSnapshot['all'] {
  return {
    totals: summary.totals,
    scopes: summary.scopes.map((group) => ({
      ...group,
      models: [],
      tasks: [],
    })),
  }
}
