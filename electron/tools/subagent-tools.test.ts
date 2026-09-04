import { describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import { ToolExecutor, ToolRegistry } from './tool-registry'
import { registerSubagentTools } from './subagent-tools'

function fixture() {
  const runOne = vi.fn(async () => ({
    results: { 调查: '直接返回的结果' },
    meta: {
      durationMs: 10,
      providerId: 'provider',
      model: 'model',
      usage: {
        records: 1,
        promptTokens: 2,
        completionTokens: 3,
        reasoningTokens: 0,
        totalTokens: 5,
        cacheHitTokens: 0,
        cacheMissTokens: 2,
      },
      truncated: false,
    },
  }))
  const registry = new ToolRegistry()
  registerSubagentTools(registry, { runOne })
  return { registry, executor: new ToolExecutor(registry), runOne }
}

describe('subagent_run Tool', () => {
  it('publishes the tool-access schema and delegation guidance', () => {
    const { registry } = fixture()
    const definition = registry.get('subagent_run')!
    const provider = registry
      .providerDefinitions()
      .find((candidate) => candidate.name === 'subagent_run')!

    expect(definition.executionMode).toBe('parallel')
    expect(definition.defaultTimeoutMs).toBe(30_000)
    expect(definition.description).toContain('self-contained')
    expect(definition.description).toContain('final assistant response')
    expect(definition.description).not.toContain('last call')
    const inputSchema = provider.inputSchema as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(inputSchema.properties)).toEqual([
      'name',
      'task',
      'toolAccess',
      '_agent_intent',
    ])
  })

  it('accepts Unicode and rejects unsafe or oversized values', () => {
    const { executor } = fixture()
    const inspect = (name: string, task = '检查当前项目') =>
      executor.inspectCall({
        id: 'call:test' as CallId,
        toolId: 'subagent_run',
        args: { name, task, toolAccess: 'readonly' },
        reason: '',
      })

    expect(inspect(` ${'界'.repeat(64)} `).ok).toBe(true)
    for (const name of [
      '',
      '界'.repeat(65),
      '__proto__',
      'constructor',
      'prototype',
      'line\nbreak',
      `format\u200bmark`,
    ]) {
      expect(inspect(name).ok, name).toBe(false)
    }
    expect(inspect('worker', ' '.repeat(8)).ok).toBe(false)
    expect(inspect('worker', 'x'.repeat(32_769)).ok).toBe(false)
  })

  it('trims and delegates the task as plain input', async () => {
    const { registry, runOne } = fixture()
    const definition = registry.get('subagent_run')!
    const controller = new AbortController()
    const result = await definition.execute(
      { name: ' 调查 ', task: ' 直接检查 README ', toolAccess: 'inherit' },
      {
        sessionId: 'session:parent' as SessionId,
        runId: 'run:parent' as RunId,
        workspace: { canonicalPath: '/workspace' },
        signal: controller.signal,
        approvedCall: {
          sessionId: 'session:parent' as SessionId,
          runId: 'run:parent' as RunId,
          callId: 'call:subagent' as CallId,
          toolId: 'subagent_run',
          args: {
            name: ' 调查 ',
            task: ' 直接检查 README ',
            toolAccess: 'inherit',
          },
          approvedBy: 'policy',
          approvedAt: new Date(0).toISOString(),
        } as never,
      },
    )

    expect(runOne).toHaveBeenCalledWith(
      { name: '调查', task: '直接检查 README', toolAccess: 'inherit' },
      expect.objectContaining({
        sessionId: 'session:parent',
        runId: 'run:parent',
        callId: 'call:subagent',
        workspace: '/workspace',
        signal: controller.signal,
      }),
    )
    expect(result).toMatchObject({
      status: 'ok',
      content: { results: { 调查: '直接返回的结果' } },
    })
  })
})
