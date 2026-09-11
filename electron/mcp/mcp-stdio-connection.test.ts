import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpStdioConnection } from './mcp-stdio-connection'

const streams = vi.hoisted(() => [] as EventEmitter[])
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    stderr = new EventEmitter()
    constructor() {
      streams.push(this.stderr)
    }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {},
}))

function connection(secrets: string[]) {
  const target = new McpStdioConnection({
    launch: {
      command: 'unused',
      args: [],
      cwd: '.',
      startupTimeoutMs: 100,
      redactions: secrets,
    },
  })
  return { target, stderr: streams.at(-1)! }
}

beforeEach(() => {
  streams.length = 0
})

describe('MCP public stderr', () => {
  it.each(['synthetic-credential', '雪😀密钥', 'x', 'xy', 'xyz'])(
    'redacts every UTF-8 split of %s before exposing snapshots',
    (secret) => {
      const bytes = Buffer.from(secret)
      for (let split = 1; split < bytes.length; split += 1) {
        const { target, stderr } = connection([secret])
        stderr.emit('data', Buffer.from('log: '))
        stderr.emit('data', bytes.subarray(0, split))
        expect(target.stderrTail).toBe('log: ')
        stderr.emit('data', bytes.subarray(split))
        expect(target.stderrTail).toBe('log: [redacted]')
      }
      const { target, stderr } = connection([secret])
      stderr.emit('data', Buffer.from('log: '))
      for (let index = 0; index < bytes.length; index += 1) {
        stderr.emit('data', bytes.subarray(index, index + 1))
        expect(target.stderrTail).toBe(
          index === bytes.length - 1 ? 'log: [redacted]' : 'log: ',
        )
      }
    },
  )

  it('preserves overlapping matches across snapshots and flushes only once', () => {
    const { target, stderr } = connection(['abc', 'bcd', 'bcdef'])
    stderr.emit('data', Buffer.from('ab'))
    expect(target.stderrTail).toBe('')
    stderr.emit('data', Buffer.from('cd'))
    expect(target.stderrTail).toBe('[redacted]')
    stderr.emit('data', Buffer.from('ef!雪'))
    expect(target.stderrTail).toBe('[redacted]!雪')
    stderr.emit('end')
    stderr.emit('close')
    expect(target.stderrTail).toBe('[redacted]!雪')
  })

  it('keeps public tails bounded after sanitization', () => {
    const { target, stderr } = connection(['secret'])
    stderr.emit('data', Buffer.from('safe!'.repeat(10_000) + 'secret!'))
    expect(target.stderrTail).toHaveLength(8192)
    expect(target.stderrTail.endsWith('[redacted]!')).toBe(true)
  })
})
