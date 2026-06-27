import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { ApprovedToolCall } from '../tools/approved-tool-call'
import { ChangeHistoryStore } from './change-history'

async function harness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-changes-'))
  const workspace = path.join(directory, 'workspace')
  await mkdir(workspace)
  const store = new ChangeHistoryStore(path.join(directory, 'changes.json'))
  await store.initialize()
  return { workspace, store }
}

function approvedCall(input: {
  workspace: string
  operation: 'write' | 'patch' | 'delete'
  beforeExists: boolean
  before: string
  after: string
}): ApprovedToolCall {
  return {
    sessionId: 'session-1' as SessionId,
    runId: 'run-1' as RunId,
    callId: 'call-1' as CallId,
    toolId:
      input.operation === 'write'
        ? 'create_file'
        : input.operation === 'patch'
          ? 'apply_patch'
          : 'delete_file',
    args: { path: 'note.txt' },
    argsHash: 'args',
    approvedBy: 'human',
    approvedAt: new Date().toISOString(),
    resourcePreconditions: [
      {
        kind: 'file',
        operation: input.operation,
        path: 'note.txt',
        absolutePath: path.join(input.workspace, 'note.txt'),
        parentRealPath: input.workspace,
        expectedParentId: 'parent',
        expectedExists: input.beforeExists,
        expectedContent: input.before,
        expectedContentHash: 'before',
        expectedResultContent: input.after,
        expectedResultHash: 'after',
      },
    ],
  } as unknown as ApprovedToolCall
}

describe('ChangeHistoryStore', () => {
  it('persists a conversation change and safely restores its previous content', async () => {
    const { workspace, store } = await harness()
    await writeFile(path.join(workspace, 'note.txt'), 'after', 'utf8')
    const change = await store.record({
      conversationId: 'conversation-1',
      workspace,
      approvedCall: approvedCall({
        workspace,
        operation: 'patch',
        beforeExists: true,
        before: 'before',
        after: 'after',
      }),
      diff: '--- a/note.txt\n+++ b/note.txt\n',
    })

    expect(store.list('conversation-1', workspace)).toHaveLength(1)
    const reverted = await store.revert({
      id: change!.id,
      conversationId: 'conversation-1',
      workspace,
    })
    expect(await readFile(path.join(workspace, 'note.txt'), 'utf8')).toBe(
      'before',
    )
    expect(reverted.revertedAt).toEqual(expect.any(String))
  })

  it('refuses to overwrite content changed after the recorded agent edit', async () => {
    const { workspace, store } = await harness()
    const target = path.join(workspace, 'note.txt')
    await writeFile(target, 'after', 'utf8')
    const change = await store.record({
      conversationId: 'conversation-1',
      workspace,
      approvedCall: approvedCall({
        workspace,
        operation: 'patch',
        beforeExists: true,
        before: 'before',
        after: 'after',
      }),
      diff: 'diff',
    })
    await writeFile(target, 'newer user work', 'utf8')

    await expect(
      store.revert({
        id: change!.id,
        conversationId: 'conversation-1',
        workspace,
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CHANGED',
    })
    expect(await readFile(target, 'utf8')).toBe('newer user work')
  })

  it('removes a file created by the agent when reverting', async () => {
    const { workspace, store } = await harness()
    const target = path.join(workspace, 'note.txt')
    await writeFile(target, 'created', 'utf8')
    const change = await store.record({
      conversationId: 'conversation-1',
      workspace,
      approvedCall: approvedCall({
        workspace,
        operation: 'write',
        beforeExists: false,
        before: '',
        after: 'created',
      }),
      diff: 'diff',
    })

    await store.revert({
      id: change!.id,
      conversationId: 'conversation-1',
      workspace,
    })
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('restores a file deleted by the agent when reverting', async () => {
    const { workspace, store } = await harness()
    const target = path.join(workspace, 'note.txt')
    const change = await store.record({
      conversationId: 'conversation-1',
      workspace,
      approvedCall: approvedCall({
        workspace,
        operation: 'delete',
        beforeExists: true,
        before: 'deleted content',
        after: '',
      }),
      diff: 'diff',
    })

    await store.revert({
      id: change!.id,
      conversationId: 'conversation-1',
      workspace,
    })
    expect(await readFile(target, 'utf8')).toBe('deleted content')
  })
})
