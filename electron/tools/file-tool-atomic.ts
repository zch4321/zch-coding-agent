import { randomUUID } from 'node:crypto'
import { mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { FilePrecondition } from './file-tool-types'
import { assertFilePrecondition } from './file-tool-preconditions'
import { PathGuard, PathGuardError } from '../safety/path-guard'

async function ensureParentDirectory(
  workspace: string,
  precondition: FilePrecondition,
  signal: AbortSignal,
): Promise<string> {
  if (precondition.expectedParentExists !== false) {
    return precondition.parentRealPath
  }

  signal.throwIfAborted()
  await mkdir(precondition.parentRealPath, { recursive: true })
  const parentRealPath = path.resolve(
    await realpath(precondition.parentRealPath),
  )
  const parentStat = await stat(parentRealPath)
  PathGuard.fromCanonical(workspace).assertInside(parentRealPath)

  if (!parentStat.isDirectory()) {
    throw new PathGuardError(
      'NOT_A_DIRECTORY',
      'Target parent is not a directory',
    )
  }

  signal.throwIfAborted()
  return parentRealPath
}

export async function atomicReplace(
  workspace: string,
  precondition: FilePrecondition,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  const parentRealPath = await ensureParentDirectory(
    workspace,
    precondition,
    signal,
  )
  const temporaryPath = path.join(
    parentRealPath,
    `.${path.basename(precondition.absolutePath)}.${randomUUID()}.tmp`,
  )
  const file = await open(temporaryPath, 'wx', 0o600)

  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
  } catch (error) {
    await file.close().catch(() => undefined)
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }

  await file.close()

  try {
    signal.throwIfAborted()
    await assertFilePrecondition(workspace, precondition)
    signal.throwIfAborted()
    await rename(temporaryPath, precondition.absolutePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

export async function atomicDelete(
  workspace: string,
  precondition: FilePrecondition,
  signal: AbortSignal,
): Promise<void> {
  const temporaryPath = path.join(
    precondition.parentRealPath,
    `.${path.basename(precondition.absolutePath)}.${randomUUID()}.delete`,
  )

  signal.throwIfAborted()
  await assertFilePrecondition(workspace, precondition)
  signal.throwIfAborted()
  await rename(precondition.absolutePath, temporaryPath)

  try {
    await unlink(temporaryPath)
  } catch (error) {
    await rename(temporaryPath, precondition.absolutePath).catch(
      () => undefined,
    )
    throw error
  }
}
