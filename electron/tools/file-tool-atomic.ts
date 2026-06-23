import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { FilePrecondition } from './file-tool-types'
import { assertFilePrecondition } from './file-tool-preconditions'

export async function atomicReplace(
  workspace: string,
  precondition: FilePrecondition,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  const temporaryPath = path.join(
    precondition.parentRealPath,
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
