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
if (mode === 'crash') {
  console.error('fake startup failure')
  process.exit(1)
}
const allTools = ['get_symbols_overview', 'find_symbol', 'find_referencing_symbols', 'get_diagnostics_for_file', 'replace_symbol_body']
const tools = allTools.filter((name) => {
  if (mode === 'missing-overview' && name === 'get_symbols_overview') return false
  if (mode === 'missing-diagnostics' && name === 'get_diagnostics_for_file') return false
  return true
})
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
    if (name === 'get_diagnostics_for_file') {
      send({
        id: message.id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify([{
              relative_path: args.relative_path || 'src/app.ts',
              severity: 1,
              message: 'Type mismatch',
              source: 'fake-lsp',
              code: 'TS2322',
              range: {
                start: { line: 3, character: 5 },
                end: { line: 3, character: 18 },
              },
            }]),
          }],
        },
      })
      return
    }
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

function project(workspacePath: string, mode = 'default'): ProjectModel {
  return {
    schemaVersion: 1,
    workspaceRoot: workspacePath,
    modules: [],
    storage: 'project-local',
    backendBindings: [],
    serena: {
      id: 'serena',
      enabled: true,
      command: 'serena',
      context: 'ide-assistant',
      projectMode: 'workspacePath',
      openWebDashboard: false,
      extraArgs: [mode],
      cwd: workspacePath,
      startupTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
      languages: ['typescript'],
    },
    updatedAt: timestamp,
  }
}

function adapterFor(script: string): SerenaMcpAdapter {
  return new SerenaMcpAdapter({
    launch: (model) => ({
      command: process.execPath,
      args: [script, model.serena.extraArgs?.[0] ?? 'default'],
      cwd: model.workspaceRoot,
      preview: `${process.execPath} ${script}`,
    }),
  })
}

describe('SerenaMcpAdapter', () => {
  it('maps read-only code intelligence calls through a stdio MCP server', async () => {
    const directory = await workspace()
    const script = await fakeServer(directory)
    const adapter = adapterFor(script)

    try {
      const result = await adapter.query(project(directory), {
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
      expect(adapter.status(project(directory)).state).toBe('ready')
      expect(adapter.status(project(directory)).capabilities).toContain(
        'diagnostics',
      )
    } finally {
      await adapter.dispose()
    }
  })

  it('maps Serena file diagnostics into code diagnostics', async () => {
    const directory = await workspace()
    const script = await fakeServer(directory)
    const adapter = adapterFor(script)

    try {
      const result = await adapter.query(project(directory), {
        capability: 'diagnostics',
        workspace: directory,
        path: 'src/app.ts',
      })

      expect(result.precision).toBe('semantic')
      expect(result.items[0]).toMatchObject({
        path: 'src/app.ts',
        severity: 'error',
        message: 'Type mismatch',
        source: 'fake-lsp',
        code: 'TS2322',
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('returns unsupported when Serena omits the mapped read-only tool', async () => {
    const directory = await workspace()
    const script = await fakeServer(directory)
    const adapter = adapterFor(script)

    try {
      const result = await adapter.query(
        project(directory, 'missing-overview'),
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

  it('returns unsupported when Serena omits diagnostics', async () => {
    const directory = await workspace()
    const script = await fakeServer(directory)
    const adapter = adapterFor(script)

    try {
      const result = await adapter.query(
        project(directory, 'missing-diagnostics'),
        {
          capability: 'diagnostics',
          workspace: directory,
          path: 'src/app.ts',
        },
      )

      expect(result.precision).toBe('unsupported')
      expect(result.code).toBe('UNSUPPORTED_CAPABILITY')
      expect(
        adapter.status(project(directory, 'missing-diagnostics')).capabilities,
      ).not.toContain('diagnostics')
    } finally {
      await adapter.dispose()
    }
  })

  it('preserves startup failure diagnostics in backend status', async () => {
    const directory = await workspace()
    const script = await fakeServer(directory)
    const adapter = adapterFor(script)
    const model = project(directory, 'crash')

    try {
      const status = await adapter.restart(model)

      expect(status.state).toBe('error')
      expect(status.message).toContain('Serena backend failed to start.')
      expect(status.message).toContain('fake startup failure')
      expect(status.message).toContain('argv:')
      expect(adapter.status(model)).toMatchObject({
        state: 'error',
        message: status.message,
      })
    } finally {
      await adapter.dispose()
    }
  })
})
