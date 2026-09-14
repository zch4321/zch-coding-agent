import type { AttachmentService } from '../attachments/service'
import type { ProviderStreamContext } from '../providers/provider'
import type { ActiveRun, SessionState } from './session-types'
import { DomainError } from '../common/domain-error'

/** Binds provider input resolution to this session's project and this Run's working copies. */
export function sessionAttachmentContext(
  service: AttachmentService | undefined,
  session: SessionState,
  run: ActiveRun,
): ProviderStreamContext {
  const projectId = session.sessionTemp.projectId
  if (!service || !projectId) return { signal: run.controller.signal }
  return {
    signal: run.controller.signal,
    resolveImage: (attachment, signal) => {
      if (
        !session.history.some((record) =>
          record.parts.some(
            (part) =>
              part.type === 'image' && part.attachment.id === attachment.id,
          ),
        )
      )
        throw new DomainError(
          'NOT_FOUND',
          'Image is not attached to this session',
        )
      return service.resolveImage(projectId, attachment, signal)
    },
    resolveFile: async (attachment, signal) => {
      if (
        !session.history.some((record) =>
          record.parts.some(
            (part) =>
              part.type === 'file' && part.attachment.id === attachment.id,
          ),
        )
      )
        throw new DomainError(
          'NOT_FOUND',
          'File is not attached to this session',
        )
      run.attachmentFiles ??= new Map()
      const existing = run.attachmentFiles.get(attachment.id)
      if (existing) return existing
      const file = await service.materializeFile(
        projectId,
        attachment.id,
        session.sessionTemp.scratch,
        signal,
        run.runId,
      )
      run.attachmentFiles.set(attachment.id, file)
      return file
    },
  }
}
