import { defineStore } from 'pinia'
import { onScopeDispose, shallowReactive } from 'vue'
import { Value } from '@sinclair/typebox/value'
import {
  ContextAttachmentChipSchema,
  type ContextAttachmentChip,
} from '../../shared/context'
import type { ProjectId, SessionId } from '../../shared/ids'

export interface DraftTarget {
  projectId: ProjectId
  sessionId?: SessionId
}

export interface ComposerDraft {
  text: string
  attachments: ContextAttachmentChip[]
  revision: number
}

export interface DraftSnapshot extends ComposerDraft {
  target: DraftTarget
}

const STORAGE_PREFIX = 'composer-draft:'
const SAVE_DELAY = 300

/** Identifies each project's new composer separately from its durable Sessions. */
export function composerDraftKey(target: DraftTarget): string {
  return JSON.stringify([target.projectId, target.sessionId ?? '__new__'])
}

function targetFromKey(key: string): DraftTarget | undefined {
  try {
    const value: unknown = JSON.parse(key)
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((part) => typeof part === 'string' && part.length > 0)
    ) {
      return {
        projectId: value[0] as ProjectId,
        ...(value[1] === '__new__' ? {} : { sessionId: value[1] as SessionId }),
      }
    }
  } catch {
    /* Ignore unrelated or corrupt storage keys. */
  }
  return undefined
}

function attachmentCopies(
  attachments: ContextAttachmentChip[],
): ContextAttachmentChip[] {
  return attachments.map(({ kind, path, source }) => ({ kind, path, source }))
}

/** Owns unsent text and attachment references independently of backend replicas and run overlays. */
export const useComposerDraftsStore = defineStore('composer-drafts', () => {
  const entries = shallowReactive<Record<string, ComposerDraft>>({})
  const dirty = new Set<string>()
  const removedProjects = new Set<ProjectId>()
  const removedSessions = new Set<SessionId>()
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function removed(target: DraftTarget): boolean {
    return (
      removedProjects.has(target.projectId) ||
      Boolean(target.sessionId && removedSessions.has(target.sessionId))
    )
  }

  /** Loads one draft on demand without scanning or evicting other unsent work. */
  function get(target: DraftTarget): ComposerDraft {
    const key = composerDraftKey(target)
    if (entries[key]) return entries[key]
    let text = ''
    let attachments: ContextAttachmentChip[] = []
    if (!removed(target)) {
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + key)
        const value: unknown = raw ? JSON.parse(raw) : undefined
        if (
          value &&
          typeof value === 'object' &&
          'text' in value &&
          typeof value.text === 'string' &&
          'attachments' in value &&
          Array.isArray(value.attachments) &&
          value.attachments.every((item) =>
            Value.Check(ContextAttachmentChipSchema, item),
          )
        ) {
          text = value.text
          attachments = attachmentCopies(value.attachments)
        }
      } catch {
        /* Storage failures leave the in-memory composer available. */
      }
    }
    return (entries[key] = { text, attachments, revision: ++revision })
  }

  function schedule(key: string): void {
    dirty.add(key)
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DELAY)
  }

  /** Writes only changed drafts; failures retain dirty memory for a later flush. */
  function flush(): void {
    if (timer) clearTimeout(timer)
    timer = undefined
    for (const key of dirty) persist(key)
  }

  function persist(key: string): boolean {
    const entry = entries[key]
    try {
      if (!entry || (!entry.text && !entry.attachments.length)) {
        localStorage.removeItem(STORAGE_PREFIX + key)
      } else {
        localStorage.setItem(
          STORAGE_PREFIX + key,
          JSON.stringify({
            text: entry.text,
            attachments: entry.attachments,
          }),
        )
      }
      dirty.delete(key)
      return true
    } catch {
      /* Keep this draft dirty, without evicting another draft. */
      return false
    }
  }

  /** Replaces one draft and advances its revision even if text is later changed back. */
  function set(
    target: DraftTarget,
    text: string,
    attachments: ContextAttachmentChip[],
  ): void {
    if (removed(target)) return
    const key = composerDraftKey(target)
    entries[key] = {
      text,
      attachments: attachmentCopies(attachments),
      revision: ++revision,
    }
    schedule(key)
  }

  /** Updates text while retaining the same draft's attachment references. */
  function setText(target: DraftTarget, text: string): void {
    if (get(target).text !== text) set(target, text, get(target).attachments)
  }

  /** Captures the owner and revision before an asynchronous composer action starts. */
  function capture(target: DraftTarget): DraftSnapshot {
    const entry = get(target)
    return {
      ...entry,
      attachments: attachmentCopies(entry.attachments),
      target: { ...target },
    }
  }

  /** Applies an asynchronous replacement only if the user has not edited this draft meanwhile. */
  function replaceUnchanged(
    snapshot: DraftSnapshot,
    text: string,
    attachments: ContextAttachmentChip[],
  ): boolean {
    if (
      removed(snapshot.target) ||
      get(snapshot.target).revision !== snapshot.revision
    )
      return false
    set(snapshot.target, text, attachments)
    flush()
    return true
  }

  /** Transfers pending edits to a newly created Session without overwriting an existing draft. */
  function move(source: DraftTarget, destination: DraftTarget): void {
    if (removed(source) || removed(destination)) return
    const existing = get(destination)
    if (existing.text || existing.attachments.length) return
    const entry = get(source)
    set(destination, entry.text, entry.attachments)
    // Preserve the source on disk until the destination write has succeeded.
    if (!persist(composerDraftKey(destination))) return
    set(source, '', [])
    flush()
  }

  /** Adds selected references to their originating draft and deduplicates kind/path pairs. */
  function addAttachments(
    target: DraftTarget,
    attachments: ContextAttachmentChip[],
  ): void {
    const entry = get(target)
    const combined = [...entry.attachments, ...attachments].filter(
      (item, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.kind === item.kind && candidate.path === item.path,
        ) === index,
    )
    set(target, entry.text, combined)
  }

  function allKeys(): Set<string> {
    const keys = new Set(Object.keys(entries))
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith(STORAGE_PREFIX))
          keys.add(key.slice(STORAGE_PREFIX.length))
      }
    } catch {
      /* In-memory drafts can still be removed without storage access. */
    }
    return keys
  }

  /** Removes only an explicitly deleted Session, including a draft never loaded in this renderer. */
  function removeSession(projectId: ProjectId, sessionId: SessionId): void {
    removedSessions.add(sessionId)
    const key = composerDraftKey({ projectId, sessionId })
    delete entries[key]
    dirty.add(key)
    flush()
  }

  /** Prunes drafts by the complete Project list, never by a paginated Session list. */
  function retainProjects(projectIds: ProjectId[]): void {
    const available = new Set(projectIds)
    for (const key of allKeys()) {
      const target = targetFromKey(key)
      if (!target || available.has(target.projectId)) continue
      removedProjects.add(target.projectId)
      delete entries[key]
      dirty.add(key)
    }
    flush()
  }

  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  onScopeDispose(() => {
    flush()
    window.removeEventListener('pagehide', flush)
    window.removeEventListener('beforeunload', flush)
  })

  return {
    entries,
    get,
    set,
    setText,
    capture,
    replaceUnchanged,
    move,
    addAttachments,
    flush,
    removeSession,
    retainProjects,
  }
})
