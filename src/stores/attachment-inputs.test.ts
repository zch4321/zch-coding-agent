// @vitest-environment jsdom
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../shared/agent-api'
import type { Attachment } from '../../shared/attachments'
import type { ProjectId, SessionId } from '../../shared/ids'
import { useAttachmentInputsStore } from './attachment-inputs'
import { composerDraftKey, useComposerDraftsStore } from './composer-drafts'

let pinia: Pinia
const projectId = 'project:imports' as ProjectId
const a = { projectId, sessionId: 'session:a' as SessionId }
const b = { projectId, sessionId: 'session:b' as SessionId }
const asset: Attachment = {
  id: 'a'.repeat(32),
  kind: 'file',
  projectId,
  name: 'notes.txt',
  byteSize: 300000,
  mimeType: 'text/plain',
  sha256: 'a'.repeat(64),
}
const success = <T>(value: T) => ({
  version: 1 as const,
  ok: true as const,
  value,
})

beforeEach(() => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
})
afterEach(() => {
  disposePinia(pinia)
  vi.restoreAllMocks()
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: undefined,
  })
})

function installApi(override: Partial<AgentApi> = {}) {
  const api = {
    beginAttachmentImport: vi.fn(async () => success({ transferId: asset.id })),
    appendAttachmentChunk: vi.fn(async () =>
      success({ accepted: true as const }),
    ),
    finishAttachmentImport: vi.fn(async () => success(asset)),
    cancelAttachmentImport: vi.fn(async () =>
      success({ accepted: true as const }),
    ),
    syncAttachmentDraft: vi.fn(async () =>
      success({ accepted: true as const }),
    ),
    ...override,
  }
  Object.defineProperty(window, 'agentApi', {
    configurable: true,
    value: api as unknown as AgentApi,
  })
  return api
}

describe('draft-bound browser imports', () => {
  it('keeps chunk bodies out of Pinia/localStorage and applies late completion only to its source draft', async () => {
    let finish!: (result: ReturnType<typeof success<Attachment>>) => void
    const api = installApi({
      finishAttachmentImport: vi.fn(
        () =>
          new Promise<ReturnType<typeof success<Attachment>>>((resolve) => {
            finish = resolve
          }),
      ),
    })
    const drafts = useComposerDraftsStore()
    drafts.setText(a, 'Draft A')
    const imports = useAttachmentInputsStore()
    const running = imports.importFiles(a, [
      new File(['x'.repeat(300000)], 'notes.txt', { type: 'text/plain' }),
    ])
    expect(imports.pending(a)).toHaveLength(1)
    expect(imports.pending(b)).toHaveLength(0)
    drafts.setText(b, 'Draft B')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish(success(asset))
    await running
    expect(api.appendAttachmentChunk).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.appendAttachmentChunk).mock.calls[0]).toEqual([
      expect.objectContaining({ offset: 0 }),
    ])
    expect(drafts.get(a).assets).toEqual([asset])
    expect(drafts.get(b)).toMatchObject({ text: 'Draft B', assets: [] })
    const persisted = localStorage.getItem(
      'composer-draft:' + composerDraftKey(a),
    )!
    expect(persisted.length).toBeLessThan(1500)
    expect(JSON.stringify(imports.$state)).not.toContain('eHh4')
    disposePinia(pinia)
    pinia = createPinia()
    setActivePinia(pinia)
    expect(useComposerDraftsStore().get(a).assets).toEqual([asset])
  })

  it('cancels a queued import without adding an asset and preserves failed drafts', async () => {
    let begin!: (
      value: ReturnType<typeof success<{ transferId: string }>>,
    ) => void
    const api = installApi({
      beginAttachmentImport: vi.fn(
        () =>
          new Promise<ReturnType<typeof success<{ transferId: string }>>>(
            (resolve) => {
              begin = resolve
            },
          ),
      ),
    })
    const imports = useAttachmentInputsStore()
    const drafts = useComposerDraftsStore()
    drafts.setText(a, 'Keep me')
    const running = imports.importFiles(a, [new File(['file'], 'notes.txt')])
    await imports.cancel(imports.pending(a)[0].id)
    begin(success({ transferId: asset.id }))
    await running
    expect(api.cancelAttachmentImport).toHaveBeenCalled()
    expect(drafts.get(a)).toMatchObject({ text: 'Keep me', assets: [] })
    expect(imports.pending(a)).toHaveLength(0)
  })

  it('forwards clipboard cancellation to its backend batch and keeps the original text', async () => {
    let complete!: (
      value: ReturnType<typeof success<{ attachments: Attachment[] }>>,
    ) => void
    const api = installApi({
      importClipboardFiles: vi.fn(
        () =>
          new Promise<
            ReturnType<typeof success<{ attachments: Attachment[] }>>
          >((resolve) => {
            complete = resolve
          }),
      ),
    })
    const drafts = useComposerDraftsStore()
    drafts.setText(a, 'Keep clipboard draft')
    const imports = useAttachmentInputsStore()
    const running = imports.importClipboard(a)
    const job = imports.pending(a)[0]
    expect(job.transferId).toMatch(/^[a-f0-9]{32}$/u)
    await imports.cancel(job.id)
    expect(api.cancelAttachmentImport).toHaveBeenCalledWith({
      version: 1,
      transferId: job.transferId,
    })
    complete(success({ attachments: [asset] }))
    await running
    expect(drafts.get(a)).toMatchObject({
      text: 'Keep clipboard draft',
      assets: [],
    })
  })

  it('rejects a completed import after its Session is deleted and preserves existing files on import failure', async () => {
    let finish!: (result: ReturnType<typeof success<Attachment>>) => void
    const api = installApi({
      finishAttachmentImport: vi.fn(
        () =>
          new Promise<ReturnType<typeof success<Attachment>>>((resolve) => {
            finish = resolve
          }),
      ),
    })
    const drafts = useComposerDraftsStore()
    const imports = useAttachmentInputsStore()
    const running = imports.importFiles(a, [new File(['file'], 'notes.txt')])
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    drafts.removeSession(projectId, a.sessionId)
    finish(success(asset))
    await running
    expect(drafts.get(a).assets).toEqual([])
    expect(api.syncAttachmentDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ ids: [] }),
    )
  })
})
