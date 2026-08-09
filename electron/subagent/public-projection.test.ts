import { describe, expect, it } from 'vitest'
import type {
  AgentExecutionId,
  CallId,
  MessageId,
  RunId,
  SessionId,
} from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import {
  FIXTURE_TIMESTAMP,
  messageFixtures,
  sessionFixture,
} from '../persistence/repository-fixtures'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import {
  projectAgentExecutionActivities,
  projectAgentExecutionSummary,
  projectAgentExecutionTask,
} from './public-projection'

const parentSessionId = 'session:projection-parent' as SessionId
const childSessionId = 'session:projection-child' as SessionId

function execution(): SubagentExecutionRecord {
  return {
    id: 'subagent:projection' as AgentExecutionId,
    kind: 'subagent',
    name: 'fallbackWorker',
    parentSessionId,
    parentRunId: 'run:projection' as RunId,
    parentCallId: 'call:projection' as CallId,
    specHash: 'a'.repeat(64),
    status: 'completed',
    route: {
      schemaVersion: 1,
      main: {
        providerId: 'deepseek',
        model: 'deepseek-chat',
        endpoint: 'https://secret.invalid/v1',
        apiKey: 'must-not-project',
      },
    },
    sourceIdentity: { hiddenSessionId: childSessionId },
    usage: {
      records: 2,
      promptTokens: 20,
      completionTokens: 8,
      reasoningTokens: 3,
      totalTokens: 28,
      cacheHitTokens: 4,
      cacheMissTokens: 16,
    },
    result: { results: { fallbackWorker: 'done' } },
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    completedAt: FIXTURE_TIMESTAMP,
  }
}

describe('Subagent public projection', () => {
  it('exposes only safe summary identity and usage fields', () => {
    const summary = projectAgentExecutionSummary(execution(), {
      child: sessionFixture({
        id: childSessionId,
        title: 'Subagent: repository-review',
      }),
    })

    expect(summary).toMatchObject({
      id: 'subagent:projection',
      kind: 'subagent',
      parentSessionId,
      name: 'fallbackWorker',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      status: 'completed',
      usage: { records: 2, totalTokens: 28 },
    })
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('secret.invalid')
    expect(serialized).not.toContain('must-not-project')
    expect(serialized).not.toContain(childSessionId)
  })

  it('keeps plaintext reasoning and ordered messages while merging tools', () => {
    const visible = messageFixtures(childSessionId)
    const firstAssistant = visible[1]
    if (firstAssistant?.kind !== 'assistant_turn') {
      throw new Error('Expected assistant fixture')
    }
    firstAssistant.providerContinuation = {
      schemaVersion: 2,
      providerType: 'openai.responses',
      format: 'encrypted-reasoning-v1',
      data: { encrypted_content: 'ciphertext-must-not-project' },
    }
    const hidden = structuredClone(visible[3]!)
    hidden.id = 'message:hidden' as MessageId
    hidden.seq = 5
    hidden.visibility = 'hidden'
    if (hidden.kind === 'assistant_turn') {
      hidden.parts = [{ type: 'text', text: 'hidden answer' }]
      hidden.normalizedReasoningText = 'hidden reasoning'
    }
    const superseded = structuredClone(visible[3]!)
    superseded.id = 'message:superseded' as MessageId
    superseded.seq = 6
    superseded.visibility = 'superseded'
    superseded.inHistory = false
    if (superseded.kind === 'assistant_turn') {
      superseded.parts = [{ type: 'text', text: 'superseded answer' }]
    }

    const activities = projectAgentExecutionActivities([
      superseded,
      ...visible,
      hidden,
    ])

    expect(activities.map((activity) => activity.type)).toEqual([
      'reasoning',
      'message',
      'tool',
      'message',
    ])
    expect(activities[0]).toMatchObject({
      type: 'reasoning',
      text: 'Use the file tool.',
    })
    expect(activities[2]).toMatchObject({
      type: 'tool',
      tool: 'read_file',
      status: 'completed',
      result: { type: 'tool_result', isError: false },
    })
    const serialized = JSON.stringify(activities)
    expect(serialized).not.toContain('ciphertext-must-not-project')
    expect(serialized).not.toContain('hidden answer')
    expect(serialized).not.toContain('hidden reasoning')
    expect(serialized).not.toContain('superseded answer')
  })

  it('extracts only the first visible user task text', () => {
    const task = messageFixtures(childSessionId)[0]
    expect(task?.kind).toBe('user_input')
    expect(
      projectAgentExecutionTask(task?.kind === 'user_input' ? task : undefined),
    ).toBe('visible search needle')
    expect(projectAgentExecutionTask(undefined)).toBeUndefined()
  })

  it('creates a completed placeholder when a page starts at a tool result', () => {
    const result = messageFixtures(childSessionId)[2]
    const activities = projectAgentExecutionActivities(
      result ? ([result] satisfies MessageRecord[]) : [],
    )

    expect(activities).toEqual([
      expect.objectContaining({
        type: 'tool',
        tool: 'read_file',
        status: 'completed',
      }),
    ])
  })
})
