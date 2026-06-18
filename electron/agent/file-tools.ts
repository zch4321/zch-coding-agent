import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import { Type } from '@sinclair/typebox'
import type { PolicySignal } from '../../shared/agent-events'
import type { JsonValue } from '../../shared/json'
import type { ToolCall, ToolDefinition, ToolResult } from '../tools/types'
import { PathGuard, PathGuardError } from './path-guard'
import type { ApprovedToolCall } from './permission-pipeline'
import type { ToolRegistry } from './tool-registry'

const MAX_FILE_BYTES = 10_000_000
const MAX_DIFF_CHARS = 120_000

const WriteFileArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    content: Type.String({ maxLength: MAX_FILE_BYTES }),
  },
  { additionalProperties: false },
)

const EditFileArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    old: Type.String({ minLength: 1, maxLength: MAX_FILE_BYTES }),
    new: Type.String({ maxLength: MAX_FILE_BYTES }),
  },
  { additionalProperties: false },
)

const DeleteFileArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
  },
  { additionalProperties: false },
)

export type FileOperation = 'write' | 'edit' | 'delete'

export interface FilePrecondition {
  readonly kind: 'file'
  readonly operation: FileOperation
  readonly path: string
  readonly absolutePath: string
  readonly parentRealPath: string
  readonly expectedParentId: string
  readonly expectedExists: boolean
  readonly expectedRealPath?: string
  readonly expectedFileId?: string
  readonly expectedContentHash?: string
}

export interface ToolResourcePlan {
  readonly preconditions: readonly FilePrecondition[]
  readonly policySignals: readonly PolicySignal[]
  readonly diff?: string
  readonly diffHash?: string
}

function portableRelative(workspace: string, absolutePath: string): string {
  return path.relative(workspace, absolutePath).split(path.sep).join('/') || '.'
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function hash(value: string | Buffer): string {
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

function operationFor(toolId: string): FileOperation | undefined {
  if (toolId === 'write_file') {
    return 'write'
  }

  if (toolId === 'edit_file') {
    return 'edit'
  }

  return toolId === 'delete_file' ? 'delete' : undefined
}

async function captureFilePrecondition(
  guard: PathGuard,
  inputPath: string,
  operation: FileOperation,
): Promise<FilePrecondition> {
  const absolutePath = guard.resolveCandidate(inputPath)
  const parentPath = path.dirname(absolutePath)
  const parentRealPath = path.resolve(await realpath(parentPath))
  const parentStat = await stat(parentRealPath)

  guard.assertInside(parentRealPath)

  if (!parentStat.isDirectory()) {
    throw new PathGuardError(
      'NOT_A_DIRECTORY',
      'Target parent is not a directory',
    )
  }

  let targetStat: Awaited<ReturnType<typeof lstat>>

  try {
    targetStat = await lstat(absolutePath)
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }

    return Object.freeze({
      kind: 'file',
      operation,
      path: portableRelative(guard.workspacePath, absolutePath),
      absolutePath,
      parentRealPath,
      expectedParentId: directoryId(parentStat),
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

  const targetRealPath = path.resolve(await realpath(absolutePath))
  guard.assertInside(targetRealPath)
  const content = await readFile(targetRealPath)

  return Object.freeze({
    kind: 'file',
    operation,
    path: portableRelative(guard.workspacePath, targetRealPath),
    absolutePath,
    parentRealPath,
    expectedParentId: directoryId(parentStat),
    expectedExists: true,
    expectedRealPath: targetRealPath,
    expectedFileId: resourceId(targetStat),
    expectedContentHash: hash(content),
  })
}

async function assertFilePrecondition(
  workspace: string,
  expected: FilePrecondition,
): Promise<void> {
  const guard = PathGuard.fromCanonical(workspace)
  const current = await captureFilePrecondition(
    guard,
    expected.absolutePath,
    expected.operation,
  )
  const changed =
    current.path !== expected.path ||
    normalizeForCompare(current.absolutePath) !==
      normalizeForCompare(expected.absolutePath) ||
    normalizeForCompare(current.parentRealPath) !==
      normalizeForCompare(expected.parentRealPath) ||
    current.expectedParentId !== expected.expectedParentId ||
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

function truncateDiff(value: string): string {
  if (value.length <= MAX_DIFF_CHARS) {
    return value
  }

  return `${value.slice(0, MAX_DIFF_CHARS)}\n... diff truncated ...\n`
}

export function createFileDiff(
  filePath: string,
  before: string,
  after: string,
): string {
  const oldLines = before.split(/\r?\n/)
  const newLines = after.split(/\r?\n/)
  const body = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n')

  return truncateDiff(`${body}\n`)
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0

  while ((index = content.indexOf(needle, index)) !== -1) {
    count += 1
    index += Math.max(needle.length, 1)
  }

  return count
}

function argsObject(call: ToolCall): Record<string, JsonValue> {
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    throw new Error('Tool args must be an object')
  }

  return call.args
}

function policySignals(
  operation: FileOperation,
  targetPath: string,
  before: string,
  after: string,
): PolicySignal[] {
  const signals: PolicySignal[] = []
  const changedBytes = Buffer.byteLength(before) + Buffer.byteLength(after)

  signals.push({
    code: `filesystem_${operation}`,
    severity: operation === 'delete' ? 'danger' : 'warning',
    detail: `${operation} ${targetPath}`,
  })

  if (changedBytes > 200_000) {
    signals.push({
      code: 'large_file_diff',
      severity: 'danger',
      detail: `The planned file diff covers ${changedBytes} bytes`,
    })
  }

  if (
    /(^|\/)(\.env(?:\.|$)|\.npmrc$|id_rsa$|[^/]+\.(?:pem|key)$)/iu.test(
      targetPath,
    )
  ) {
    signals.push({
      code: 'sensitive_file_path',
      severity: 'danger',
      detail: `The target path may contain credentials: ${targetPath}`,
    })
  }

  return signals
}

export async function prepareToolResourcePlan(input: {
  workspace: string
  call: ToolCall
  definition: ToolDefinition
}): Promise<ToolResourcePlan> {
  const guard = PathGuard.fromCanonical(input.workspace)
  const operation = operationFor(input.call.toolId)

  if (!operation) {
    if (input.definition.effects.includes('filesystem.read')) {
      const args = argsObject(input.call)
      const candidate = typeof args.path === 'string' ? args.path : '.'
      await guard.resolveExisting(candidate)
    }

    return { preconditions: [], policySignals: [] }
  }

  const args = argsObject(input.call)
  const targetPath = String(args.path)
  const precondition = await captureFilePrecondition(
    guard,
    targetPath,
    operation,
  )
  const before = precondition.expectedExists
    ? await readFile(precondition.expectedRealPath!, 'utf8')
    : ''
  let after: string

  if (operation === 'write') {
    after = String(args.content)
  } else if (operation === 'edit') {
    if (!precondition.expectedExists) {
      throw new PathGuardError('PATH_NOT_FOUND', 'Edit target does not exist')
    }

    const oldText = String(args.old)
    const matches = countOccurrences(before, oldText)

    if (matches !== 1) {
      throw new PathGuardError(
        'RESOURCE_CHANGED',
        `edit_file old text must match exactly once; found ${matches}`,
      )
    }

    after = before.replace(oldText, String(args.new))
  } else {
    if (!precondition.expectedExists) {
      throw new PathGuardError('PATH_NOT_FOUND', 'Delete target does not exist')
    }

    after = ''
  }

  const diff = createFileDiff(precondition.path, before, after)

  return {
    preconditions: [precondition],
    policySignals: policySignals(operation, precondition.path, before, after),
    diff,
    diffHash: hash(diff),
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

async function atomicReplace(
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

async function atomicDelete(
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

function mutationPrecondition(
  approved: ApprovedToolCall,
  operation: FileOperation,
): FilePrecondition {
  const precondition = approved.resourcePreconditions.find(
    (candidate) => candidate.operation === operation,
  )

  if (!precondition) {
    throw new Error('Approved file precondition is missing')
  }

  return precondition
}

function errorResult(error: unknown): ToolResult {
  return {
    status: 'error',
    code:
      error instanceof PathGuardError
        ? error.code
        : error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'FILE_MUTATION_FAILED',
    message: error instanceof Error ? error.message : 'File mutation failed',
    retryable: false,
  }
}

export function createFileToolDefinitions(): ToolDefinition[] {
  const writeFile: ToolDefinition<typeof WriteFileArgsSchema> = {
    id: 'write_file',
    description:
      'Create or replace a UTF-8 file inside the workspace. Requires permission approval.',
    inputSchema: WriteFileArgsSchema,
    effects: ['filesystem.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 200_000,
    async execute(args, context) {
      try {
        const precondition = mutationPrecondition(context.approvedCall, 'write')
        await atomicReplace(
          context.workspace.canonicalPath,
          precondition,
          args.content,
          context.signal,
        )

        return {
          status: 'ok',
          content: {
            path: precondition.path,
            operation: 'write',
            contentHash: hash(args.content),
          },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const editFile: ToolDefinition<typeof EditFileArgsSchema> = {
    id: 'edit_file',
    description:
      'Replace one exact, unique text occurrence in a UTF-8 workspace file. Requires permission approval.',
    inputSchema: EditFileArgsSchema,
    effects: ['filesystem.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 200_000,
    async execute(args, context) {
      try {
        const precondition = mutationPrecondition(context.approvedCall, 'edit')
        const current = await readFile(precondition.absolutePath, 'utf8')
        const matches = countOccurrences(current, args.old)

        if (matches !== 1) {
          throw new PathGuardError(
            'RESOURCE_CHANGED',
            `edit_file old text must match exactly once; found ${matches}`,
          )
        }

        const updated = current.replace(args.old, args.new)
        await atomicReplace(
          context.workspace.canonicalPath,
          precondition,
          updated,
          context.signal,
        )

        return {
          status: 'ok',
          content: {
            path: precondition.path,
            operation: 'edit',
            contentHash: hash(updated),
          },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const deleteFile: ToolDefinition<typeof DeleteFileArgsSchema> = {
    id: 'delete_file',
    description:
      'Delete one regular file inside the workspace. Requires permission approval.',
    inputSchema: DeleteFileArgsSchema,
    effects: ['filesystem.delete'],
    defaultRisk: 'high',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 100_000,
    async execute(_args, context) {
      try {
        const precondition = mutationPrecondition(
          context.approvedCall,
          'delete',
        )
        await atomicDelete(
          context.workspace.canonicalPath,
          precondition,
          context.signal,
        )

        return {
          status: 'ok',
          content: {
            path: precondition.path,
            operation: 'delete',
          },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  return [writeFile, editFile, deleteFile]
}

export function registerFileTools(registry: ToolRegistry): void {
  for (const definition of createFileToolDefinitions()) {
    registry.registerTool(definition)
  }
}
