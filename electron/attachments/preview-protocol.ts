import type { AttachmentService } from './service'

/** Serves only bounded generated image variants addressed by opaque attachment IDs. */
export async function attachmentPreviewResponse(
  service: AttachmentService,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url)
  const match = /^\/([a-f0-9]{32})\/(thumbnail|preview)$/u.exec(url.pathname)
  if (
    request.method !== 'GET' ||
    url.protocol !== 'zch-attachment:' ||
    url.host !== 'asset' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    return new Response(null, { status: 404 })
  try {
    const bytes = await service.preview(
      match[1],
      match[2] as 'thumbnail' | 'preview',
    )
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'private, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
      },
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}
