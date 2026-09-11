// @vitest-environment jsdom

import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectId, SessionId } from '../../shared/ids'
import {
  composerDraftKey,
  useComposerDraftsStore,
  type DraftTarget,
} from './composer-drafts'

const projectId = 'project:drafts' as ProjectId
const otherProjectId = 'project:other' as ProjectId
const target: DraftTarget = { projectId, sessionId: 'session:a' as SessionId }
const attachment = {
  kind: 'file' as const,
  path: 'notes.md',
  source: 'picker' as const,
}
let pinia: Pinia

function restart(): ReturnType<typeof useComposerDraftsStore> {
  disposePinia(pinia)
  pinia = createPinia()
  setActivePinia(pinia)
  return useComposerDraftsStore()
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  pinia = createPinia()
  setActivePinia(pinia)
})
afterEach(() => {
  disposePinia(pinia)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('independent composer drafts', () => {
  it('restores each Session and each project placeholder without persisting attachment bodies or estimates', () => {
    const drafts = useComposerDraftsStore()
    drafts.set(target, '会话正文', [
      { ...attachment, totalBytes: 500, truncated: true },
    ])
    drafts.setText({ projectId }, '新会话一')
    drafts.setText({ projectId: otherProjectId }, '新会话二')
    const restored = restart()
    expect(restored.get(target)).toMatchObject({
      text: '会话正文',
      attachments: [attachment],
    })
    expect(restored.get({ projectId }).text).toBe('新会话一')
    expect(restored.get({ projectId: otherProjectId }).text).toBe('新会话二')
    expect(
      JSON.parse(
        localStorage.getItem('composer-draft:' + composerDraftKey(target))!,
      ),
    ).toEqual({ text: '会话正文', attachments: [attachment] })
  })

  it('coalesces keystrokes and writes only the changed draft', () => {
    const drafts = useComposerDraftsStore()
    drafts.setText({ projectId }, 'other unsent work')
    drafts.flush()
    const writes = vi.spyOn(Storage.prototype, 'setItem')
    for (let i = 0; i < 100; i++) drafts.setText(target, `text ${i}`)
    expect(writes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(writes.mock.calls[0]![0]).toBe(
      'composer-draft:' + composerDraftKey(target),
    )
  })

  it.each(['pagehide', 'beforeunload'])(
    'flushes edits immediately on %s',
    (event) => {
      useComposerDraftsStore().setText(target, 'last keystroke')
      window.dispatchEvent(new Event(event))
      expect(
        localStorage.getItem('composer-draft:' + composerDraftKey(target)),
      ).toContain('last keystroke')
    },
  )

  it('retains more than twenty unsent drafts and attachments-only drafts', () => {
    const drafts = useComposerDraftsStore()
    for (let i = 0; i < 30; i++)
      drafts.setText(
        { projectId, sessionId: `session:${i}` as SessionId },
        `draft ${i}`,
      )
    drafts.set(target, '', [attachment])
    const restored = restart()
    expect(localStorage.length).toBe(31)
    expect(
      restored.get({ projectId, sessionId: 'session:0' as SessionId }).text,
    ).toBe('draft 0')
    expect(restored.get(target).attachments).toEqual([attachment])
  })

  it('rejects stale replacements even when edited text was changed back', () => {
    const drafts = useComposerDraftsStore()
    drafts.setText(target, 'sent text')
    const snapshot = drafts.capture(target)
    drafts.setText(target, 'next text')
    drafts.setText(target, 'sent text')
    expect(drafts.replaceUnchanged(snapshot, '', [])).toBe(false)
    expect(drafts.get(target).text).toBe('sent text')
    expect(drafts.replaceUnchanged(drafts.capture(target), '', [])).toBe(true)
    expect(
      localStorage.getItem('composer-draft:' + composerDraftKey(target)),
    ).toBeNull()
  })

  it('does not overwrite an existing destination during new-session handoff', () => {
    const drafts = useComposerDraftsStore()
    drafts.setText({ projectId }, 'typed in new view')
    drafts.setText(target, 'typed after selecting the created session')
    drafts.move({ projectId }, target)
    expect(drafts.get(target).text).toBe(
      'typed after selecting the created session',
    )
    expect(drafts.get({ projectId }).text).toBe('typed in new view')
  })

  it('keeps the original draft if storage rejects the new-session handoff', () => {
    const drafts = useComposerDraftsStore()
    drafts.setText({ projectId }, 'pending edits')
    drafts.flush()
    const key = 'composer-draft:' + composerDraftKey({ projectId })
    const original = localStorage.getItem(key)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    drafts.move({ projectId }, target)
    expect(localStorage.getItem(key)).toBe(original)
    expect(drafts.get({ projectId }).text).toBe('pending edits')
    expect(drafts.get(target).text).toBe('pending edits')
  })

  it('cleans unloaded drafts only for confirmed Session or Project deletion and blocks late writes', () => {
    let drafts = useComposerDraftsStore()
    drafts.setText(target, 'deleted session')
    drafts.setText({ projectId }, 'deleted project placeholder')
    drafts.setText({ projectId: otherProjectId }, 'keep me')
    drafts = restart()
    const snapshot = drafts.capture(target)
    drafts.removeSession(projectId, target.sessionId!)
    expect(drafts.replaceUnchanged(snapshot, 'late edit', [])).toBe(false)
    drafts.retainProjects([otherProjectId])
    drafts.addAttachments({ projectId }, [attachment])
    const restored = restart()
    expect(restored.get(target).text).toBe('')
    expect(restored.get({ projectId }).attachments).toEqual([])
    expect(restored.get({ projectId: otherProjectId }).text).toBe('keep me')
  })

  it('tolerates corrupt entries and retries dirty writes after a storage failure', () => {
    const key = 'composer-draft:' + composerDraftKey(target)
    localStorage.setItem(key, '{invalid')
    const drafts = useComposerDraftsStore()
    expect(drafts.get(target).text).toBe('')
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      })
    drafts.setText(target, 'keep in memory')
    expect(() => drafts.flush()).not.toThrow()
    expect(drafts.get(target).text).toBe('keep in memory')
    drafts.flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem(key)!).text).toBe('keep in memory')
  })
})
