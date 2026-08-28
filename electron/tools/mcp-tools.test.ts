import { Type } from '@sinclair/typebox'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { McpServerStatus } from '../../shared/mcp'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import type { ConfigStore } from '../config/store'
import type {
  McpCatalogSnapshot,
  McpManager,
  McpToolDescriptor,
} from '../mcp/mcp-manager'
import { evaluatePolicy } from '../permission/policy-engine'
import { compileSchema } from '../schema-validator'
import type { SessionState } from '../session/session-types'
import { registerMcpTools } from './mcp-tools'
import { ToolRegistry } from './tool-registry'
import type { ToolExecutionContext } from './types'

const alpha: McpToolDescriptor = {
  name: 'alpha',
  description: 'Alpha',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  available: true,
}
const beta: McpToolDescriptor = {
  name: 'beta',
  description: 'Beta',
  inputSchema: {
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
    additionalProperties: false,
  },
  available: true,
}

describe('MCP gateway tools', () => {
  it('paginates catalogs, requires disclosure and authorizes the canonical tool', async () => {
    let revision = 'a'.repeat(64)
    const catalog = (): McpCatalogSnapshot => ({
      server: {
        id: 'fixture',
        label: 'Fixture',
        description: 'Fixture server',
        scope: 'global',
        state: 'ready',
      },
      serverId: 'fixture',
      revision,
      instructions: 'Fixture instructions',
      tools: [alpha, beta],
      diagnostics: [],
    })
    const manager = {
      listVisible: () => [visibleStatus()],
      catalog: async () => catalog(),
      resolveTool: (
        _serverId: string,
        _workspace: string,
        toolName: string,
        expectedRevision: string,
      ) => {
        if (expectedRevision !== revision) {
          throw Object.assign(new Error('catalog changed'), {
            code: 'MCP_CATALOG_CHANGED',
          })
        }
        const descriptor = toolName === 'alpha' ? alpha : beta
        return {
          descriptor,
          validate: compileSchema(
            toolName === 'alpha'
              ? Type.Object(
                  { value: Type.String() },
                  { additionalProperties: false },
                )
              : Type.Object(
                  { count: Type.Integer() },
                  { additionalProperties: false },
                ),
          ),
        }
      },
      callTool: async () => ({
        content: [
          { type: 'text', text: 'called' },
          {
            type: 'resource',
            resource: { uri: 'file:///fixture.txt', text: 'resource body' },
          },
          { type: 'image', mimeType: 'image/png', data: 'omitted' },
        ],
        structuredContent: { count: 1 },
      }),
    } as unknown as McpManager
    const config = toPublicConfig(DEFAULT_APP_CONFIG, false)
    const configStore = {
      getPublicConfig: () => config,
    } as unknown as ConfigStore
    const session = {
      sessionId: 'session:mcp' as SessionId,
      workspace: process.cwd(),
      mcpDisclosures: new Map(),
    } as SessionState
    const registry = new ToolRegistry()
    const gateway = registerMcpTools(registry, {
      manager,
      configStore,
      getSession: () => session,
    })
    const read = registry.get('read_mcp_server')!
    expect(registry.get('list_mcp_servers')?.executionMode).toBe('parallel')
    expect(read.executionMode).toBe('parallel')
    expect(registry.get('call_mcp_tool')?.executionMode).toBe('serial')
    const first = await read.execute(
      { serverId: 'fixture', limit: 1 },
      executionContext(session),
    )
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') return
    expect(first.content).toMatchObject({
      server: { id: 'fixture', state: 'ready' },
      totalTools: 2,
    })
    const nextCursor = (first.content as { nextCursor?: string }).nextCursor
    expect(nextCursor).toBeTruthy()

    const betaBeforeRead = gateway.resolveCall(session, {
      id: 'call:beta' as CallId,
      toolId: 'call_mcp_tool',
      args: { serverId: 'fixture', toolName: 'beta', arguments: { count: 1 } },
      reason: 'test',
    })
    expect(betaBeforeRead).toMatchObject({
      matched: true,
      ok: false,
      result: { code: 'MCP_TOOL_NOT_DISCLOSED' },
    })

    const alphaCall = gateway.resolveCall(session, {
      id: 'call:alpha' as CallId,
      toolId: 'call_mcp_tool',
      args: {
        serverId: 'fixture',
        toolName: 'alpha',
        arguments: { value: 42, hallucinated: 'ignored' },
        hallucinatedWrapperField: true,
      },
      reason: 'test',
    })
    expect(alphaCall).toMatchObject({
      matched: true,
      ok: true,
      call: { toolId: 'mcp:fixture:alpha', args: { value: '42' } },
    })
    if (!alphaCall.matched || !alphaCall.ok) return

    expect(alphaCall.definition.executionMode).toBe('serial')
    expect(policy(alphaCall.definition, 'readonly')).toBe('deny')
    expect(policy(alphaCall.definition, 'auto')).toBe('model')
    expect(policy(alphaCall.definition, 'confirm')).toBe('review')
    expect(policy(alphaCall.definition, 'yolo')).toBe('allow')
    const nativeResult = await alphaCall.definition.execute(
      { value: 'hello' },
      executionContext(session),
    )
    expect(nativeResult.status).toBe('ok')
    if (nativeResult.status !== 'ok') return
    expect(
      alphaCall.definition.projectResultForModel?.(nativeResult, {
        value: 'hello',
      }),
    ).toEqual([
      { type: 'text', text: 'called' },
      {
        type: 'text',
        text: 'Resource file:///fixture.txt\nresource body',
      },
      { type: 'text', text: '[image image/png omitted]' },
      { type: 'json', value: { count: 1 } },
    ])

    revision = 'b'.repeat(64)
    const stale = await read.execute(
      { serverId: 'fixture', cursor: nextCursor },
      executionContext(session),
    )
    expect(stale).toMatchObject({ status: 'error', code: 'MCP_CURSOR_STALE' })
  })

  it('advances pagination with an unavailable diagnostic for a page-sized tool', async () => {
    const huge: McpToolDescriptor = {
      ...alpha,
      name: 'huge',
      inputSchema: {
        type: 'object',
        description: 'x'.repeat(8_000),
      },
    }
    const manager = {
      listVisible: () => [visibleStatus()],
      catalog: async (): Promise<McpCatalogSnapshot> => ({
        server: {
          id: 'fixture',
          label: 'Fixture',
          description: 'Fixture',
          scope: 'global',
          state: 'ready',
        },
        serverId: 'fixture',
        revision: 'a'.repeat(64),
        tools: [huge, beta],
        diagnostics: [],
      }),
    } as unknown as McpManager
    const config = toPublicConfig(DEFAULT_APP_CONFIG, false)
    config.limits.maxToolOutputBytes = 2_048
    const session = {
      sessionId: 'session:mcp-large' as SessionId,
      workspace: process.cwd(),
      mcpDisclosures: new Map(),
    } as SessionState
    const registry = new ToolRegistry()
    registerMcpTools(registry, {
      manager,
      configStore: {
        getPublicConfig: () => config,
      } as unknown as ConfigStore,
      getSession: () => session,
    })

    const result = await registry
      .get('read_mcp_server')!
      .execute({ serverId: 'fixture', limit: 1 }, executionContext(session))
    expect(result).toMatchObject({
      status: 'ok',
      content: {
        tools: [
          {
            name: 'huge',
            available: false,
            diagnostic:
              'Tool definition exceeds the configured MCP catalog page limit',
          },
        ],
      },
    })
    expect(session.mcpDisclosures.get('fixture')?.toolNames.has('huge')).toBe(
      false,
    )
  })

  it('stores normalized MCP results that exceed the line threshold', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-artifact-'))
    const sessionTemp = {
      root,
      artifacts: path.join(root, 'artifacts'),
      scratch: path.join(root, 'scratch'),
    }
    await Promise.all([
      mkdir(sessionTemp.artifacts, { recursive: true }),
      mkdir(sessionTemp.scratch, { recursive: true }),
    ])
    const revision = 'c'.repeat(64)
    const longText = Array.from(
      { length: 501 },
      (_, index) => `line-${index}`,
    ).join('\n')
    const manager = {
      listVisible: () => [visibleStatus()],
      catalog: async (): Promise<McpCatalogSnapshot> => ({
        server: visibleStatus(),
        serverId: 'fixture',
        revision,
        tools: [alpha],
        diagnostics: [],
      }),
      resolveTool: () => ({
        descriptor: alpha,
        validate: compileSchema(
          Type.Object(
            { value: Type.String() },
            { additionalProperties: false },
          ),
        ),
      }),
      callTool: async () => ({
        content: [{ type: 'text', text: longText }],
        structuredContent: { complete: true },
      }),
    } as unknown as McpManager
    const config = toPublicConfig(DEFAULT_APP_CONFIG, false)
    const session = {
      sessionId: 'session:mcp-artifact' as SessionId,
      workspace: process.cwd(),
      mcpDisclosures: new Map(),
    } as SessionState
    const registry = new ToolRegistry()
    const gateway = registerMcpTools(registry, {
      manager,
      configStore: {
        getPublicConfig: () => config,
      } as unknown as ConfigStore,
      getSession: () => session,
    })
    await registry
      .get('read_mcp_server')!
      .execute(
        { serverId: 'fixture', limit: 1 },
        executionContext(session, sessionTemp),
      )
    const resolved = gateway.resolveCall(session, {
      id: 'call:mcp-artifact' as CallId,
      toolId: 'call_mcp_tool',
      args: {
        serverId: 'fixture',
        toolName: 'alpha',
        arguments: { value: 'test' },
      },
      reason: 'capture complete output',
    })
    if (!resolved.matched || !resolved.ok) {
      throw new Error('Expected a disclosed MCP tool')
    }

    const result = await resolved.definition.execute(
      { value: 'test' },
      executionContext(session, sessionTemp, 'call:mcp-artifact'),
    )

    expect(result).toMatchObject({
      status: 'ok',
      content: {
        artifactAvailable: true,
        artifactPath: expect.any(String),
      },
    })
    if (result.status !== 'ok') return
    const artifactPath = (result.content as { artifactPath: string })
      .artifactPath
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
      content: Array<{ text?: string }>
    }
    expect(artifact.content[0]?.text).toBe(longText)
  })
})

function policy(
  definition: Parameters<typeof evaluatePolicy>[0]['definition'],
  mode: Parameters<typeof evaluatePolicy>[0]['mode'],
) {
  return evaluatePolicy({
    mode,
    definition,
    effectiveRisk: definition.defaultRisk,
    policySignals: [],
    rememberedRules: [],
    builtinPolicies: true,
    workspace: process.cwd(),
    args: {},
    callId: 'call:policy' as CallId,
  }).kind
}

function executionContext(
  session: SessionState,
  sessionTemp?: { root: string; artifacts: string; scratch: string },
  callId = 'call:mcp',
): ToolExecutionContext {
  return {
    sessionId: session.sessionId,
    runId: 'run:mcp' as RunId,
    workspace: { canonicalPath: session.workspace },
    ...(sessionTemp ? { sessionTemp } : {}),
    signal: new AbortController().signal,
    approvedCall: {
      callId: callId as CallId,
    } as ToolExecutionContext['approvedCall'],
  }
}

function visibleStatus(): McpServerStatus {
  return {
    id: 'fixture',
    label: 'Fixture',
    description: 'Fixture',
    enabled: true,
    scope: 'global',
    state: 'ready',
    trusted: true,
    launchFingerprint: 'a'.repeat(64),
    launchPreview: 'node fixture',
    toolCount: 2,
    revision: 'a'.repeat(64),
    stderrTail: '',
  }
}
