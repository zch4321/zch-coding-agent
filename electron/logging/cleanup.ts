import {
  fileStatus as stat,
  readDirectory as readdir,
  unlinkFile as unlink,
} from '../common/filesystem'
import path from 'node:path'
import { TRACE_SCHEMA_VERSION } from './events'
import { readTraceFile, UnsupportedTraceSchemaError } from './reader'

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

const cleanupTails = new Map<string, Promise<void>>()

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT',
  )
}

async function cleanupTracesUnlocked(
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
    if (isMissingFileError(error)) {
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
    let fileStat
    try {
      fileStat = await stat(filePath)
    } catch (error) {
      if (isMissingFileError(error)) {
        continue
      }

      onDiagnostic(`Failed to stat trace ${entry}`, error)
      continue
    }

    try {
      const events = await readTraceFile(filePath)
      files.push({
        path: filePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        closed: events.at(-1)?.type === 'session.end',
      })
    } catch (error) {
      if (isMissingFileError(error)) {
        continue
      }

      onDiagnostic(`Failed to inspect trace ${entry}`, error)
      files.push({
        path: filePath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        closed:
          error instanceof UnsupportedTraceSchemaError &&
          typeof error.schemaVersion === 'number' &&
          error.schemaVersion < TRACE_SCHEMA_VERSION,
      })
    }
  }

  files.sort((left, right) => left.mtimeMs - right.mtimeMs)
  const deleted: string[] = []
  const removed = new Set<string>()
  let retainedBytes = files.reduce((sum, file) => sum + file.size, 0)

  const markRemoved = (file: TraceFileInfo) => {
    if (removed.has(file.path)) {
      return
    }

    removed.add(file.path)
    retainedBytes -= file.size
  }

  const remove = async (file: TraceFileInfo) => {
    try {
      await unlink(file.path)
      deleted.push(file.path)
      markRemoved(file)
    } catch (error) {
      if (isMissingFileError(error)) {
        markRemoved(file)
        return
      }

      onDiagnostic(`Failed to delete trace ${path.basename(file.path)}`, error)
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
      !removed.has(file.path) &&
      !activeFiles.has(path.resolve(file.path))
    ) {
      await remove(file)
    }
  }

  return { deleted, retainedBytes }
}

/** Applies age and size retention while serializing cleanup of each trace directory. */
export function cleanupTraces(
  directory: string,
  options: TraceCleanupOptions,
): Promise<{ deleted: string[]; retainedBytes: number }> {
  const key = path.resolve(directory)
  const previous = cleanupTails.get(key) ?? Promise.resolve()
  const run = previous
    .catch(() => undefined)
    .then(() => cleanupTracesUnlocked(directory, options))
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  cleanupTails.set(key, tail)

  return run.finally(() => {
    if (cleanupTails.get(key) === tail) cleanupTails.delete(key)
  })
}
