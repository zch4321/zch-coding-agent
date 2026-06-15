import type { IpcMainInvokeEvent, WebContents } from 'electron'

export type SenderValidationResult =
  | { valid: true }
  | { valid: false; reason: string }

export function validateIpcSender(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  trustedWebContents: WebContents | undefined,
  isAllowedUrl: (url: string) => boolean,
): SenderValidationResult {
  if (!trustedWebContents || event.sender !== trustedWebContents) {
    return { valid: false, reason: 'IPC sender is not the trusted window' }
  }

  if (!event.senderFrame) {
    return { valid: false, reason: 'IPC sender frame is unavailable' }
  }

  if (event.senderFrame !== event.sender.mainFrame) {
    return {
      valid: false,
      reason: 'IPC calls are only accepted from the main frame',
    }
  }

  if (!isAllowedUrl(event.senderFrame.url)) {
    return { valid: false, reason: 'IPC sender origin is not allowed' }
  }

  return { valid: true }
}
