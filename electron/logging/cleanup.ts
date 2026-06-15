import { readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { readTraceFile } from './reader'

export interface TraceCleanupOptions {
  retentionDays: number
  maxTotalBytes: number
  activeFiles?: ReadonlySet<string>
  now?: Date
  onDiagnostic?: (message: string, error?: unknown) => void
}

interface TraceFileInfo {
  path: string
  size: number
  mtimeMs: number
  closed: boolean
}

export async function cleanupTraces(
  directory: string,
  options: TraceCleanupOptions,
): Promise<{ deleted: string[]; retainedBytes: number }> {
  const activeFiles = options.activeFiles ?? new Set<string>()
  const onDiagnostic = options.onDiagnostic ?? (() => undefined)
  const now = options.now ?? new Date()
  const cutoff = now.getTime() - options.retentionDays * 86_400_000
  let entries: string[]

  try {
    entries = await readdir(directory)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { deleted: [], retainedBytes: 0 }
    }

    onDiagnostic('Failed to list trace directory', error)
    return { deleted: [], retainedBytes: 0 }
  }

  const files: TraceFileInfo[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) {
      continue
    }

    const filePath = path.join(directory, entry)

    try {
      const fileStat = await stat(filePath)
      const events = await readTraceFile(filePath)
      files.push({
        path: filePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        closed: events.at(-1)?.type === 'session.end',
      })
    } catch (error) {
      onDiagnostic(`Failed to inspect trace ${entry}`, error)
    }
  }

  files.sort((left, right) => left.mtimeMs - right.mtimeMs)
  const deleted: string[] = []
  let retainedBytes = files.reduce((sum, file) => sum + file.size, 0)

  const remove = async (file: TraceFileInfo) => {
    try {
      await unlink(file.path)
      deleted.push(file.path)
      retainedBytes -= file.size
      return true
    } catch (error) {
      onDiagnostic(`Failed to delete trace ${path.basename(file.path)}`, error)
      return false
    }
  }

  for (const file of files) {
    if (
      file.closed &&
      file.mtimeMs < cutoff &&
      !activeFiles.has(path.resolve(file.path))
    ) {
      await remove(file)
    }
  }

  for (const file of files) {
    if (retainedBytes <= options.maxTotalBytes) {
      break
    }

    if (
      file.closed &&
      !deleted.includes(file.path) &&
      !activeFiles.has(path.resolve(file.path))
    ) {
      await remove(file)
    }
  }

  return { deleted, retainedBytes }
}
