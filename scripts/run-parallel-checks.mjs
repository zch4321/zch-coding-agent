import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import process from 'node:process'

const tasks = [
  { label: 'Lint', script: 'lint' },
  { label: 'Format', script: 'format:check' },
  { label: 'Typecheck', script: 'typecheck' },
  { label: 'Unit tests', script: 'test' },
]

/** Formats a task duration for the compact completion summary. */
function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`
}

/** Resolves the current npm CLI invocation without relying on a platform shell. */
function npmInvocation(script) {
  const npmCliPath = process.env.npm_execpath
  if (npmCliPath) {
    return {
      command: process.execPath,
      args: [npmCliPath, 'run', script],
      shell: false,
    }
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', script],
    shell: process.platform === 'win32',
  }
}

/** Runs one npm script while buffering its output for deterministic failure groups. */
function runTask(task) {
  const startedAt = Date.now()
  const invocation = npmInvocation(task.script)
  process.stdout.write(`Starting ${task.label}...\n`)

  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_COLOR: '1',
      },
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let settled = false

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))

    /** Completes the task result exactly once for spawn errors or process exit. */
    const settle = (exitCode, spawnError) => {
      if (settled) {
        return
      }
      settled = true
      const durationMs = Date.now() - startedAt
      const succeeded = exitCode === 0 && !spawnError
      process.stdout.write(
        `${succeeded ? 'Passed' : 'Failed'} ${task.label} (${formatDuration(durationMs)})\n`,
      )
      resolve({
        ...task,
        durationMs,
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8').trimEnd(),
        stderr: Buffer.concat(stderr).toString('utf8').trimEnd(),
        spawnError,
      })
    }

    child.once('error', (error) => settle(1, error))
    child.once('close', (exitCode) => settle(exitCode))
  })
}

/** Prints every failed task in declaration order and returns the aggregate exit code. */
function reportResults(results) {
  const failures = results.filter((result) => result.exitCode !== 0)
  if (failures.length === 0) {
    process.stdout.write('\nAll parallel checks passed.\n')
    return 0
  }

  for (const failure of failures) {
    process.stderr.write(`\n===== ${failure.label} failed =====\n`)
    if (failure.stdout) {
      process.stderr.write(`${failure.stdout}\n`)
    }
    if (failure.stderr) {
      process.stderr.write(`${failure.stderr}\n`)
    }
    if (failure.spawnError) {
      process.stderr.write(
        `${failure.spawnError.stack ?? failure.spawnError.message}\n`,
      )
    }
  }

  process.stderr.write(
    `\n${failures.length} of ${results.length} parallel checks failed.\n`,
  )
  return 1
}

/** Runs the fast developer gate without cancelling sibling diagnostics. */
async function main() {
  const results = await Promise.all(tasks.map(runTask))
  process.exitCode = reportResults(results)
}

await main()
