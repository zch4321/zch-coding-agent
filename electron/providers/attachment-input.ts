import {
  ATTACHMENT_LIMITS,
  type Attachment,
  type ImageAttachment,
} from '../../shared/attachments'
import type { JsonObject, JsonValue } from '../../shared/json'
import type { MessageRecord } from '../../shared/message'
import type { ProviderStreamContext } from './provider'
import { DomainError } from '../common/domain-error'

export interface ProviderAttachmentBinding {
  attachment: Attachment
  path: (string | number)[]
  placeholder: string
  encoding: 'data-url' | 'base64' | 'file-path'
}

/** Projects text and immutable input references into one protocol's user content blocks. */
export function compileUserContent(
  record: MessageRecord,
  protocol: 'chat' | 'responses' | 'anthropic',
): JsonObject[] {
  return record.parts.flatMap((part): JsonObject[] => {
    const textType = protocol === 'responses' ? 'input_text' : 'text'
    if (part.type === 'text') return [{ type: textType, text: part.text }]
    if (part.type === 'file')
      return [{ type: textType, text: `zch-file:${part.attachment.id}` }]
    if (part.type !== 'image') return []
    const marker = `zch-image:${part.attachment.id}`
    if (protocol === 'responses')
      return [{ type: 'input_image', image_url: marker, detail: 'auto' }]
    if (protocol === 'anthropic')
      return [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.attachment.requestMimeType,
            data: marker,
          },
        },
      ]
    return [{ type: 'image_url', image_url: { url: marker, detail: 'auto' } }]
  })
}

/** Creates a deterministic sidecar for generated protocol placeholders without reading files. */
export function attachmentBindingsFor(
  request: JsonObject,
  records: readonly MessageRecord[],
): { attachmentBindings?: ProviderAttachmentBinding[] } {
  const attachments = new Map<string, Attachment>()
  for (const record of records)
    for (const part of record.parts)
      if (part.type === 'image' || part.type === 'file')
        attachments.set(part.attachment.id, part.attachment)
  if (!attachments.size) return {}
  const bindings: ProviderAttachmentBinding[] = []
  const visit = (value: JsonValue, path: (string | number)[]): void => {
    if (typeof value === 'string') {
      const match = /^zch-(image|file):([a-f0-9]{32})$/u.exec(value)
      const attachment = match ? attachments.get(match[2]) : undefined
      if (
        attachment &&
        match?.[1] === attachment.kind &&
        (attachment.kind === 'file'
          ? path.at(-1) === 'text'
          : ['url', 'image_url', 'data'].includes(String(path.at(-1))))
      )
        bindings.push({
          attachment: structuredClone(attachment),
          path,
          placeholder: value,
          encoding:
            attachment.kind === 'file'
              ? 'file-path'
              : path.at(-1) === 'data'
                ? 'base64'
                : 'data-url',
        })
    } else if (Array.isArray(value))
      value.forEach((item, index) => visit(item, [...path, index]))
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value))
        visit(item, [...path, key])
  }
  visit(request, [])
  return bindings.length ? { attachmentBindings: bindings } : {}
}

/** Counts actual prepared image bytes without scanning Base64 or treating them as text tokens. */
export function historyImageBytes(records: readonly MessageRecord[]): number {
  return records.reduce(
    (sum, record) =>
      sum +
      record.parts.reduce(
        (bytes, part) =>
          bytes + (part.type === 'image' ? part.attachment.requestBytes : 0),
        0,
      ),
    0,
  )
}

/** Materializes only declared attachment slots immediately before HTTP serialization. */
export async function materializeAttachmentRequest(
  call: {
    request: JsonObject
    attachmentBindings?: ProviderAttachmentBinding[]
  },
  context: ProviderStreamContext,
): Promise<JsonObject> {
  const bindings = call.attachmentBindings ?? []
  const total = bindings.reduce(
    (sum, binding) =>
      sum +
      (binding.attachment.kind === 'image'
        ? binding.attachment.requestBytes
        : 0),
    0,
  )
  if (total > ATTACHMENT_LIMITS.requestImageBytes)
    throw new DomainError(
      'PAYLOAD_TOO_LARGE',
      'Image request exceeds the attachment budget',
    )
  const request = structuredClone(call.request)
  for (const binding of bindings) {
    context.signal.throwIfAborted()
    let replacement: string
    if (binding.attachment.kind === 'image') {
      if (!context.resolveImage)
        throw new DomainError(
          'PRECONDITION_FAILED',
          'Image resolver is unavailable',
        )
      const bytes = await context.resolveImage(
        binding.attachment,
        context.signal,
      )
      if (
        bytes.length !== binding.attachment.requestBytes ||
        bytes.length > ATTACHMENT_LIMITS.imageRequestBytes
      )
        throw new DomainError('RESOURCE_CHANGED', 'Image request size changed')
      const base64 = bytes.toString('base64')
      replacement =
        binding.encoding === 'base64'
          ? base64
          : `data:${binding.attachment.requestMimeType};base64,${base64}`
    } else {
      if (!context.resolveFile)
        throw new DomainError(
          'PRECONDITION_FAILED',
          'File resolver is unavailable',
        )
      const file = await context.resolveFile(binding.attachment, context.signal)
      replacement = `Attached file ${JSON.stringify(binding.attachment.name)} (${binding.attachment.byteSize} bytes). Read with local tools: ${JSON.stringify(file)}`
    }
    replaceSlot(request, binding, replacement)
  }
  context.signal.throwIfAborted()
  return request
}

function replaceSlot(
  request: JsonObject,
  binding: ProviderAttachmentBinding,
  replacement: string,
): void {
  let target: JsonValue = request
  for (const key of binding.path.slice(0, -1)) {
    if (
      !target ||
      typeof target !== 'object' ||
      ['__proto__', 'prototype', 'constructor'].includes(String(key)) ||
      !Object.hasOwn(target, key)
    )
      throw new Error('Invalid attachment request binding')
    target = Array.isArray(target) ? target[Number(key)] : target[String(key)]
  }
  const key = binding.path.at(-1)
  if (
    !target ||
    typeof target !== 'object' ||
    key === undefined ||
    !Object.hasOwn(target, key)
  )
    throw new Error('Invalid attachment request target')
  if (Array.isArray(target)) {
    if (target[Number(key)] !== binding.placeholder)
      throw new Error('Attachment request placeholder changed')
    target[Number(key)] = replacement
  } else {
    if (target[String(key)] !== binding.placeholder)
      throw new Error('Attachment request placeholder changed')
    target[String(key)] = replacement
  }
}

export type ProviderImageResolver = (
  attachment: ImageAttachment,
  signal: AbortSignal,
) => Promise<Buffer>
