import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkbenchStore } from './store'
import type { ConversationRecord } from '../../shared/workbench'

function conversation(id: string, projectPath: string): ConversationRecord {
  return {
    id,
    projectPath,
    title: 'Review workbench',
    model: 'deepseek-chat',
    mode: 'auto',
    messages: [
      {
        id: `message:${id}`,
        role: 'user',
        text: 'hello',
        reasoning: '',
      },
    ],
    tools: [],
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z',
  }
}

describe('WorkbenchStore', () => {
  it('persists a versioned main-process workbench file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workbench-'))
    const filePath = path.join(directory, 'workbench.json')
    const store = new WorkbenchStore(filePath)

    await expect(store.initialize()).resolves.toEqual({
      projects: [],
      conversations: [],
    })
    await store.saveSnapshot({
      projects: [],
      conversations: [conversation('conversation:one', 'F:/workspace/app')],
      activeConversationId: 'conversation:one',
    })

    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: number
      workbench: unknown
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(store.getSnapshot()).toMatchObject({
      projects: [{ path: 'F:/workspace/app', name: 'app' }],
      activeConversationId: 'conversation:one',
    })
  })

  it('merges legacy renderer history without replacing existing records', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workbench-'))
    const store = new WorkbenchStore(path.join(directory, 'workbench.json'))
    await store.initialize()
    await store.saveSnapshot({
      projects: [],
      conversations: [conversation('conversation:one', 'F:/workspace/new')],
      activeConversationId: 'conversation:one',
    })

    await store.mergeSnapshot({
      projects: [],
      conversations: [
        conversation('conversation:one', 'F:/workspace/legacy'),
        conversation('conversation:two', 'F:/workspace/legacy'),
      ],
      activeConversationId: 'conversation:two',
    })

    expect(store.getSnapshot().conversations).toMatchObject([
      { id: 'conversation:one', projectPath: 'F:/workspace/new' },
      { id: 'conversation:two', projectPath: 'F:/workspace/legacy' },
    ])
    expect(store.getSnapshot().activeConversationId).toBe('conversation:one')
  })
})
