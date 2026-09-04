import {
  fileStatus as stat,
  readDirectory as readdir,
  unlinkFile as unlink,
} from '../common/filesystem'
import path from 'node:path'

export interface RuntimeLogCleanupOptions {
  directory: string
  activeFile: string
  retentionDays: number
  maxTotalBytes: number
  now?: Date
}

export interface RuntimeLogCleanupResult {
  deletedFiles: number
  deletedBytes: number
  remainingBytes: number
}

interface RuntimeLogFile {
  path: string
  size: number
  modifiedAtMs: number
}

/** Removes expired or over-budget closed operational log files. */
export async function cleanupRuntimeLogs(
  options: RuntimeLogCleanupOptions,
): Promise<RuntimeLogCleanupResult> {
  const files = await listClosedRuntimeLogs(
    options.directory,
    options.activeFile,
  )
  const cutoff =
    (options.now ?? new Date()).getTime() - options.retentionDays * 86_400_000
  let remainingBytes = files.reduce((sum, file) => sum + file.size, 0)
  let deletedFiles = 0
  let deletedBytes = 0

  for (const file of files) {
    if (file.modifiedAtMs >= cutoff) continue
    if (await unlinkIfPresent(file.path)) {
      deletedFiles += 1
      deletedBytes += file.size
    }
    remainingBytes -= file.size
  }

  for (const file of files) {
    if (file.modifiedAtMs < cutoff || remainingBytes <= options.maxTotalBytes) {
      continue
    }
    if (await unlinkIfPresent(file.path)) {
      deletedFiles += 1
      deletedBytes += file.size
    }
    remainingBytes -= file.size
  }

  return { deletedFiles, deletedBytes, remainingBytes }
}

/** Deletes every closed operational log while preserving the active file. */
export async function clearClosedRuntimeLogs(
  directory: string,
  activeFile: string,
): Promise<RuntimeLogCleanupResult> {
  const files = await listClosedRuntimeLogs(directory, activeFile)
  let deletedBytes = 0
  let deletedFiles = 0
  for (const file of files) {
    if (await unlinkIfPresent(file.path)) {
      deletedFiles += 1
      deletedBytes += file.size
    }
  }
  return {
    deletedFiles,
    deletedBytes,
    remainingBytes: 0,
  }
}

async function listClosedRuntimeLogs(
  directory: string,
  activeFile: string,
): Promise<RuntimeLogFile[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (readNodeErrorCode(error) === 'ENOENT') return []
    throw error
  }
  const resolvedActive = path.resolve(activeFile)
  const files: RuntimeLogFile[] = []
  for (const name of names) {
    if (!name.startsWith('runtime.') || !name.endsWith('.jsonl')) continue
    const candidate = path.resolve(directory, name)
    if (candidate === resolvedActive) continue
    const metadata = await stat(candidate).catch((error: unknown) => {
      if (readNodeErrorCode(error) === 'ENOENT') return undefined
      throw error
    })
    if (!metadata) continue
    if (!metadata.isFile()) continue
    files.push({
      path: candidate,
      size: metadata.size,
      modifiedAtMs: metadata.mtimeMs,
    })
  }
  return files.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs)
}

async function unlinkIfPresent(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath)
    return true
  } catch (error) {
    if (readNodeErrorCode(error) === 'ENOENT') return false
    throw error
  }
}

function readNodeErrorCode(error: unknown): string | undefined {
  const code =
    error && typeof error === 'object' ? Reflect.get(error, 'code') : ''
  return typeof code === 'string' ? code : undefined
}
