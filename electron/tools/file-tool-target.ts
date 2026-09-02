import path from 'node:path'
import { inspectPath } from '../common/filesystem'
import {
  PathGuard,
  PathGuardError,
  type PathGuardRootKind,
} from '../safety/path-guard'
import { resolveSessionTempToolPath } from '../session-temp/path-alias'
import type { SessionTempPaths } from '../session-temp/service'
import type { FileOperation } from './file-tool-types'

export interface FileMutationTarget {
  operation: FileOperation
  rootKind: PathGuardRootKind
  rootPath: string
  path: string
  absolutePath: string
  parentRealPath: string
  exists: boolean
  realPath?: string
  size: number
  mode?: number
}

/** Resolves a file mutation target against current filesystem state. */
export async function resolveFileMutationTarget(input: {
  workspace: string
  sessionTemp?: SessionTempPaths
  path: string
  operation: FileOperation
}): Promise<FileMutationTarget> {
  const guard = PathGuard.fromCanonical(
    input.workspace,
    input.sessionTemp?.root,
  )
  const requestedPath = resolveSessionTempToolPath(
    input.path,
    input.sessionTemp,
  )
  const candidate = guard.resolveCandidate(requestedPath)
  const root = guard.rootForCandidate(requestedPath)
  const parentRealPath = await resolveParent(
    guard,
    root.kind,
    path.dirname(candidate),
  )
  const absolutePath = path.resolve(parentRealPath, path.basename(candidate))
  guard.assertInsideRoot(absolutePath, root.kind)

  let inspected
  try {
    inspected = await inspectPath(absolutePath)
  } catch (error) {
    if (hasCode(error, 'ELOOP')) {
      throw new PathGuardError(
        'RESOURCE_CHANGED',
        'File mutations do not follow symbolic links or junctions',
      )
    }
    throw error
  }
  if (inspected && inspected.type !== 'file') {
    throw new PathGuardError('NOT_A_FILE', 'Target is not a regular file')
  }
  if (inspected) guard.assertInsideRoot(inspected.realPath, root.kind)

  const displayPath =
    root.kind === 'workspace'
      ? path
          .relative(root.path, inspected?.realPath ?? absolutePath)
          .split(path.sep)
          .join('/') || '.'
      : path.resolve(inspected?.realPath ?? absolutePath)
  return {
    operation: input.operation,
    rootKind: root.kind,
    rootPath: root.path,
    path: displayPath,
    absolutePath,
    parentRealPath,
    exists: Boolean(inspected),
    ...(inspected
      ? { realPath: inspected.realPath, mode: inspected.mode }
      : {}),
    size: inspected?.size ?? 0,
  }
}

async function resolveParent(
  guard: PathGuard,
  rootKind: PathGuardRootKind,
  requestedParent: string,
): Promise<string> {
  let current = requestedParent
  while (true) {
    const inspected = await inspectPath(current)
    if (inspected) {
      if (inspected.type !== 'directory') {
        throw new PathGuardError(
          'NOT_A_DIRECTORY',
          'Target parent is not a directory',
        )
      }
      guard.assertInsideRoot(inspected.realPath, rootKind)
      const suffix = path.relative(current, requestedParent)
      const parentRealPath = path.resolve(inspected.realPath, suffix)
      guard.assertInsideRoot(parentRealPath, rootKind)
      return parentRealPath
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new PathGuardError('PATH_NOT_FOUND', 'No existing parent found')
    }
    current = parent
  }
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code,
  )
}

/** Returns whether a mutation target is inside the approval-free Session scratch root. */
export async function isSessionScratchTarget(
  target: FileMutationTarget,
  workspace: string,
  sessionTemp?: SessionTempPaths,
): Promise<boolean> {
  if (target.rootKind !== 'session-temp' || !sessionTemp) return false
  const guard = PathGuard.fromCanonical(workspace, sessionTemp.root)
  const scratch = await guard.resolveExisting(sessionTemp.scratch)
  const relative = path.relative(scratch.realPath, target.absolutePath)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}
