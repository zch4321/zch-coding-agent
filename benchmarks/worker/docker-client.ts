import { spawn } from 'node:child_process'

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024

export interface DockerCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** Starts attached docker container. */
export async function startAttachedDockerContainer(input: {
  container: string
  timeoutMs: number
  maxOutputBytes: number
  onStdoutLine: (line: string) => Promise<string | undefined>
}): Promise<DockerCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['start', '--attach', '--interactive', input.container],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    child.stdin.on('error', () => undefined)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutRemainder = ''
    let outputBytes = 0
    let settled = false
    let callbackError: Error | undefined
    let callbackChain = Promise.resolve()
    const finish = async (error?: Error, exitCode?: number): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      await callbackChain.catch(() => undefined)
      const finalError = error ?? callbackError
      if (finalError) reject(finalError)
      else {
        resolve({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      }
    }
    const enforceLimit = (chunk: Buffer): boolean => {
      outputBytes += chunk.byteLength
      if (outputBytes <= input.maxOutputBytes) return true
      child.kill('SIGKILL')
      void finish(
        new DockerCommandError(
          'DOCKER_OUTPUT_LIMIT',
          'Attached Docker output exceeded its byte limit',
        ),
      )
      return false
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (!enforceLimit(chunk)) return
      stdout.push(chunk)
      stdoutRemainder += chunk.toString('utf8')
      const lines = stdoutRemainder.split(/\r?\n/u)
      stdoutRemainder = lines.pop() ?? ''
      for (const line of lines) {
        callbackChain = callbackChain.then(async () => {
          if (callbackError || !line) return
          try {
            const response = await input.onStdoutLine(line)
            if (response !== undefined) child.stdin.write(`${response}\n`)
          } catch (error) {
            callbackError =
              error instanceof Error
                ? error
                : new Error('Docker control failed')
            child.stdin.write('{"schemaVersion":1,"action":"finish"}\n')
          }
        })
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (enforceLimit(chunk)) stderr.push(chunk)
    })
    child.once('error', (error) => {
      void finish(
        new DockerCommandError(
          'DOCKER_UNAVAILABLE',
          `Unable to attach to Docker: ${error.message}`,
        ),
      )
    })
    child.once('close', (exitCode) => void finish(undefined, exitCode ?? -1))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      void finish(
        new DockerCommandError(
          'DOCKER_COMMAND_TIMEOUT',
          `Attached Docker run exceeded ${input.timeoutMs} ms`,
        ),
      )
    }, input.timeoutMs)
  })
}

/** Reports docker command failures. */
export class DockerCommandError extends Error {
  readonly code: string
  readonly result?: DockerCommandResult

  constructor(code: string, message: string, result?: DockerCommandResult) {
    super(message)
    this.name = 'DockerCommandError'
    this.code = code
    this.result = result
  }
}

/** Runs docker command. */
export async function runDockerCommand(
  args: string[],
  options: {
    timeoutMs?: number
    maxOutputBytes?: number
    signal?: AbortSignal
    allowFailure?: boolean
  } = {},
): Promise<DockerCommandResult> {
  if (options.signal?.aborted) {
    throw new DockerCommandError('DOCKER_CANCELLED', 'Docker command cancelled')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false

    const finish = (error?: Error, result?: DockerCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result!)
    }
    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL')
        finish(
          new DockerCommandError(
            'DOCKER_OUTPUT_LIMIT',
            'Docker command output exceeded its byte limit',
          ),
        )
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    child.once('error', (error) => {
      finish(
        new DockerCommandError(
          'DOCKER_UNAVAILABLE',
          `Unable to start Docker: ${error.message}`,
        ),
      )
    })
    child.once('close', (exitCode) => {
      const result = {
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (result.exitCode !== 0 && !options.allowFailure) {
        finish(
          new DockerCommandError(
            'DOCKER_COMMAND_FAILED',
            sanitizeDockerError(result.stderr, args),
            result,
          ),
        )
        return
      }
      finish(undefined, result)
    })
    const abort = (): void => {
      child.kill('SIGKILL')
      finish(
        new DockerCommandError('DOCKER_CANCELLED', 'Docker command cancelled'),
      )
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(
        new DockerCommandError(
          'DOCKER_COMMAND_TIMEOUT',
          `Docker command exceeded ${timeoutMs} ms`,
        ),
      )
    }, timeoutMs)
  })
}

function sanitizeDockerError(stderr: string, args: string[]): string {
  const action = args[0] ?? 'command'
  const detail = stderr.trim().slice(0, 2_048)
  return detail
    ? `Docker ${action} failed: ${detail}`
    : `Docker ${action} failed`
}
