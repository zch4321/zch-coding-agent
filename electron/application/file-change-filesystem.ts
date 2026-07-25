import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import { EMPTY_FILE_SHA256 } from '../../shared/file-change'
import { PathGuard } from '../safety/path-guard'
import { MAX_MUTATION_FILE_BYTES } from '../tools/file-tool-limits'

export interface FileContentState {
  exists: boolean
  hash: string
  content: string | null
  mode: number | null
  absolutePath: string
}

export class FileChangeResourceError extends Error {
  constructor(
    readonly code: 'RESOURCE_CHANGED',
    message: string,
  ) {
    super(message)
    this.name = 'FileChangeResourceError'
  }
}

export async function readFileContentState(
  workspace: string,
  relativePath: string,
): Promise<FileContentState> {
  const guard = PathGuard.fromCanonical(workspace)
  const absolutePath = guard.resolveCandidate(relativePath)
  try {
    const value = await lstat(absolutePath)
    if (value.isSymbolicLink() || !value.isFile()) {
      throw new FileChangeResourceError(
        'RESOURCE_CHANGED',
        'The change target is no longer a regular file',
      )
    }
    if (value.size > MAX_MUTATION_FILE_BYTES) {
      throw new FileChangeResourceError(
        'RESOURCE_CHANGED',
        `The change target exceeds the ${MAX_MUTATION_FILE_BYTES} byte mutation limit`,
      )
    }
    const canonical = path.resolve(await realpath(absolutePath))
    guard.assertInside(canonical)
    const content = await readFile(canonical, 'utf8')
    return {
      exists: true,
      hash: sha256(content),
      content,
      mode: value.mode & 0o777,
      absolutePath,
    }
  } catch (error) {
    if (isMissing(error)) {
      return {
        exists: false,
        hash: EMPTY_FILE_SHA256,
        content: null,
        mode: null,
        absolutePath,
      }
    }
    throw error
  }
}

export function assertFileContentState(
  state: Pick<FileContentState, 'exists' | 'hash'>,
  expectedExists: boolean,
  expectedHash: string,
): void {
  if (state.exists !== expectedExists || state.hash !== expectedHash) {
    throw new FileChangeResourceError(
      'RESOURCE_CHANGED',
      'The file changed after this agent change; refusing to overwrite newer work',
    )
  }
}

export async function restoreFileContent(input: {
  workspace: string
  path: string
  beforeExists: boolean
  beforeContent: string | null
  beforeMode: number | null
  afterExists: boolean
  afterHash: string
}): Promise<void> {
  let state = await readFileContentState(input.workspace, input.path)
  assertFileContentState(state, input.afterExists, input.afterHash)
  const guard = PathGuard.fromCanonical(input.workspace)
  const parent = path.dirname(state.absolutePath)
  const parentRealPath = path.resolve(await realpath(parent))
  guard.assertInside(parentRealPath)

  if (input.beforeExists) {
    if (input.beforeContent === null || input.beforeMode === null) {
      throw new FileChangeResourceError(
        'RESOURCE_CHANGED',
        'The stored recovery snapshot or file mode is missing',
      )
    }
    const temporaryPath = path.join(
      parentRealPath,
      `.${path.basename(state.absolutePath)}.${randomUUID()}.revert`,
    )
    const file = await open(temporaryPath, 'wx', 0o600)
    try {
      await file.writeFile(input.beforeContent, 'utf8')
      await file.chmod(input.beforeMode)
      await file.sync()
      await file.close()
      state = await readFileContentState(input.workspace, input.path)
      assertFileContentState(state, input.afterExists, input.afterHash)
      await rename(temporaryPath, state.absolutePath)
    } catch (error) {
      await file.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
    return
  }

  state = await readFileContentState(input.workspace, input.path)
  assertFileContentState(state, true, input.afterHash)
  const temporaryPath = path.join(
    parentRealPath,
    `.${path.basename(state.absolutePath)}.${randomUUID()}.revert-delete`,
  )
  await rename(state.absolutePath, temporaryPath)
  try {
    await unlink(temporaryPath)
  } catch (error) {
    await rename(temporaryPath, state.absolutePath).catch(() => undefined)
    throw error
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT',
  )
}
