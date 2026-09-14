import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { ProjectId } from '../../shared/ids'
import type { AttachmentService } from '../attachments/service'
import { createAttachmentHandlers } from './attachment-handlers'

const { readClipboard } = vi.hoisted(() => ({ readClipboard: vi.fn() }))
vi.mock('../attachments/windows-clipboard', () => ({
  readWindowsClipboardFiles: readClipboard,
}))

afterEach(() => vi.resetAllMocks())

describe.skipIf(process.platform !== 'win32')(
  'native clipboard import IPC',
  () => {
    it('cancels clipboard acquisition before any local file import starts', async () => {
      const importLocalFile = vi.fn()
      const cancel = vi.fn()
      const handlers = createAttachmentHandlers({
        importLocalFile,
        cancel,
      } as unknown as AttachmentService)
      const event = {} as IpcMainInvokeEvent
      const input = {
        version: 1 as const,
        projectId: 'project:clipboard' as ProjectId,
        draftKey: 'draft',
        transferId: 'a'.repeat(32),
      }
      readClipboard.mockImplementation(
        (signal: AbortSignal) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          }),
      )
      const running = handlers['attachment:clipboard-files']!(input, event)
      const rejected = expect(running).rejects.toThrow()
      await vi.waitFor(() => expect(readClipboard).toHaveBeenCalledOnce())
      await handlers['attachment:cancel']!(
        { version: 1, transferId: input.transferId },
        event,
      )
      await rejected
      expect(readClipboard.mock.calls[0][0].aborted).toBe(true)
      expect(importLocalFile).not.toHaveBeenCalled()
      readClipboard.mockResolvedValue([])
      await expect(
        handlers['attachment:clipboard-files']!(input, event),
      ).resolves.toEqual({ attachments: [] })
    })

    it('shares the batch abort signal with local imports and stops before the next file', async () => {
      let signal!: AbortSignal
      const importLocalFile = vi.fn((_input, _file, incoming: AbortSignal) => {
        signal = incoming
        return new Promise((_, reject) =>
          incoming.addEventListener('abort', () => reject(incoming.reason), {
            once: true,
          }),
        )
      })
      const handlers = createAttachmentHandlers({
        importLocalFile,
        cancel: vi.fn(),
      } as unknown as AttachmentService)
      const event = {} as IpcMainInvokeEvent
      const input = {
        version: 1 as const,
        projectId: 'project:clipboard' as ProjectId,
        draftKey: 'draft',
        transferId: 'b'.repeat(32),
      }
      readClipboard.mockResolvedValue(['C:\\one.txt', 'C:\\two.txt'])
      const running = handlers['attachment:clipboard-files']!(input, event)
      const rejected = expect(running).rejects.toThrow()
      await vi.waitFor(() => expect(importLocalFile).toHaveBeenCalledOnce())
      await handlers['attachment:cancel']!(
        { version: 1, transferId: input.transferId },
        event,
      )
      await rejected
      expect(signal.aborted).toBe(true)
      expect(importLocalFile).toHaveBeenCalledOnce()
    })
  },
)
