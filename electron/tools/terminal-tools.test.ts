import { describe, expect, it, vi } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { TerminalPool } from '../terminal/pool'
import { evaluatePolicy } from '../permission/policy-engine'
import { normalizeTerminalInput, registerTerminalTools } from './terminal-tools'
import { ToolRegistry } from './tool-registry'

function definitions() {
  const registry = new ToolRegistry()
  registerTerminalTools(registry, {} as TerminalPool, () => 100_000)
  return registry
}

function outcome(
  toolId: string,
  mode: 'readonly' | 'auto' | 'confirm' | 'yolo',
) {
  const definition = definitions().get(toolId)

  if (!definition) {
    throw new Error(`Missing terminal tool: ${toolId}`)
  }

  return evaluatePolicy({
    mode,
    definition,
    effectiveRisk: definition.defaultRisk,
    policySignals: [],
    rememberedRules: [],
    builtinPolicies: true,
    workspace: 'F:/workspace',
    args: {},
    callId: 'call:terminal-policy' as CallId,
  }).kind
}

describe('terminal tool permission matrix', () => {
  it('presses Enter automatically without duplicating an existing terminator', () => {
    expect(normalizeTerminalInput('echo one', 'win32')).toBe('echo one\r')
    expect(normalizeTerminalInput('echo one\n', 'win32')).toBe('echo one\r')
    expect(normalizeTerminalInput('one\r\ntwo\nthree\r', 'win32')).toBe(
      'one\r\ntwo\rthree\r',
    )
    expect(normalizeTerminalInput('echo one', 'linux')).toBe('echo one\n')
    expect(normalizeTerminalInput('echo one\n', 'linux')).toBe('echo one\n')
  })

  it.each(['terminal_open', 'terminal_send', 'terminal_close'])(
    'routes %s through side-effect policy',
    (toolId) => {
      expect(outcome(toolId, 'readonly')).toBe('deny')
      expect(outcome(toolId, 'auto')).toBe('model')
      expect(outcome(toolId, 'confirm')).toBe('review')
      expect(outcome(toolId, 'yolo')).toBe('allow')
    },
  )

  it.each(['terminal_read', 'terminal_list'])(
    'fast-paths %s as an owned read-only operation',
    (toolId) => {
      expect(outcome(toolId, 'readonly')).toBe('allow')
      expect(outcome(toolId, 'auto')).toBe('allow')
      expect(outcome(toolId, 'confirm')).toBe('allow')
      expect(outcome(toolId, 'yolo')).toBe('allow')
    },
  )

  it('no longer exposes terminal_resize to the model', () => {
    expect(definitions().get('terminal_resize')).toBeUndefined()
  })

  it('ignores a model-supplied shell on terminal_open', () => {
    const registry = definitions()
    const definition = registry.get('terminal_open')!

    expect(registry.validateArgs(definition, {}).ok).toBe(true)
    expect(registry.validateArgs(definition, { shell: '/bin/sh' })).toEqual({
      ok: true,
      args: {},
    })
  })

  it('reports that terminal_open starts the configured shell process', () => {
    const definition = definitions().get('terminal_open')!

    expect(definition.effects).toEqual(['process.spawn', 'terminal.write'])
    expect(definition.description).toContain('does not submit a command')
  })

  it('coerces a numeric terminal id and rejects invalid identifiers', () => {
    const registry = definitions()
    const definition = registry.get('terminal_send')!
    const args = { terminalId: 1, data: 'npm test' }

    expect(registry.validateArgs(definition, args).ok).toBe(true)
    expect(
      registry.validateArgs(definition, { ...args, terminalId: '1' }),
    ).toMatchObject({ ok: true, args: { terminalId: 1 } })
    for (const invalid of ['terminal:1', 0, -2, 1.5]) {
      expect(
        registry.validateArgs(definition, { ...args, terminalId: invalid }).ok,
      ).toBe(false)
    }
  })

  it('accepts a bounded optional post-write delay', () => {
    const registry = definitions()
    const definition = registry.get('terminal_send')!
    const args = {
      terminalId: 7,
      data: 'npm test',
    }

    expect(registry.validateArgs(definition, args).ok).toBe(true)
    expect(registry.validateArgs(definition, { ...args, delayMs: 1 }).ok).toBe(
      true,
    )
    expect(
      registry.validateArgs(definition, { ...args, delayMs: 60_000 }).ok,
    ).toBe(true)
    expect(registry.validateArgs(definition, { ...args, delayMs: 0 }).ok).toBe(
      false,
    )
    expect(
      registry.validateArgs(definition, { ...args, delayMs: 60_001 }).ok,
    ).toBe(false)
  })

  it('writes immediately, then waits before returning', async () => {
    vi.useFakeTimers()
    try {
      const write = vi.fn(() => true)
      const registry = new ToolRegistry()
      registerTerminalTools(
        registry,
        { write } as unknown as TerminalPool,
        () => 100_000,
      )
      const definition = registry.get('terminal_send')!
      const controller = new AbortController()
      let settled = false
      const result = definition
        .execute(
          {
            terminalId: 7,
            data: 'echo delayed',
            delayMs: 250,
          },
          {
            sessionId: 'session:delay' as SessionId,
            runId: 'run:delay' as RunId,
            workspace: { canonicalPath: 'F:\\workspace' },
            signal: controller.signal,
          } as never,
        )
        .then((value) => {
          settled = true
          return value
        })

      expect(write).toHaveBeenCalledWith(
        'session:delay',
        7,
        normalizeTerminalInput('echo delayed'),
      )
      await vi.advanceTimersByTimeAsync(249)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(result).resolves.toMatchObject({
        status: 'ok',
        content: { accepted: true, waitedMs: 250 },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait when the terminal rejects input', async () => {
    vi.useFakeTimers()
    try {
      const registry = new ToolRegistry()
      registerTerminalTools(
        registry,
        { write: vi.fn(() => false) } as unknown as TerminalPool,
        () => 100_000,
      )
      const definition = registry.get('terminal_send')!

      await expect(
        definition.execute(
          {
            terminalId: 8,
            data: 'ignored',
            delayMs: 60_000,
          },
          {
            sessionId: 'session:delay' as SessionId,
            runId: 'run:delay' as RunId,
            workspace: { canonicalPath: 'F:\\workspace' },
            signal: new AbortController().signal,
          } as never,
        ),
      ).resolves.toEqual({
        status: 'ok',
        content: { accepted: false },
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels only the post-write wait after input was accepted', async () => {
    const write = vi.fn(() => true)
    const registry = new ToolRegistry()
    registerTerminalTools(
      registry,
      { write } as unknown as TerminalPool,
      () => 100_000,
    )
    const definition = registry.get('terminal_send')!
    const controller = new AbortController()
    const result = definition.execute(
      {
        terminalId: 9,
        data: 'start',
        delayMs: 60_000,
      },
      {
        sessionId: 'session:delay' as SessionId,
        runId: 'run:delay' as RunId,
        workspace: { canonicalPath: 'F:\\workspace' },
        signal: controller.signal,
      } as never,
    )

    controller.abort(new Error('stop waiting'))
    await expect(result).rejects.toThrow('stop waiting')
    expect(write).toHaveBeenCalledOnce()
  })
})
