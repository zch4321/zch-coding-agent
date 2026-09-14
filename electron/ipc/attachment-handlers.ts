import type { AttachmentService } from '../attachments/service'
import { readWindowsClipboardFiles } from '../attachments/windows-clipboard'
import {
  ATTACHMENT_LIMITS,
  assertAttachmentLimits,
  type Attachment,
} from '../../shared/attachments'
import type { IpcBusinessHandlers } from './index'
import { DomainError } from '../common/domain-error'

/** Adapts validated attachment commands and the host file clipboard to backend storage. */
export function createAttachmentHandlers(
  attachments: AttachmentService,
): IpcBusinessHandlers {
  const clipboardImports = new Map<
    string,
    {
      controller: AbortController
      done: Promise<{ attachments: Attachment[] }>
    }
  >()
  return {
    'attachment:begin': async (input) => ({
      transferId: await attachments.begin(input),
    }),
    'attachment:append': async (input) => {
      await attachments.append(input.transferId, input.offset, input.data)
      return { accepted: true }
    },
    'attachment:finish': (input) => attachments.finish(input.transferId),
    'attachment:cancel': async (input) => {
      const clipboard = clipboardImports.get(input.transferId)
      if (clipboard) {
        clipboard.controller.abort()
        await clipboard.done.catch(() => undefined)
      }
      await attachments.cancel(input.transferId)
      return { accepted: true }
    },
    'attachment:get': (input) => ({
      attachments: attachments.getMany(input.projectId, input.ids),
    }),
    'attachment:sync-draft': async (input) => {
      await attachments.syncDraft(input.projectId, input.draftKey, input.ids)
      return { accepted: true }
    },
    'attachment:reconcile-drafts': async (input) => {
      await attachments.reconcileDrafts(input.projectId, input.drafts)
      return { accepted: true }
    },
    'attachment:clipboard-files': async (input) => {
      if (process.platform !== 'win32') return { attachments: [] }
      if (
        clipboardImports.has(input.transferId) ||
        clipboardImports.size >= ATTACHMENT_LIMITS.count
      )
        throw new DomainError(
          'PRECONDITION_FAILED',
          'Clipboard import is already pending',
        )
      const controller = new AbortController()
      const done = Promise.resolve().then(async () => {
        const imported: Attachment[] = []
        for (const file of await readWindowsClipboardFiles(controller.signal)) {
          controller.signal.throwIfAborted()
          const attachment = await attachments.importLocalFile(
            input,
            file,
            controller.signal,
          )
          imported.push(attachment)
          assertAttachmentLimits(imported)
        }
        controller.signal.throwIfAborted()
        return { attachments: imported }
      })
      clipboardImports.set(input.transferId, { controller, done })
      try {
        return await done
      } finally {
        clipboardImports.delete(input.transferId)
      }
    },
  }
}
