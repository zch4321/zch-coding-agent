import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { AgentEvent } from '../../shared/agent-events'
import type { RunId, SessionId } from '../../shared/ids'
import type { TraceId } from '../../shared/trace'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
} from '../../shared/notices'
import { ConfigStore } from '../config/store'
import { SecretStore, type SafeStorageAdapter } from '../config/secret-store'
import { fetchDeepSeekModelCatalog } from './model-catalog'
import { SkillsManager } from '../skills/manager'
import { TraceService } from '../logging/service'
import { SessionManager } from './session-manager'

const live = process.env.RUN_REAL_API_TESTS === '1'
const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? ''
const baseURL =
  process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com'
const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat'
const sentinel = `LIVE_ENDPOINT_SENTINEL_${Date.now()}`
const managers: SessionManager[] = []

class TestSafeStorage implements SafeStorageAdapter {
  readonly platform = 'win32'

  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return true
  }

  getSelectedStorageBackend(): string {
    return 'test'
  }

  async encryptStringAsync(value: string): Promise<Buffer> {
    return Buffer.from(value)
  }

  async decryptStringAsync(
    value: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }> {
    return { result: value.toString('utf8'), shouldReEncrypt: false }
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error('Timed out waiting for the real API run')
}

function safeRunSummary(events: AgentEvent[], runId: RunId): string {
  const tools = events.flatMap((event) =>
    event.type === 'tool.proposed' && event.runId === runId ? [event.tool] : [],
  )
  const statuses = events.flatMap((event) =>
    event.type === 'run.status' && event.runId === runId ? [event.status] : [],
  )
  const approvals = events.filter(
    (event) => event.type === 'approval.requested' && event.runId === runId,
  ).length
  return JSON.stringify({ statuses, tools, approvals })
}

async function waitForConfirmedWrite(input: {
  manager: SessionManager
  events: AgentEvent[]
  sessionId: SessionId
  runId: RunId
  expectedPath: string
  expectedContent: string
  tracePath: string
  timeoutMs?: number
}): Promise<void> {
  const handledApprovals = new Set<number>()
  const deadline = Date.now() + (input.timeoutMs ?? 240_000)

  while (Date.now() < deadline) {
    for (const event of input.events) {
      if (
        event.type !== 'approval.requested' ||
        event.runId !== input.runId ||
        handledApprovals.has(event.seq)
      ) {
        continue
      }

      handledApprovals.add(event.seq)
      const args =
        event.args &&
        typeof event.args === 'object' &&
        !Array.isArray(event.args)
          ? event.args
          : undefined
      const exactExpectedWrite =
        event.kind === 'tool' &&
        event.tool === 'write_file' &&
        args?.path === input.expectedPath &&
        args?.content === input.expectedContent
      input.manager.decideApproval({
        sessionId: input.sessionId,
        runId: input.runId,
        callId: event.callId,
        decision: exactExpectedWrite ? 'allow' : 'deny',
      })
    }

    const final = input.events
      .filter(
        (event) =>
          event.type === 'run.status' &&
          event.runId === input.runId &&
          (event.status === 'completed' ||
            event.status === 'failed' ||
            event.status === 'cancelled'),
      )
      .at(-1)

    if (final?.type === 'run.status') {
      expect(final.status).toBe('completed')
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error(
    `Timed out waiting for confirmed write. Trace: ${input.tracePath}. Events: ${safeRunSummary(input.events, input.runId)}`,
  )
}

async function liveHarness() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-real-api-'))
  console.info(`[real-api] artifacts: ${directory}`)
  const workspace = path.join(directory, 'workspace')
  const skillsDirectory = path.join(directory, 'skills')
  await mkdir(workspace)
  await mkdir(skillsDirectory)
  await writeFile(
    path.join(workspace, 'README.md'),
    `# Live endpoint fixture\n${sentinel}\n`,
  )
  await writeFile(
    path.join(skillsDirectory, 'live_verify.md'),
    [
      '---',
      'name: live_verify',
      'description: Verify the live endpoint tool loop.',
      'trigger: live endpoint verification',
      '---',
      `Read README.md and reproduce ${sentinel} exactly in the final answer.`,
      '',
    ].join('\n'),
  )
  const store = new ConfigStore(
    path.join(directory, 'config.json'),
    new SecretStore(
      path.join(directory, 'secrets.json'),
      new TestSafeStorage(),
    ),
    { environmentApiKey: apiKey },
  )
  await store.initialize()
  await store.update({
    version: 1,
    kind: 'provider',
    baseURL,
    model,
    reasoning: 'auto',
  })
  await store.update({
    version: 1,
    kind: 'privacy',
    providerNoticeAccepted: {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: new Date().toISOString(),
    },
    traceNoticeAccepted: {
      version: TRACE_NOTICE_VERSION,
      acceptedAt: new Date().toISOString(),
    },
  })
  await store.update({
    version: 1,
    kind: 'logging',
    value: { ...store.getPublicConfig().logging, enabled: true },
  })
  const skills = new SkillsManager(skillsDirectory)
  await skills.initialize()
  await skills.setEnabled('live_verify', true)
  const events: AgentEvent[] = []
  const webContents = {
    isDestroyed: () => false,
    send: (_channel: string, envelope: { event: AgentEvent }) => {
      events.push(envelope.event)
    },
  } as WebContents
  const manager = new SessionManager({
    configStore: store,
    traceDirectory: path.join(directory, 'traces'),
    getWebContents: () => webContents,
    skillsManager: skills,
  })
  managers.push(manager)
  return { directory, workspace, store, events, manager }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()))
})

describe.skipIf(!live)('real DeepSeek endpoint', () => {
  it('authenticates against the model catalog without exposing the credential', async () => {
    expect(apiKey).not.toBe('')
    const models = await fetchDeepSeekModelCatalog({ baseURL, apiKey })
    expect(models.length).toBeGreaterThan(0)
    expect(JSON.stringify(models)).not.toContain(apiKey)
  }, 120_000)

  it('runs skills, readonly tools, confirmed writes, continuation, and trace through the live provider', async () => {
    expect(apiKey).not.toBe('')
    const { directory, workspace, events, manager } = await liveHarness()
    const readSessionId = await manager.createSession({
      workspace,
      mode: 'readonly',
      provider: 'deepseek',
    })
    const readRunId = manager.startRun({
      sessionId: readSessionId,
      message:
        'For live endpoint verification, first call read_skill with live_verify, then call read_file for README.md, and finally follow the skill exactly.',
      clientRequestId: 'real-read-run',
    })

    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'run.status' &&
          event.runId === readRunId &&
          (event.status === 'completed' || event.status === 'failed'),
      ),
    )
    expect(
      events
        .filter(
          (event) => event.type === 'run.status' && event.runId === readRunId,
        )
        .at(-1),
    ).toMatchObject({ status: 'completed' })
    expect(
      events
        .filter((event) => event.type === 'tool.proposed')
        .map((event) => event.tool),
    ).toEqual(expect.arrayContaining(['read_skill', 'read_file']))
    expect(
      events
        .filter((event) => event.type === 'assistant.text.delta')
        .map((event) => event.delta)
        .join(''),
    ).toContain(sentinel)
    await manager.closeSession(readSessionId)

    const traceService = new TraceService(path.join(directory, 'traces'))
    const readTraceId = readSessionId as unknown as TraceId
    const replay = await traceService.replay(readTraceId)
    expect(replay.closed).toBe(true)
    expect(replay.forkPoints.length).toBeGreaterThan(0)
    expect(
      (await traceService.stats(readTraceId)).requestCount,
    ).toBeGreaterThan(0)
    const lastForkPoint = replay.forkPoints.at(-1)!
    const preparedFork = await manager.createForkFromTrace(
      await traceService.forkPoint(readTraceId, lastForkPoint.eventId),
    )
    const forkRunId = manager.startForkRun(preparedFork.sessionId)
    await waitFor(() =>
      events.some(
        (event) =>
          event.type === 'run.status' &&
          event.runId === forkRunId &&
          (event.status === 'completed' || event.status === 'failed'),
      ),
    )
    expect(
      events
        .filter(
          (event) => event.type === 'run.status' && event.runId === forkRunId,
        )
        .at(-1),
    ).toMatchObject({ status: 'completed' })
    await manager.closeSession(preparedFork.sessionId)

    const writeSessionId = await manager.createSession({
      workspace,
      mode: 'confirm',
      provider: 'deepseek',
    })
    const writeRunId = manager.startRun({
      sessionId: writeSessionId,
      message: `Use write_file to create live-created.txt with the exact content ${sentinel}.`,
      clientRequestId: 'real-write-run',
    })
    await waitForConfirmedWrite({
      manager,
      events,
      sessionId: writeSessionId,
      runId: writeRunId,
      expectedPath: 'live-created.txt',
      expectedContent: sentinel,
      tracePath: path.join(directory, 'traces', `${writeSessionId}.jsonl`),
    })
    expect(
      await readFile(path.join(workspace, 'live-created.txt'), 'utf8'),
    ).toBe(sentinel)
    await manager.closeSession(writeSessionId)

    const traces = await readFile(
      path.join(directory, 'traces', `${writeSessionId}.jsonl`),
      'utf8',
    )
    expect(traces).toContain('llm.request')
    expect(traces).toContain('tool.call')
    expect(traces).not.toContain(apiKey)
  }, 300_000)
})
