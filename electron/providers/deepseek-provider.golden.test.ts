import { describe, expect, it } from 'vitest'
import type { CallId } from '../../shared/ids'
import type { JsonObject, JsonValue } from '../../shared/json'
import { DeepSeekProvider } from './deepseek-provider'
import { DEEPSEEK_WIRE_GOLDENS } from './fixtures/deepseek-wire-goldens'
import type { ProviderEvent, ProviderStreamRequest } from './provider'

function sseResponse(payloads: JsonValue[]): Response {
  return new Response(
    payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join(''),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

function streamRequest(input: {
  messages: JsonValue[]
  tools: JsonValue[]
  signal: AbortSignal
  providerRequestOverride: JsonObject
}): ProviderStreamRequest {
  return {
    providerRequest: structuredClone(input.providerRequestOverride),
    normalizedMessages: structuredClone(input.messages) as JsonObject[],
    toolDefinitions: structuredClone(input.tools),
    signal: input.signal,
  }
}

function eventProjection(event: ProviderEvent): JsonValue {
  if (event.type === 'completed') {
    return {
      type: event.type,
      turn: event.turn as unknown as JsonValue,
      toolCalls: event.toolCalls as unknown as JsonValue,
      usage: event.usage,
    }
  }

  if (event.type === 'usage') {
    return { type: event.type, usage: event.usage }
  }

  if (event.type === 'tool.delta') {
    return {
      type: event.type,
      index: event.index,
      ...(event.id ? { id: event.id } : {}),
      ...(event.name ? { name: event.name } : {}),
      ...(event.argumentsDelta ? { argumentsDelta: event.argumentsDelta } : {}),
    }
  }

  return { type: event.type, delta: event.delta }
}

describe('DeepSeek wire golden baseline', () => {
  it.each(DEEPSEEK_WIRE_GOLDENS)(
    '$id preserves the request and normalized stream trajectory',
    async (golden) => {
      let requestBody = ''
      let now = 0
      const provider = new DeepSeekProvider({
        baseURL: 'https://api.example/v1',
        apiKey: 'secret-not-in-golden',
        now: () => now++,
        createCallId: () => 'call-generated' as CallId,
        fetchImpl: async (_input, init) => {
          requestBody = String(init?.body)
          return sseResponse(golden.stream)
        },
      })
      const events: JsonValue[] = []

      for await (const event of provider.stream(
        streamRequest({
          messages: golden.messages,
          tools: golden.tools,
          providerRequestOverride: golden.expectedRequest as JsonObject,
          signal: new AbortController().signal,
        }),
      )) {
        events.push(eventProjection(event))
      }

      expect(JSON.parse(requestBody)).toEqual(golden.expectedRequest)
      expect(events).toEqual(golden.expectedEvents)
      expect(requestBody).not.toContain('secret-not-in-golden')
    },
  )
})
