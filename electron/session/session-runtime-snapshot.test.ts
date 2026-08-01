import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { ActiveRun } from './session-types'
import { updatePublicRunSnapshot } from './session-runtime-snapshot'

function activeRun(): ActiveRun {
  return {
    publicSnapshot: {
      schemaVersion: 1,
      sessionId: 'session:runtime-snapshot' as SessionId,
      runId: 'run:runtime-snapshot' as RunId,
      status: 'running_tools',
      text: 'previous assistant segment',
      reasoning: 'previous reasoning segment',
      tools: [],
      interjections: [],
    },
    publicTools: new Map(),
  } as unknown as ActiveRun
}

describe('public run snapshot', () => {
  it('starts a clean streaming overlay for each provider generation', () => {
    const run = activeRun()

    updatePublicRunSnapshot(run, {
      type: 'run.status',
      sessionId: run.publicSnapshot.sessionId,
      runId: run.publicSnapshot.runId,
      status: 'calling_llm',
    })
    expect(run.publicSnapshot).toMatchObject({
      status: 'calling_llm',
      text: '',
      reasoning: '',
    })

    updatePublicRunSnapshot(run, {
      type: 'assistant.text.delta',
      sessionId: run.publicSnapshot.sessionId,
      runId: run.publicSnapshot.runId,
      delta: 'current output',
    })
    updatePublicRunSnapshot(run, {
      type: 'tool.proposed',
      sessionId: run.publicSnapshot.sessionId,
      runId: run.publicSnapshot.runId,
      callId: 'call:runtime-snapshot' as CallId,
      tool: 'read_file',
      args: { path: 'README.md' },
      reason: 'Read it',
    })
    expect(run.publicSnapshot.text).toBe('current output')
    expect(run.publicSnapshot.tools).toHaveLength(1)
  })
})
