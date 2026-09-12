import type { CommandSessionSnapshot } from '../process/command-sessions'

/** Cuts a decoded UTF-8 string without leaving a partial code point. */
function prefix(text: string, maximum: number): string {
  const buffer = Buffer.from(text)
  let end = Math.min(buffer.length, Math.max(0, maximum))
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString('utf8')
}

/** Budgets model text around an indispensable session/state header before admitting output. */
export function formatExecCommandResult(
  value: CommandSessionSnapshot,
  limits: { maxToolOutputBytes: number; maxToolOutputLines: number },
): { text: string; truncated: boolean } {
  const fields: Record<string, unknown> = {
    sessionId: value.sessionId,
    state: value.state,
    exitCode: value.exitCode,
    exitSignal: value.exitSignal,
    stdinClosed: value.stdinClosed,
    truncated: false,
    totalBytes: value.totalBytes,
    artifactAvailable: value.artifactAvailable,
    ...(value.artifactPath
      ? { artifactPath: value.artifactPath, artifactType: 'directory' }
      : {}),
    ...(value.captureError
      ? { captureError: prefix(value.captureError, 256) }
      : {}),
    ...(value.inputError ? { inputError: prefix(value.inputError, 256) } : {}),
    ...(value.stopError ? { stopError: prefix(value.stopError, 256) } : {}),
  }
  let omittedMetadata = false
  for (const field of [
    'captureError',
    'inputError',
    'stopError',
    'artifactPath',
  ]) {
    if (Buffer.byteLength(JSON.stringify(fields)) <= limits.maxToolOutputBytes)
      break
    if (field in fields) {
      delete fields[field]
      if (field === 'artifactPath') delete fields.artifactType
      omittedMetadata = true
    }
  }
  const headerBudget = Buffer.byteLength(JSON.stringify(fields))
  const source = [value.stdout, value.stderr ? `[stderr]\n${value.stderr}` : '']
    .filter(Boolean)
    .join('\n')
  const lineBound = Math.max(0, limits.maxToolOutputLines - 1)
  const lines = source.split('\n')
  const selected = lineBound ? lines.slice(0, lineBound).join('\n') : ''
  const body = prefix(selected, limits.maxToolOutputBytes - headerBudget - 1)
  const truncated = value.truncated || omittedMetadata || body !== source
  fields.truncated = truncated
  return {
    text: `${JSON.stringify(fields)}${body ? `\n${body}` : ''}`,
    truncated,
  }
}
