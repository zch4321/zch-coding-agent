import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCommandEnvironment, runCommand } from './run'

async function workspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agent-command-'))
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessesToExit(pids: number[]): Promise<boolean> {
  const deadline = Date.now() + 5_000

  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  return pids.every((pid) => !processExists(pid))
}

describe('runCommand', () => {
  it('runs process mode from the canonical workspace', async () => {
    const root = await workspace()
    const result = await runCommand({
      workspace: root,
      command: {
        mode: 'process',
        executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.cwd())'],
      },
      timeoutMs: 5_000,
      maxOutputBytes: 16_384,
      signal: new AbortController().signal,
    })

    expect(path.resolve(result.stdout)).toBe(path.resolve(await realpath(root)))
    expect(result.exitCode).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('drains 100MB output while retaining only the configured head and tail', async () => {
    const root = await workspace()
    const chunkBytes = 1_000_000
    const chunkCount = 100
    const outputScript = [
      `const chunk = Buffer.alloc(${chunkBytes}, 120)`,
      `let remaining = ${chunkCount}`,
      'function write() {',
      '  while (remaining > 0) {',
      '    remaining -= 1',
      "    if (!process.stdout.write(chunk)) return process.stdout.once('drain', write)",
      '  }',
      '}',
      'write()',
    ].join('\n')
    const result = await runCommand({
      workspace: root,
      command: {
        mode: 'process',
        executable: process.execPath,
        args: ['-e', outputScript],
      },
      timeoutMs: 30_000,
      maxOutputBytes: 4_096,
      signal: new AbortController().signal,
    })

    expect(Buffer.byteLength(result.stdout)).toBe(4_096)
    expect(result.totalBytes).toBe(100_000_000)
    expect(result.truncated).toBe(true)
    const discardedHash = createHash('sha256')
    let discarded = result.totalBytes - 4_096

    while (discarded > 0) {
      const size = Math.min(discarded, chunkBytes)
      discardedHash.update(Buffer.alloc(size, 120))
      discarded -= size
    }

    expect(result.discardedHash).toBe(discardedHash.digest('hex'))
  })

  it('times out and terminates five long-running processes', async () => {
    const root = await workspace()

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const result = await runCommand({
        workspace: root,
        command: {
          mode: 'process',
          executable: process.execPath,
          args: ['-e', 'setInterval(() => undefined, 1_000)'],
        },
        timeoutMs: 100,
        terminationGraceMs: 100,
        maxOutputBytes: 4_096,
        signal: new AbortController().signal,
      })

      expect(result.timedOut).toBe(true)
      expect(result.durationMs).toBeLessThan(5_000)
      expect(result.terminationStrategy).not.toBe('none')
    }
  })

  it.each([0, 1, 2])(
    'leaves no process behind after aborting spawn depth %i',
    async (depth) => {
      const root = await workspace()
      const script = path.join(root, 'nested.cjs')
      const pidFile = path.join(root, 'pids.txt')
      await writeFile(
        script,
        [
          "const { spawn } = require('node:child_process')",
          "const { appendFileSync } = require('node:fs')",
          'const [pidFile, depthValue] = process.argv.slice(2)',
          'const depth = Number(depthValue)',
          'appendFileSync(pidFile, `${process.pid}\\n`)',
          'if (depth > 0) {',
          "  spawn(process.execPath, [__filename, pidFile, String(depth - 1)], { stdio: 'ignore' })",
          '}',
          'setInterval(() => undefined, 1_000)',
        ].join('\n'),
        'utf8',
      )
      const controller = new AbortController()
      const abort = setTimeout(
        () => controller.abort(new Error('test abort')),
        500,
      )
      const result = await runCommand({
        workspace: root,
        command: {
          mode: 'process',
          executable: process.execPath,
          args: [script, pidFile, String(depth)],
        },
        timeoutMs: 10_000,
        terminationGraceMs: 100,
        maxOutputBytes: 4_096,
        signal: controller.signal,
      })
      clearTimeout(abort)
      const pids = (await readFile(pidFile, 'utf8'))
        .trim()
        .split(/\s+/u)
        .map(Number)

      expect(result.cancelled).toBe(true)
      expect(pids).toHaveLength(depth + 1)
      await expect(waitForProcessesToExit(pids)).resolves.toBe(true)
    },
  )

  it('constructs a secret-free child environment from an allowlist', () => {
    const environment = createCommandEnvironment({
      PATH: 'allowed',
      DEEPSEEK_API_KEY: 'provider-key-sentinel',
      INTERNAL_SECRET: 'internal-secret-sentinel',
    })

    expect(environment.PATH).toBe('allowed')
    expect(environment.DEEPSEEK_API_KEY).toBeUndefined()
    expect(environment.INTERNAL_SECRET).toBeUndefined()
  })
})
