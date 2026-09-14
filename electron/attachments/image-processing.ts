import sharp from 'sharp'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  ATTACHMENT_LIMITS,
  type ImageAttachment,
} from '../../shared/attachments'
import { writeFileContents } from '../common/filesystem'
import { DomainError } from '../common/domain-error'

const OPTIONS = { limitInputPixels: 40_000_000, failOn: 'warning' as const }
let queue: Promise<unknown> = Promise.resolve()

/** Serializes image decoding so imported large images cannot saturate the main process's worker pool. */
export function processAttachmentImage(
  source: string,
  directory: string,
): Promise<
  Pick<
    ImageAttachment,
    | 'width'
    | 'height'
    | 'requestBytes'
    | 'requestMimeType'
    | 'requestSha256'
    | 'mimeType'
  >
> {
  const result = queue.then(() => processImage(source, directory))
  queue = result.catch(() => undefined)
  return result
}

async function processImage(source: string, directory: string) {
  const metadata = await sharp(source, OPTIONS).metadata()
  const mimeType = (
    { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<
      string,
      string
    >
  )[metadata.format ?? '']
  if (
    !mimeType ||
    !metadata.width ||
    !metadata.height ||
    (metadata.pages ?? 1) > 1
  ) {
    throw new DomainError(
      'PRECONDITION_FAILED',
      'Expected a static PNG, JPEG or WebP image',
    )
  }
  const pipeline = () =>
    sharp(source, OPTIONS).rotate().flatten({ background: '#ffffff' })
  let request: Buffer | undefined
  for (const quality of [90, 75, 55]) {
    request = await pipeline()
      .resize(
        ATTACHMENT_LIMITS.imageLongEdge,
        ATTACHMENT_LIMITS.imageLongEdge,
        { fit: 'inside', withoutEnlargement: true },
      )
      .jpeg({ quality })
      .toBuffer()
    if (request.byteLength <= ATTACHMENT_LIMITS.imageRequestBytes) break
  }
  if (!request || request.byteLength > ATTACHMENT_LIMITS.imageRequestBytes) {
    throw new DomainError(
      'PAYLOAD_TOO_LARGE',
      'Image could not fit the request size limit',
    )
  }
  const thumbnail = await pipeline()
    .resize(192, 192, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer()
  await writeFileContents(path.join(directory, 'request.jpg'), request, {
    flag: 'wx',
    mode: 0o600,
  })
  await writeFileContents(path.join(directory, 'thumbnail.jpg'), thumbnail, {
    flag: 'wx',
    mode: 0o600,
  })
  const rotated = [5, 6, 7, 8].includes(metadata.orientation ?? 1)
  return {
    mimeType,
    width: rotated ? metadata.height : metadata.width,
    height: rotated ? metadata.width : metadata.height,
    requestBytes: request.byteLength,
    requestMimeType: 'image/jpeg' as const,
    requestSha256: createHash('sha256').update(request).digest('hex'),
  }
}
