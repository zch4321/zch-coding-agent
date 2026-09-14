import { Type } from '@sinclair/typebox'
import {
  AttachmentDraftKeySchema,
  AttachmentIdSchema,
  AttachmentIdsSchema,
  AttachmentSchema,
  ATTACHMENT_LIMITS,
} from '../attachments'
import { ProjectIdSchema } from '../ids'
import { AcceptedSchema, ipcResultSchema } from './common'

const version = { version: Type.Literal(1) }
const target = {
  ...version,
  projectId: ProjectIdSchema,
  draftKey: AttachmentDraftKeySchema,
}
const transfer = { ...version, transferId: AttachmentIdSchema }
const attachmentList = Type.Array(AttachmentSchema, {
  maxItems: ATTACHMENT_LIMITS.count,
})

export const ATTACHMENT_IPC_CONTRACTS = {
  'attachment:begin': {
    payload: Type.Object(
      {
        ...target,
        name: Type.String({ minLength: 1, maxLength: 255 }),
        mimeType: Type.String({ maxLength: 128 }),
        byteSize: Type.Integer({
          minimum: 0,
          maximum: ATTACHMENT_LIMITS.fileBytes,
        }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { transferId: AttachmentIdSchema },
        { additionalProperties: false },
      ),
    ),
  },
  'attachment:append': {
    payload: Type.Object(
      {
        ...transfer,
        offset: Type.Integer({
          minimum: 0,
          maximum: ATTACHMENT_LIMITS.fileBytes,
        }),
        data: Type.String({
          minLength: 1,
          maxLength: Math.ceil(ATTACHMENT_LIMITS.chunkBytes / 3) * 4,
        }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'attachment:finish': {
    payload: Type.Object(transfer, { additionalProperties: false }),
    result: ipcResultSchema(AttachmentSchema),
  },
  'attachment:cancel': {
    payload: Type.Object(transfer, { additionalProperties: false }),
    result: ipcResultSchema(AcceptedSchema),
  },
  'attachment:clipboard-files': {
    payload: Type.Object(
      { ...target, transferId: AttachmentIdSchema },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { attachments: attachmentList },
        { additionalProperties: false },
      ),
    ),
  },
  'attachment:get': {
    payload: Type.Object(
      { ...version, projectId: ProjectIdSchema, ids: AttachmentIdsSchema },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { attachments: attachmentList },
        { additionalProperties: false },
      ),
    ),
  },
  'attachment:sync-draft': {
    payload: Type.Object(
      { ...target, ids: AttachmentIdsSchema },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'attachment:reconcile-drafts': {
    payload: Type.Object(
      {
        ...version,
        projectId: ProjectIdSchema,
        drafts: Type.Array(
          Type.Object(
            { key: AttachmentDraftKeySchema, ids: AttachmentIdsSchema },
            { additionalProperties: false },
          ),
          { maxItems: 2000 },
        ),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
} as const
