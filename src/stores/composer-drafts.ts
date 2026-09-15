import { defineStore } from 'pinia'
import { onScopeDispose, shallowReactive } from 'vue'
import { Value } from '@sinclair/typebox/value'
import {
  ContextAttachmentChipSchema,
  type ContextAttachmentChip,
} from '../../shared/context'
import type { ProjectId, SessionId } from '../../shared/ids'
import {
  AttachmentSchema,
  assertAttachmentLimits,
  type Attachment,
} from '../../shared/attachments'
import { appendMissingContextReferences } from '../context-references'

export interface DraftTarget {
  projectId: ProjectId
  sessionId?: SessionId
}

export interface ComposerDraft {
  text: string
  assets: Attachment[]
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

/** Owns unsent text and attachment references independently of backend replicas and run overlays. */
export const useComposerDraftsStore = defineStore('composer-drafts', () => {
  const entries = shallowReactive<Record<string, ComposerDraft>>({})
  const dirty = new Set<string>()
  const removedProjects = new Set<ProjectId>()
  const removedSessions = new Set<SessionId>()
  let revision = 0
  let referenceSync: Promise<unknown> = Promise.resolve()
  const reconciledProjects = new Set<ProjectId>()
  const dirtyReferences = new Set<string>()
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
    let migrated = false
    let assets: Attachment[] = []
    if (!removed(target)) {
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + key)
        const value: unknown = raw ? JSON.parse(raw) : undefined
        if (
          value &&
          typeof value === 'object' &&
          'text' in value &&
          typeof value.text === 'string'
        ) {
          text = value.text
          if ('attachments' in value && Array.isArray(value.attachments)) {
            text = appendMissingContextReferences(
              text,
              value.attachments.filter((item) =>
                Value.Check(ContextAttachmentChipSchema, item),
              ),
            )
            migrated = true
          }
          if (
            'assets' in value &&
            Array.isArray(value.assets) &&
            value.assets.every(
              (asset) =>
                Value.Check(AttachmentSchema, asset) &&
                asset.projectId === target.projectId,
            )
          )
            assets = structuredClone(value.assets)
        }
      } catch {
        /* Storage failures leave the in-memory composer available. */
      }
    }
    const entry = (entries[key] = { text, assets, revision: ++revision })
    if (migrated) schedule(key)
    return entry
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
      if (!entry || (!entry.text && !entry.assets.length)) {
        localStorage.removeItem(STORAGE_PREFIX + key)
      } else {
        localStorage.setItem(
          STORAGE_PREFIX + key,
          JSON.stringify({
            text: entry.text,
            assets: entry.assets,
          }),
        )
      }
      dirty.delete(key)
      if (dirtyReferences.delete(key)) syncReferences(key, entry?.assets ?? [])
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
    assets: Attachment[] = get(target).assets,
  ): void {
    if (removed(target)) return
    const key = composerDraftKey(target)
    entries[key] = {
      text,
      assets: assets.map((asset) => ({ ...asset })),
      revision: ++revision,
    }
    schedule(key)
  }

  function syncReferences(key: string, assets: Attachment[]): void {
    const target = targetFromKey(key)
    if (!target || !window.agentApi?.syncAttachmentDraft) return
    const ids = assets.map((asset) => asset.id)
    referenceSync = referenceSync
      .then(async () => {
        const result = await window.agentApi!.syncAttachmentDraft({
          version: 1,
          projectId: target.projectId,
          draftKey: key,
          ids,
        })
        if (!result.ok) dirtyReferences.add(key)
      })
      .catch(() => {
        dirtyReferences.add(key)
      })
  }

  /** Replaces imported asset references without moving their ownership into the backend replica. */
  function setAssets(target: DraftTarget, assets: Attachment[]): boolean {
    if (removed(target)) return false
    assertAttachmentLimits(assets)
    if (assets.some((asset) => asset.projectId !== target.projectId))
      throw new Error('Attachment belongs to another project')
    const entry = get(target)
    set(target, entry.text, assets)
    dirtyReferences.add(composerDraftKey(target))
    flush()
    return true
  }

  /** Adds completed imports to the draft that initiated them, preserving later text edits. */
  function addAssets(target: DraftTarget, assets: Attachment[]): boolean {
    const combined = [
      ...new Map(
        [...get(target).assets, ...assets].map((asset) => [asset.id, asset]),
      ).values(),
    ]
    return setAssets(target, combined)
  }

  /** Updates text while retaining the same draft's attachment references. */
  function setText(target: DraftTarget, text: string): void {
    if (get(target).text !== text) set(target, text)
  }

  /** Captures the owner and revision before an asynchronous composer action starts. */
  function capture(target: DraftTarget): DraftSnapshot {
    const entry = get(target)
    return {
      ...entry,
      assets: entry.assets.map((asset) => ({ ...asset })),
      target: { ...target },
    }
  }

  /** Applies an asynchronous replacement only if the user has not edited this draft meanwhile. */
  function replaceUnchanged(
    snapshot: DraftSnapshot,
    text: string,
    assets: Attachment[] = snapshot.assets,
  ): boolean {
    if (
      removed(snapshot.target) ||
      get(snapshot.target).revision !== snapshot.revision
    )
      return false
    set(snapshot.target, text, assets)
    dirtyReferences.add(composerDraftKey(snapshot.target))
    flush()
    return true
  }

  /** Transfers pending edits to a newly created Session without overwriting an existing draft. */
  function move(source: DraftTarget, destination: DraftTarget): void {
    if (removed(source) || removed(destination)) return
    const existing = get(destination)
    if (existing.text || existing.assets.length) return
    const entry = get(source)
    set(destination, entry.text, entry.assets)
    dirtyReferences.add(composerDraftKey(destination))
    // Preserve the source on disk until the destination write has succeeded.
    if (!persist(composerDraftKey(destination))) return
    set(source, '', [])
    dirtyReferences.add(composerDraftKey(source))
    flush()
  }

  /** Appends missing workspace references as text in their originating draft. */
  function addAttachments(
    target: DraftTarget,
    attachments: ContextAttachmentChip[],
  ): void {
    const entry = get(target)
    setText(target, appendMissingContextReferences(entry.text, attachments))
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
    dirtyReferences.add(key)
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
    for (const projectId of projectIds) {
      if (
        reconciledProjects.has(projectId) ||
        !window.agentApi?.reconcileAttachmentDrafts
      )
        continue
      reconciledProjects.add(projectId)
      referenceSync = referenceSync
        .then(async () => {
          const drafts = [...allKeys()].flatMap((key) => {
            const target = targetFromKey(key)
            return target?.projectId === projectId
              ? [{ key, ids: get(target).assets.map((asset) => asset.id) }]
              : []
          })
          const result = await window.agentApi!.reconcileAttachmentDrafts({
            version: 1,
            projectId,
            drafts,
          })
          if (!result.ok) reconciledProjects.delete(projectId)
        })
        .catch(() => {
          reconciledProjects.delete(projectId)
        })
    }
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
    setAssets,
    addAssets,
    flush,
    removeSession,
    retainProjects,
  }
})
