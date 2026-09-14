import { execFile } from 'node:child_process'
import path from 'node:path'
import { ATTACHMENT_LIMITS } from '../../shared/attachments'
import { DomainError } from '../common/domain-error'
import { createCommandEnvironment } from '../process/run'

// Constant script only: clipboard filenames never become executable command text.
const FILE_DROP_SCRIPT = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$files = @(Get-Clipboard -Format FileDropList)
if ($files.Count -gt ${ATTACHMENT_LIMITS.count}) { throw 'Too many clipboard files' }
ConvertTo-Json -Compress -InputObject @($files | ForEach-Object { $_.FullName })`

/** Reads Explorer's file-drop clipboard only in direct response to a user paste. */
export async function readWindowsClipboardFiles(
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32') return []
  const executable = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        FILE_DROP_SCRIPT,
      ],
      {
        windowsHide: true,
        signal,
        env: createCommandEnvironment(),
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 128 * 1024,
      },
      (error, stdout) => {
        if (error)
          reject(
            new DomainError(
              'PRECONDITION_FAILED',
              'Clipboard files could not be read',
              { cause: error },
            ),
          )
        else resolve(stdout)
      },
    )
  })
  signal?.throwIfAborted()
  const files: unknown = JSON.parse(
    output.replace(/^\uFEFF/u, '').trim() || '[]',
  )
  if (
    !Array.isArray(files) ||
    files.length > ATTACHMENT_LIMITS.count ||
    !files.every(
      (file) =>
        typeof file === 'string' &&
        file.length <= 4096 &&
        path.isAbsolute(file),
    )
  )
    throw new DomainError('PRECONDITION_FAILED', 'Invalid clipboard file list')
  return [...new Set(files as string[])]
}
