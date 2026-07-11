import readline from 'node:readline'
import process from 'node:process'
import { existsSync, writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers'
import { randomUUID } from 'node:crypto'

const mode = process.env.FAKE_MCP_MODE ?? 'normal'
const secret = process.env.FAKE_SECRET
const crashMarker = process.env.FAKE_CRASH_MARKER
let catalogChanged = false
if (secret) process.stderr.write(`fixture secret=${secret}\n`)
if (process.env.FAKE_STARTUP_MARKER) {
  process.stderr.write(`fixture-start=${randomUUID()}\n`)
}

const alpha = {
  name: 'alpha',
  title: 'Alpha tool',
  description: 'Echo one string value.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { echoed: { type: 'string' } },
    required: ['echoed'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
}

const beta = {
  name: 'beta',
  description: 'Return the supplied integer.',
  inputSchema: {
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
    additionalProperties: false,
  },
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      instructions: 'Use the fake tools for deterministic tests.',
    })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'ping') {
    result(message.id, {})
    return
  }
  if (message.method === 'tools/list') {
    const cursor = message.params?.cursor
    const firstTool =
      mode === 'invalid-schema'
        ? {
            ...alpha,
            inputSchema: {
              type: 'object',
              properties: { value: { $ref: 'urn:missing-schema' } },
            },
          }
        : catalogChanged
          ? { ...alpha, description: 'Changed alpha tool.' }
          : alpha
    if (!cursor) {
      result(message.id, {
        tools: [firstTool],
        nextCursor: mode === 'repeat-cursor' ? 'repeat' : 'page-2',
      })
      return
    }
    if (mode === 'repeat-cursor') {
      result(message.id, { tools: [beta], nextCursor: 'repeat' })
      return
    }
    result(message.id, { tools: [beta] })
    if (mode === 'crash-once' && crashMarker && !existsSync(crashMarker)) {
      writeFileSync(crashMarker, 'crashed')
      setTimeout(() => process.exit(23), 100)
    }
    return
  }
  if (message.method === 'tools/call') {
    if (message.params.name === 'alpha') {
      if (mode === 'timeout-call') return
      const echoed = message.params.arguments?.value ?? ''
      result(message.id, {
        content: [{ type: 'text', text: String(echoed) }],
        structuredContent: { echoed: String(echoed) },
      })
      return
    }
    if (message.params.name === 'beta') {
      result(message.id, {
        content: [
          { type: 'text', text: String(message.params.arguments?.count ?? 0) },
        ],
      })
      if (mode === 'list-changed' && !catalogChanged) {
        catalogChanged = true
        send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      }
      return
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Unknown tool' },
    })
  }
})
