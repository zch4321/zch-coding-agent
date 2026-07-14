import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createCommandEnvironment } from '../process/run'

const MAX_PATCH_BYTES = 32 * 1_024 * 1_024
const GIT_TIMEOUT_MS = 60_000

export interface PatchArtifact {
  status: 'written' | 'not_git' | 'failed'
  path?: string
  error?: string
}

interface GitResult {
  exitCode: number | null
  stdout: Buffer
  stderr: string
}

export async function collectWorkspacePatch(input: {
  workspace: string
  artifactsDirectory: string
}): Promise<PatchArtifact> {
  const indexPath = path.join(
    input.artifactsDirectory,
    `.benchmark-index-${randomUUID()}`,
  )
  const environment = {
    ...createCommandEnvironment(),
    GIT_INDEX_FILE: indexPath,
    GIT_OPTIONAL_LOCKS: '0',
  }

  try {
    const probe = await runGit(
      ['rev-parse', '--is-inside-work-tree'],
      input.workspace,
      environment,
      1_024,
    )
    if (
      probe.exitCode !== 0 ||
      probe.stdout.toString('utf8').trim() !== 'true'
    ) {
      return { status: 'not_git' }
    }

    const readTree = await runGit(
      ['read-tree', 'HEAD'],
      input.workspace,
      environment,
      64 * 1_024,
    )
    if (readTree.exitCode !== 0) {
      return failed(readTree.stderr || 'Unable to read Git HEAD')
    }

    const add = await runGit(
      ['add', '-A', '--', '.'],
      input.workspace,
      environment,
      64 * 1_024,
    )
    if (add.exitCode !== 0) {
      return failed(
        add.stderr || 'Unable to stage workspace in temporary index',
      )
    }

    const diff = await runGit(
      ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD', '--', '.'],
      input.workspace,
      environment,
      MAX_PATCH_BYTES,
    )
    if (diff.exitCode !== 0) {
      return failed(diff.stderr || 'Unable to collect Git patch')
    }

    const patchPath = path.join(input.artifactsDirectory, 'workspace.patch')
    await writeFileAtomic(patchPath, diff.stdout)
    return { status: 'written', path: patchPath }
  } catch (error) {
    return failed(
      error instanceof Error ? error.message : 'Patch collection failed',
    )
  } finally {
    await unlink(indexPath).catch(() => undefined)
  }
}

function failed(message: string): PatchArtifact {
  return { status: 'failed', error: message.slice(0, 4_096) }
}

async function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  maxBytes: number,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const finishError = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      reject(error)
    }
    const timeout = setTimeout(
      () => finishError(new Error('Git patch collection timed out')),
      GIT_TIMEOUT_MS,
    )
    timeout.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxBytes) {
        finishError(new Error(`Git output exceeds ${maxBytes} bytes`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes <= 64 * 1_024) stderr.push(chunk)
    })
    child.once('error', finishError)
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      })
    })
  })
}

async function writeFileAtomic(filePath: string, data: Buffer): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  )
  const file = await open(temporaryPath, 'wx', 0o600)
  try {
    await file.writeFile(data)
    await file.sync()
    await file.close()
    await rename(temporaryPath, filePath)
  } catch (error) {
    await file.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}
