import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectModel } from '../../shared/project-model'
import { SerenaMcpAdapter } from './serena-mcp-adapter'

const directories: string[] = []
const timestamp = '2026-06-28T00:00:00.000Z'

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'zch-serena-mcp-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  )
})

function fakeServerSource(): string {
  return `
const mode = process.argv[2] || 'default'
const allTools = ['get_symbols_overview', 'find_symbol', 'find_referencing_symbols', 'replace_symbol_body']
const tools = mode === 'missing-overview'
  ? allTools.filter((name) => name !== 'get_symbols_overview')
  : allTools
let buffer = ''

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
}

function toolDefinition(name) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
  }
}

function handle(message) {
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-serena', version: '0.0.1' },
      },
    })
    return
  }
  if (message.method === 'tools/list') {
    send({
      id: message.id,
      result: { tools: tools.map(toolDefinition) },
    })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    const symbolName = name === 'find_symbol'
      ? String(args.name_path_pattern || 'App')
      : String(args.name_path || 'App')
    const symbol = {
      name: name === 'get_symbols_overview' ? 'App' : symbolName,
      kind: 'class',
      relative_path: args.relative_path || 'src/app.ts',
      range: {
        start: { line: 1, character: 1 },
        end: { line: 12, character: 1 },
      },
    }
    send({
      id: message.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify([symbol]) }],
      },
    })
    return
  }
  send({
    id: message.id,
    error: { code: -32601, message: 'Method not found' },
  })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(JSON.parse(line))
    index = buffer.indexOf('\\n')
  }
})
`
}

async function fakeServer(workspacePath: string): Promise<string> {
  const script = path.join(workspacePath, 'fake-serena.mjs')
  await writeFile(script, fakeServerSource(), 'utf8')
  return script
}

function project(
  workspacePath: string,
  script: string,
  mode = 'default',
): ProjectModel {
  return {
    schemaVersion: 1,
    workspaceRoot: workspacePath,
    modules: [],
    storage: 'project-local',
    backendBindings: [],
    serena: {
      id: 'serena',
      enabled: true,
      command: process.execPath,
      args: [script, mode],
      cwd: workspacePath,
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
      languages: ['typescript'],
    },
    updatedAt: timestamp,
  }
}

describe('SerenaMcpAdapter', () => {
  it('maps read-only code intelligence calls through a stdio MCP server', async () => {
    const directory = await workspace()
    const script = await fakeServer(directory)
    const adapter = new SerenaMcpAdapter()

    try {
      const result = await adapter.query(project(directory, script), {
        capability: 'symbol_overview',
        workspace: directory,
        path: 'src/app.ts',
      })

      expect(result.precision).toBe('semantic')
      expect(result.source).toBe('serena-mcp')
      expect(result.items[0]).toMatchObject({
        name: 'App',
        kind: 'class',
        path: 'src/app.ts',
      })
      expect(adapter.status(project(directory, script)).state).toBe('ready')
    } finally {
      await adapter.dispose()
    }
  })

  it('returns unsupported when Serena omits the mapped read-only tool', async () => {
    const directory = await workspace()
    const script = await fakeServer(directory)
    const adapter = new SerenaMcpAdapter()

    try {
      const result = await adapter.query(
        project(directory, script, 'missing-overview'),
        {
          capability: 'symbol_overview',
          workspace: directory,
          path: 'src/app.ts',
        },
      )

      expect(result.precision).toBe('unsupported')
      expect(result.code).toBe('UNSUPPORTED_CAPABILITY')
    } finally {
      await adapter.dispose()
    }
  })
})
