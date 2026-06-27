import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { MAX_MUTATION_FILE_BYTES } from './file-tool-limits'
import type { FileOperation, FilePrecondition } from './file-tool-types'
import { PathGuard, PathGuardError } from '../safety/path-guard'

function portableRelative(workspace: string, absolutePath: string): string {
  return path.relative(workspace, absolutePath).split(path.sep).join('/') || '.'
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function resourceId(value: Awaited<ReturnType<typeof stat>>): string {
  return `${value.dev}:${value.ino}:${value.birthtimeMs}:${value.mtimeMs}:${value.size}`
}

function directoryId(value: Awaited<ReturnType<typeof stat>>): string {
  return `${value.dev}:${value.ino}:${value.birthtimeMs}`
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT',
  )
}

function isNotDirectoryPath(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOTDIR',
  )
}

async function nearestExistingParent(target: string): Promise<string> {
  let current = target

  while (true) {
    try {
      await stat(current)
      return current
    } catch (error) {
      if (isNotDirectoryPath(error)) {
        throw new PathGuardError(
          'NOT_A_DIRECTORY',
          'Target parent is not a directory',
        )
      }

      if (!isMissing(error)) {
        throw error
      }
    }

    const parent = path.dirname(current)

    if (parent === current) {
      throw new PathGuardError('PATH_NOT_FOUND', 'No existing parent found')
    }

    current = parent
  }
}

async function captureParentPrecondition(
  guard: PathGuard,
  parentPath: string,
  allowMissing: boolean,
): Promise<{
  parentRealPath: string
  expectedParentId: string
  expectedParentExists: boolean
  expectedExistingParentRealPath: string
  expectedExistingParentId: string
}> {
  try {
    const parentRealPath = path.resolve(await realpath(parentPath))
    const parentStat = await stat(parentRealPath)

    guard.assertInside(parentRealPath)

    if (!parentStat.isDirectory()) {
      throw new PathGuardError(
        'NOT_A_DIRECTORY',
        'Target parent is not a directory',
      )
    }

    const parentId = directoryId(parentStat)
    return {
      parentRealPath,
      expectedParentId: parentId,
      expectedParentExists: true,
      expectedExistingParentRealPath: parentRealPath,
      expectedExistingParentId: parentId,
    }
  } catch (error) {
    if (!allowMissing || (!isMissing(error) && !isNotDirectoryPath(error))) {
      throw error
    }
  }

  const existingParentPath = await nearestExistingParent(parentPath)
  const existingParentRealPath = path.resolve(
    await realpath(existingParentPath),
  )
  const existingParentStat = await stat(existingParentRealPath)

  guard.assertInside(existingParentRealPath)

  if (!existingParentStat.isDirectory()) {
    throw new PathGuardError(
      'NOT_A_DIRECTORY',
      'Target parent is not a directory',
    )
  }

  const missingParentRelative = path.relative(existingParentPath, parentPath)
  const parentRealPath = path.resolve(
    existingParentRealPath,
    missingParentRelative,
  )
  guard.assertInside(parentRealPath)
  const existingParentId = directoryId(existingParentStat)

  return {
    parentRealPath,
    expectedParentId: existingParentId,
    expectedParentExists: false,
    expectedExistingParentRealPath: existingParentRealPath,
    expectedExistingParentId: existingParentId,
  }
}

export async function captureFilePrecondition(
  guard: PathGuard,
  inputPath: string,
  operation: FileOperation,
  maxMutationFileBytes = MAX_MUTATION_FILE_BYTES,
): Promise<FilePrecondition> {
  const absolutePath = guard.resolveCandidate(inputPath)
  const parentPath = path.dirname(absolutePath)
  const parent = await captureParentPrecondition(
    guard,
    parentPath,
    operation === 'write',
  )
  const canonicalAbsolutePath = path.resolve(
    parent.parentRealPath,
    path.basename(absolutePath),
  )

  let targetStat: Awaited<ReturnType<typeof lstat>>

  try {
    targetStat = await lstat(canonicalAbsolutePath)
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }

    return Object.freeze({
      kind: 'file',
      operation,
      path: portableRelative(guard.workspacePath, canonicalAbsolutePath),
      absolutePath: canonicalAbsolutePath,
      parentRealPath: parent.parentRealPath,
      expectedParentId: parent.expectedParentId,
      expectedParentExists: parent.expectedParentExists,
      expectedExistingParentRealPath: parent.expectedExistingParentRealPath,
      expectedExistingParentId: parent.expectedExistingParentId,
      expectedExists: false,
    })
  }

  if (targetStat.isSymbolicLink()) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'File mutations do not follow symbolic links or junctions',
    )
  }

  if (!targetStat.isFile()) {
    throw new PathGuardError('NOT_A_FILE', 'Target is not a regular file')
  }

  if (targetStat.size > maxMutationFileBytes) {
    throw new PathGuardError(
      'FILE_TOO_LARGE',
      `File mutations support files up to ${maxMutationFileBytes} bytes`,
    )
  }

  const targetRealPath = path.resolve(await realpath(canonicalAbsolutePath))
  guard.assertInside(targetRealPath)
  const content = await readFile(targetRealPath)

  return Object.freeze({
    kind: 'file',
    operation,
    path: portableRelative(guard.workspacePath, targetRealPath),
    absolutePath: canonicalAbsolutePath,
    parentRealPath: parent.parentRealPath,
    expectedParentId: parent.expectedParentId,
    expectedParentExists: parent.expectedParentExists,
    expectedExistingParentRealPath: parent.expectedExistingParentRealPath,
    expectedExistingParentId: parent.expectedExistingParentId,
    expectedExists: true,
    expectedRealPath: targetRealPath,
    expectedFileId: resourceId(targetStat),
    expectedContentHash: hash(content),
    expectedContent: content.toString('utf8'),
  })
}

async function assertExistingParentPrecondition(
  guard: PathGuard,
  expected: FilePrecondition,
): Promise<void> {
  if (
    expected.expectedExistingParentRealPath === undefined ||
    expected.expectedExistingParentId === undefined
  ) {
    return
  }

  const currentRealPath = path.resolve(
    await realpath(expected.expectedExistingParentRealPath),
  )
  const currentStat = await stat(currentRealPath)

  guard.assertInside(currentRealPath)

  if (
    normalizeForCompare(currentRealPath) !==
      normalizeForCompare(expected.expectedExistingParentRealPath) ||
    !currentStat.isDirectory() ||
    directoryId(currentStat) !== expected.expectedExistingParentId
  ) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'The target parent changed after approval; review the updated diff',
    )
  }
}

export async function assertFilePrecondition(
  workspace: string,
  expected: FilePrecondition,
): Promise<void> {
  const guard = PathGuard.fromCanonical(workspace)
  await assertExistingParentPrecondition(guard, expected)
  const current = await captureFilePrecondition(
    guard,
    expected.absolutePath,
    expected.operation,
  )
  const parentChanged =
    expected.expectedParentExists === false
      ? false
      : normalizeForCompare(current.parentRealPath) !==
          normalizeForCompare(expected.parentRealPath) ||
        current.expectedParentId !== expected.expectedParentId
  const changed =
    current.path !== expected.path ||
    normalizeForCompare(current.absolutePath) !==
      normalizeForCompare(expected.absolutePath) ||
    parentChanged ||
    current.expectedExists !== expected.expectedExists ||
    normalizeForCompare(current.expectedRealPath ?? '') !==
      normalizeForCompare(expected.expectedRealPath ?? '') ||
    current.expectedRealPath !== expected.expectedRealPath ||
    current.expectedFileId !== expected.expectedFileId ||
    current.expectedContentHash !== expected.expectedContentHash

  if (changed) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'The target changed after approval; review the updated diff',
    )
  }
}

export async function revalidateResourcePreconditions(
  workspace: string,
  preconditions: readonly FilePrecondition[],
): Promise<void> {
  for (const precondition of preconditions) {
    await assertFilePrecondition(workspace, precondition)
  }
}
