import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { AgentApi } from '../shared/agent-api'
import { configureApp } from './support/app-helpers'
import {
  providerMessages,
  providerToolNames,
  textDelta,
  toolCallDelta,
  toolCallsDelta,
  type JsonObject,
} from './support/fake-provider'
import {
  disposeFeatureHarness,
  launchFeatureHarness,
  type FeatureHarness,
} from './support/feature-harness'

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.describe('Run-scoped exec commands', () => {
  let harness: FeatureHarness
  test.beforeEach(async () => {
    harness = await launchFeatureHarness()
  })
  test.afterEach(async () => {
    await disposeFeatureHarness(harness)
  })

  test('caps an excessive exec wait before approval and executes the normalized call', async () => {
    const { page, fakeProvider, workspace } = harness
    fakeProvider.queue([
      toolCallDelta({
        id: 'exec-capped-wait',
        name: 'exec_command',
        args: {
          executable: 'node',
          args: ['-e', "process.stdout.write('CAPPED_WAIT_OK')"],
          yieldTimeMs: 900_000,
          _agent_intent: 'Print a marker and wait for the process to finish',
        },
      }),
    ])
    fakeProvider.queue([textDelta('Capped wait completed.')])
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
    })
    await page.reload()
    await expect(page.getByTestId('app-ready')).toBeVisible()
    await page
      .locator('.message-input-area textarea')
      .fill('Run the wait fixture.')
    await page.getByRole('button', { name: '发送消息' }).click()
    const approval = page.locator('.approval-card')
    await expect(approval).toContainText('yieldTimeMs')
    await expect(approval).toContainText('60000')
    await expect(approval).not.toContainText('900000')
    await approval.getByRole('button', { name: '批准', exact: true }).click()
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Capped wait completed.',
    )
    const result = providerMessages(fakeProvider.requests[1]!.body).find(
      (message) => message.toolCallId === 'exec-capped-wait',
    )!.content!
    expect(result).toContain('CAPPED_WAIT_OK')
    expect(JSON.parse(result.split('\n')[0]!)).toMatchObject({
      state: 'exited',
      exitCode: 0,
    })
  })

  test('continues stdin with explicit approvals, polls without approval, and never opens Terminal', async () => {
    const { page, fakeProvider, workspace } = harness
    const inputFile = path.join(workspace, 'input.txt')
    const script = `const fs=require('node:fs');process.stdin.on('data',x=>fs.appendFileSync(${JSON.stringify(inputFile)},x));process.stdin.on('end',()=>process.stdout.write('EXEC_INPUT_COMPLETE'))`
    fakeProvider.queue([
      toolCallDelta({
        id: 'exec-start',
        name: 'exec_command',
        args: {
          executable: 'node',
          args: ['-e', script],
          yieldTimeMs: 0,
          _agent_intent: 'Launch a pipe input fixture',
        },
      }),
    ])
    const continuation: JsonObject[] = []
    fakeProvider.armResponseGate([2])
    fakeProvider.queue(continuation, { gate: true })
    fakeProvider.queue([textDelta('Exec input completed.')])
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'confirm',
    })
    await page.reload()
    await page
      .locator('.message-input-area textarea')
      .fill('Exercise exec stdin.')
    await page.getByRole('button', { name: '发送消息' }).click()
    const approval = page.locator('.approval-card')
    await expect(approval).toContainText('exec_command')
    await approval.getByRole('button', { name: '批准', exact: true }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    const started = providerMessages(fakeProvider.requests[1]!.body).find(
      (message) => message.toolCallId === 'exec-start',
    )!
    const metadata = JSON.parse(started.content!.split('\n')[0]!) as {
      sessionId: string
      state: string
    }
    expect(metadata.state).toBe('running')
    expect(providerToolNames(fakeProvider.requests[0]!.body)).toContain(
      'exec_command',
    )
    expect(providerToolNames(fakeProvider.requests[0]!.body)).not.toContain(
      'run_command',
    )
    continuation.push(
      toolCallsDelta([
        {
          id: 'exec-poll',
          name: 'exec_command',
          args: {
            sessionId: metadata.sessionId,
            yieldTimeMs: 0,
            _agent_intent: 'Read current output',
          },
        },
        {
          id: 'exec-raw',
          name: 'exec_command',
          args: {
            sessionId: metadata.sessionId,
            chars: 'raw',
            yieldTimeMs: 0,
            _agent_intent: 'Send exact bytes',
          },
        },
        {
          id: 'exec-line',
          name: 'exec_command',
          args: {
            sessionId: metadata.sessionId,
            command: 'line',
            closeStdin: true,
            _agent_intent: 'Submit a line and close input',
          },
        },
      ]),
    )
    fakeProvider.releaseResponseGate()
    await expect(approval).toContainText('raw')
    await expect(approval).toContainText('Write stdin/EOF to existing process:')
    await expect(approval).toContainText('input.txt')
    await approval.getByRole('button', { name: '批准', exact: true }).click()
    await expect(approval).toContainText('closeStdin')
    await approval.getByRole('button', { name: '批准', exact: true }).click()
    await expect(page.locator('.chat-message.assistant')).toContainText(
      'Exec input completed.',
    )
    expect(await readFile(inputFile, 'utf8')).toBe('rawline\n')
    const resultText = providerMessages(fakeProvider.requests[2]!.body).find(
      (message) => message.toolCallId === 'exec-line',
    )!.content!
    expect(resultText).toContain('EXEC_INPUT_COMPLETE')
    expect(JSON.parse(resultText.split('\n')[0]!)).toMatchObject({
      state: 'exited',
      exitCode: 0,
      stdinClosed: true,
    })
    await expect(page.locator('.terminal-panel')).toBeHidden()
  })

  test('stops yielded exec on main Run stop while retaining an independent Terminal', async () => {
    const { page, fakeProvider, workspace } = harness
    const pidFile = path.join(workspace, 'exec-pid.txt')
    const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`
    fakeProvider.queue([
      toolCallDelta({
        id: 'exec-long',
        name: 'exec_command',
        args: {
          executable: 'node',
          args: ['-e', script],
          yieldTimeMs: 0,
          _agent_intent: 'Run until interrupted',
        },
      }),
    ])
    fakeProvider.armResponseGate([2])
    fakeProvider.queue([textDelta('Waiting for stop.')], { gate: true })
    await configureApp({
      page,
      providerBaseURL: fakeProvider.origin,
      workspace,
      defaultMode: 'yolo',
    })
    await page.reload()
    await page
      .locator('.message-input-area textarea')
      .fill('Start an exec process.')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect.poll(() => fakeProvider.requests.length).toBe(2)
    let pid = 0
    await expect
      .poll(async () => {
        pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
        return pid > 0 && processExists(pid)
      })
      .toBe(true)
    const target = await page.evaluate(async () => {
      const api = Reflect.get(window, 'agentApi') as AgentApi
      const bootstrap = await api.getBootstrap({ version: 1 })
      if (!bootstrap.ok) throw Error(bootstrap.error.message)
      const sessionId = bootstrap.value.sessionPage.records[0]!.id
      const opened = await api.openTerminal({ version: 1, sessionId })
      if (!opened.ok) throw Error(opened.error.message)
      return { sessionId, terminalId: opened.value.terminal.terminalId }
    })
    await page.getByRole('button', { name: '停止运行' }).click()
    await expect.poll(() => processExists(pid), { timeout: 15000 }).toBe(false)
    expect(
      await page.evaluate(async ({ sessionId, terminalId }) => {
        const result = await (
          Reflect.get(window, 'agentApi') as AgentApi
        ).listTerminals({ version: 1, sessionId })
        if (!result.ok) throw Error(result.error.message)
        return result.value.terminals.find(
          (terminal) => terminal.terminalId === terminalId,
        )?.status
      }, target),
    ).toBe('running')
    fakeProvider.releaseResponseGate()
  })
})
