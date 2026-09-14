import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import type { ProjectId, SessionId } from '../../shared/ids'
import type { ImageAttachment } from '../../shared/attachments'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import type { JsonValue } from '../../shared/json'
import {
  appendUserInput,
  MessageHistoryCompiler,
  type CanonicalHistoryState,
} from '../session/canonical-history'
import { GenericChatCompletionsProvider } from './generic-chat-completions-provider'
import { GenericResponsesProvider } from './generic-responses-provider'
import { GenericAnthropicProvider } from './generic-anthropic-provider'
import {
  materializeAttachmentRequest,
  historyImageBytes,
} from './attachment-input'

function response(protocol: 'chat' | 'responses' | 'anthropic'): Response {
  const events: JsonValue[] =
    protocol === 'chat'
      ? [
          {
            choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
          },
        ]
      : protocol === 'responses'
        ? [
            {
              type: 'response.completed',
              response: {
                id: 'response:test',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Done' }],
                  },
                ],
                usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
              },
            },
          ]
        : [
            {
              type: 'message_start',
              message: {
                id: 'message:test',
                role: 'assistant',
                content: [],
                usage: { input_tokens: 9, output_tokens: 0 },
              },
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Done' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 2 },
            },
            { type: 'message_stop' },
          ]
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  )
}

async function imageFixture(): Promise<{
  image: ImageAttachment
  bytes: Buffer
}> {
  const bytes = await sharp({
    create: { width: 12, height: 9, channels: 3, background: '#36aacc' },
  })
    .jpeg()
    .toBuffer()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    bytes,
    image: {
      id: 'a'.repeat(32),
      projectId: 'project:vision' as ProjectId,
      kind: 'image',
      name: 'image.jpg',
      mimeType: 'image/jpeg',
      byteSize: bytes.length,
      sha256,
      width: 12,
      height: 9,
      requestBytes: bytes.length,
      requestMimeType: 'image/jpeg',
      requestSha256: sha256,
    },
  }
}

describe.each(['chat', 'responses', 'anthropic'] as const)(
  '%s native attachment input',
  (protocol) => {
    it('sends decodable images and local file references while keeping compiled calls byte-free', async () => {
      const { image, bytes } = await imageFixture()
      const state: CanonicalHistoryState = {
        sessionId: 'session:vision' as SessionId,
        history: [],
        nextMessageSeq: 1,
      }
      appendUserInput(state, {
        content: `zch-image:${image.id}`,
        clientRequestId: 'request:vision',
        importedAttachments: [
          image,
          {
            id: 'b'.repeat(32),
            projectId: image.projectId,
            name: 'notes.pdf',
            kind: 'file',
            mimeType: 'application/pdf',
            byteSize: 5,
            sha256: 'b'.repeat(64),
          },
        ],
      })
      const fetchImpl = vi.fn(async () => response(protocol))
      const options = {
        providerId: 'provider:vision',
        baseURL: 'https://example.test/v1',
        apiKey: 'test-key',
        fetchImpl: fetchImpl as typeof fetch,
      }
      const provider =
        protocol === 'chat'
          ? new GenericChatCompletionsProvider(options)
          : protocol === 'responses'
            ? new GenericResponsesProvider(options)
            : new GenericAnthropicProvider(options)
      const route: ModelRouteSnapshot = {
        schemaVersion: 2,
        purpose: 'main',
        providerType: provider.providerType,
        providerId: options.providerId,
        model: 'vision-test',
        reasoning: 'off',
        endpoint: 'https://example.test/v1',
        providerConfigRevision: 1,
      }
      const history = new MessageHistoryCompiler().compile(state.history)
      const input = { history, route, tools: [], maxOutputTokens: 256 }
      const call = provider.compile(input)
      expect(call.attachmentBindings).toHaveLength(2)
      expect(JSON.stringify(call)).not.toContain(bytes.toString('base64'))
      const resolveImage = vi.fn(async () => bytes)
      const resolveFile = vi.fn(async () => 'C:\\run\\attachments\\notes.pdf')
      const events = []
      for await (const event of provider.stream(call, {
        signal: new AbortController().signal,
        resolveImage,
        resolveFile,
      }))
        events.push(event)
      expect(events.at(-1)?.type).toBe('completed')
      const wire = String(
        (fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1].body,
      )
      expect(wire).toContain(bytes.toString('base64'))
      expect(wire).toContain('notes.pdf')
      expect(wire).toContain(`zch-image:${image.id}`) // Literal text is never replaced with Base64.
      expect(resolveFile).toHaveBeenCalledOnce()
      expect((await sharp(await resolveImage()).metadata()).width).toBe(12)
      expect(JSON.stringify(call)).not.toContain(bytes.toString('base64'))
      expect(JSON.stringify(events)).not.toContain(bytes.toString('base64'))
      const compact = provider.compileCompact(
        {
          history,
          route: { ...route, purpose: 'compression' },
          instructions: 'Summarize the image',
          maxOutputTokens: 256,
        },
        'synthetic',
      )
      for await (const event of provider.compact(compact, {
        signal: new AbortController().signal,
        resolveImage,
        resolveFile,
      }))
        expect(event).toBeDefined()
      expect(
        String(
          (fetchImpl.mock.calls[1] as unknown as [unknown, RequestInit])[1]
            .body,
        ),
      ).toContain(bytes.toString('base64'))

      // A provider may echo rejected inputs in an error body; it must not become trace evidence.
      const consume = async () => {
        for await (const event of provider.stream(call, {
          signal: new AbortController().signal,
          resolveImage,
          resolveFile,
        }))
          expect(event).toBeDefined()
      }
      fetchImpl.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: 'invalid_image', input: bytes.toString('base64') },
          }),
          { status: 400, headers: { 'x-request-id': 'image-failure' } },
        ),
      )
      await expect(consume()).rejects.toMatchObject({
        code: 'HTTP_ERROR',
        status: 400,
        providerErrorCode: 'invalid_image',
        requestId: 'image-failure',
        evidence: undefined,
      })
      fetchImpl.mockResolvedValueOnce(
        new Response(`data: invalid-image ${bytes.toString('base64')}\n\n`),
      )
      const invalid = await consume().catch((error: unknown) => error)
      expect(invalid).toMatchObject({
        code: 'INVALID_SSE',
        evidence: undefined,
      })
      expect((invalid as Error).cause).toBeUndefined()
      expect(JSON.stringify(invalid)).not.toContain(bytes.toString('base64'))
    })

    it('preserves attachment-only turns and rejects missing resolvers, changed slots and excessive image budgets', async () => {
      const { image, bytes } = await imageFixture()
      const state: CanonicalHistoryState = {
        sessionId: 'session:image-only' as SessionId,
        history: [],
        nextMessageSeq: 1,
      }
      appendUserInput(state, {
        content: '',
        clientRequestId: 'only-image',
        importedAttachments: [image],
      })
      const provider = new GenericChatCompletionsProvider({
        providerId: 'test',
        baseURL: 'https://example.test/v1',
        apiKey: 'key',
      })
      const route: ModelRouteSnapshot = {
        schemaVersion: 2,
        purpose: 'main',
        providerType: provider.providerType,
        providerId: 'test',
        model: 'vision',
        reasoning: 'off',
        endpoint: 'https://example.test',
        providerConfigRevision: 1,
      }
      const call = provider.compile({
        history: new MessageHistoryCompiler().compile(state.history),
        route,
        tools: [],
        maxOutputTokens: 256,
      })
      const context = {
        signal: new AbortController().signal,
        resolveImage: async () => bytes,
      }
      await expect(
        materializeAttachmentRequest(call, { signal: context.signal }),
      ).rejects.toThrow('resolver')
      const changed = { ...call, request: { messages: [] } }
      await expect(
        materializeAttachmentRequest(changed, context),
      ).rejects.toThrow('binding')
      const excessive = {
        ...call,
        attachmentBindings: Array.from({ length: 9 }, () => ({
          ...call.attachmentBindings![0],
          attachment: { ...image, requestBytes: 2 * 1024 * 1024 },
        })),
      }
      await expect(
        materializeAttachmentRequest(excessive, context),
      ).rejects.toThrow('budget')
      expect(historyImageBytes(state.history)).toBe(bytes.length)
      const controller = new AbortController()
      controller.abort(new Error('cancel test'))
      await expect(
        materializeAttachmentRequest(call, {
          ...context,
          signal: controller.signal,
        }),
      ).rejects.toThrow('cancel test')
    })
  },
)
