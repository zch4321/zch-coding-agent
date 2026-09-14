import { defineStore } from 'pinia'
import { shallowReactive } from 'vue'
import { ATTACHMENT_LIMITS, type Attachment } from '../../shared/attachments'
import {
  composerDraftKey,
  useComposerDraftsStore,
  type DraftTarget,
} from './composer-drafts'
import { useNotificationStore } from './notifications'

export interface AttachmentImportJob {
  id: string
  target: DraftTarget
  name: string
  progress: number
  cancelled: boolean
  transferId?: string
}

/** Tracks import progress by draft; binary chunks and browser Files never enter Pinia or localStorage. */
export const useAttachmentInputsStore = defineStore('attachment-inputs', () => {
  const jobs = shallowReactive<Record<string, AttachmentImportJob>>({})
  const drafts = useComposerDraftsStore()

  /** Lists imports belonging to an exact composer, including a project's new-session placeholder. */
  function pending(target: DraftTarget): AttachmentImportJob[] {
    const key = composerDraftKey(target)
    return Object.values(jobs).filter(
      (job) => composerDraftKey(job.target) === key,
    )
  }

  function fail(error: unknown): void {
    useNotificationStore().error({
      code: 'ATTACHMENT_IMPORT_FAILED',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  function update(id: string, patch: Partial<AttachmentImportJob>): void {
    if (jobs[id]) jobs[id] = { ...jobs[id], ...patch }
  }

  /** Imports a browser selection sequentially, retaining every successful file in its source draft. */
  async function importFiles(
    target: DraftTarget,
    files: readonly File[],
  ): Promise<void> {
    const bridge = window.agentApi
    if (!bridge || !files.length) return
    const assets = drafts.get(target).assets
    if (
      pending(target).length ||
      files.length + assets.length > ATTACHMENT_LIMITS.count ||
      files.reduce(
        (sum, file) => sum + file.size,
        assets.reduce((sum, asset) => sum + asset.byteSize, 0),
      ) > ATTACHMENT_LIMITS.messageBytes ||
      files.some((file) => file.size > ATTACHMENT_LIMITS.fileBytes)
    ) {
      fail(new Error('Attachment count or size exceeds the import limit'))
      return
    }
    const batch = files.map((file) => {
      const id = crypto.randomUUID()
      jobs[id] = {
        id,
        target: { ...target },
        name: file.name || 'image.png',
        progress: 0,
        cancelled: false,
      }
      return { id, file }
    })
    for (const { id, file } of batch) {
      let transferId: string | undefined
      try {
        if (jobs[id]?.cancelled) continue
        const start = await bridge.beginAttachmentImport({
          version: 1,
          projectId: target.projectId,
          draftKey: composerDraftKey(target),
          name: file.name || 'image.png',
          mimeType: file.type,
          byteSize: file.size,
        })
        if (!start.ok) throw new Error(start.error.message)
        transferId = start.value.transferId
        update(id, { transferId })
        for (
          let offset = 0;
          offset < file.size;
          offset += ATTACHMENT_LIMITS.chunkBytes
        ) {
          if (jobs[id]?.cancelled) break
          const data = await blobBase64(
            file.slice(offset, offset + ATTACHMENT_LIMITS.chunkBytes),
          )
          const chunk = await bridge.appendAttachmentChunk({
            version: 1,
            transferId,
            offset,
            data,
          })
          if (!chunk.ok) throw new Error(chunk.error.message)
          update(id, {
            progress: Math.min(
              99,
              Math.round(
                ((offset + ATTACHMENT_LIMITS.chunkBytes) / file.size) * 100,
              ),
            ),
          })
        }
        if (jobs[id]?.cancelled) {
          await bridge.cancelAttachmentImport({ version: 1, transferId })
          continue
        }
        const completed = await bridge.finishAttachmentImport({
          version: 1,
          transferId,
        })
        if (!completed.ok) throw new Error(completed.error.message)
        if (!jobs[id]?.cancelled) drafts.addAssets(target, [completed.value])
      } catch (error) {
        if (transferId)
          await bridge
            .cancelAttachmentImport({ version: 1, transferId })
            .catch(() => undefined)
        if (!jobs[id]?.cancelled) fail(error)
      } finally {
        delete jobs[id]
      }
    }
    await bridge
      .syncAttachmentDraft({
        version: 1,
        projectId: target.projectId,
        draftKey: composerDraftKey(target),
        ids: drafts.get(target).assets.map((asset) => asset.id),
      })
      .catch(() => undefined)
  }

  /** Imports an Explorer file-drop list when the DOM clipboard has no usable browser Files. */
  async function importClipboard(target: DraftTarget): Promise<void> {
    if (!window.agentApi || pending(target).length) return
    const id = crypto.randomUUID().replaceAll('-', '')
    jobs[id] = {
      id,
      target: { ...target },
      name: '',
      progress: 0,
      cancelled: false,
      transferId: id,
    }
    try {
      const result = await window.agentApi.importClipboardFiles({
        version: 1,
        transferId: id,
        projectId: target.projectId,
        draftKey: composerDraftKey(target),
      })
      if (!result.ok) throw new Error(result.error.message)
      if (!jobs[id]?.cancelled)
        drafts.addAssets(target, result.value.attachments)
    } catch (error) {
      if (!jobs[id]?.cancelled) fail(error)
    } finally {
      delete jobs[id]
    }
    await window.agentApi
      .syncAttachmentDraft({
        version: 1,
        projectId: target.projectId,
        draftKey: composerDraftKey(target),
        ids: drafts.get(target).assets.map((asset) => asset.id),
      })
      .catch(() => undefined)
  }

  /** Cancels a pending job without changing any other draft's text or attachments. */
  async function cancel(id: string): Promise<void> {
    const job = jobs[id]
    if (!job) return
    update(id, { cancelled: true })
    if (job.transferId)
      await window.agentApi?.cancelAttachmentImport({
        version: 1,
        transferId: job.transferId,
      })
  }

  /** Reattaches an existing immutable snapshot after checking that it still belongs to the project. */
  async function reattach(
    target: DraftTarget,
    attachment: Attachment,
  ): Promise<void> {
    if (!window.agentApi) return
    try {
      const result = await window.agentApi.getAttachments({
        version: 1,
        projectId: target.projectId,
        ids: [attachment.id],
      })
      if (!result.ok) throw new Error(result.error.message)
      drafts.addAssets(target, result.value.attachments)
    } catch (error) {
      fail(error)
    }
  }

  return { jobs, pending, importFiles, importClipboard, cancel, reattach }
})

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () =>
      reject(reader.error ?? new Error('File could not be read'))
    reader.readAsDataURL(blob)
  })
}
