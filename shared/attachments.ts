import { Type, type Static } from '@sinclair/typebox'
import { ProjectIdSchema } from './ids'
import { Sha256Schema } from './durable'

export const ATTACHMENT_LIMITS = Object.freeze({
  count: 16,
  images: 8,
  imageBytes: 20 * 1024 * 1024,
  fileBytes: 50 * 1024 * 1024,
  messageBytes: 100 * 1024 * 1024,
  chunkBytes: 256 * 1024,
  imageRequestBytes: 2 * 1024 * 1024,
  requestImageBytes: 16 * 1024 * 1024,
  imageLongEdge: 2048,
})

export const AttachmentIdSchema = Type.String({
  pattern: '^[a-f0-9]{32}$',
  minLength: 32,
  maxLength: 32,
})
export const AttachmentIdsSchema = Type.Array(AttachmentIdSchema, {
  maxItems: ATTACHMENT_LIMITS.count,
  uniqueItems: true,
})
export const AttachmentDraftKeySchema = Type.String({
  minLength: 1,
  maxLength: 512,
})

const attachmentProperties = {
  id: AttachmentIdSchema,
  projectId: ProjectIdSchema,
  name: Type.String({ minLength: 1, maxLength: 255 }),
  mimeType: Type.String({ minLength: 1, maxLength: 128 }),
  byteSize: Type.Integer({ minimum: 0, maximum: ATTACHMENT_LIMITS.fileBytes }),
  sha256: Sha256Schema,
}
export const FileAttachmentSchema = Type.Object(
  {
    ...attachmentProperties,
    kind: Type.Literal('file'),
  },
  { additionalProperties: false },
)
export const ImageAttachmentSchema = Type.Object(
  {
    ...attachmentProperties,
    kind: Type.Literal('image'),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    requestMimeType: Type.Literal('image/jpeg'),
    requestBytes: Type.Integer({
      minimum: 1,
      maximum: ATTACHMENT_LIMITS.imageRequestBytes,
    }),
    requestSha256: Sha256Schema,
  },
  { additionalProperties: false },
)
export const AttachmentSchema = Type.Union([
  FileAttachmentSchema,
  ImageAttachmentSchema,
])
export type Attachment = Static<typeof AttachmentSchema>
export type ImageAttachment = Static<typeof ImageAttachmentSchema>

export const ImagePartSchema = Type.Object(
  {
    type: Type.Literal('image'),
    attachment: ImageAttachmentSchema,
  },
  { additionalProperties: false },
)
export const FilePartSchema = Type.Object(
  {
    type: Type.Literal('file'),
    attachment: FileAttachmentSchema,
  },
  { additionalProperties: false },
)
export const AttachmentPartSchema = Type.Union([
  ImagePartSchema,
  FilePartSchema,
])
export type AttachmentPart = Static<typeof AttachmentPartSchema>

/** Creates a canonical attachment part without host paths or image bytes. */
export function attachmentPart(attachment: Attachment): AttachmentPart {
  return attachment.kind === 'image'
    ? { type: 'image', attachment }
    : { type: 'file', attachment }
}

/** Validates the combined per-message import limits, including attachment-only turns. */
export function assertAttachmentLimits(
  attachments: readonly Attachment[],
): void {
  if (
    attachments.length > ATTACHMENT_LIMITS.count ||
    attachments.filter((item) => item.kind === 'image').length >
      ATTACHMENT_LIMITS.images ||
    attachments.reduce((sum, item) => sum + item.byteSize, 0) >
      ATTACHMENT_LIMITS.messageBytes ||
    new Set(attachments.map((item) => item.id)).size !== attachments.length
  ) {
    throw new Error('Attachment count or total size exceeds the message limit')
  }
}

/** Builds an opaque image URL accepted by the restricted desktop preview protocol. */
export function attachmentPreviewUrl(
  id: string,
  variant: 'thumbnail' | 'preview' = 'thumbnail',
): string {
  return `zch-attachment://asset/${id}/${variant}`
}
