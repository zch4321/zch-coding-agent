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
import { applyTextPatch, TextPatchError } from './text-patch'

const MAX_MUTATION_FILE_BYTES = 10_000_000
const MAX_WRITE_BYTES = 256 * 1_024
const MAX_DIFF_CHARS = 120_000
const MAX_PATCH_BYTES = 64 * 1_024

const WriteFileArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    content: Type.String({ maxLength: MAX_WRITE_BYTES }),
  },
  { additionalProperties: false },
)

const ApplyPatchArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    patch: Type.String({ minLength: 1, maxLength: MAX_PATCH_BYTES }),
  },
  { additionalProperties: false },
)

const DeleteFileArgsSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
  },
  { additionalProperties: false },
)

export type FileOperation = 'write' | 'patch' | 'delete'

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
  readonly patchHash?: string
  readonly expectedResultHash?: string
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

  if (toolId === 'apply_patch') {
    return 'patch'
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

  if (targetStat.size > MAX_MUTATION_FILE_BYTES) {
    throw new PathGuardError(
      'FILE_TOO_LARGE',
      `File mutations support files up to ${MAX_MUTATION_FILE_BYTES} bytes`,
    )
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

function argsObject(call: ToolCall): Record<string, JsonValue> {
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    throw new Error('Tool args must be an object')
  }

  return call.args
}

function processPolicySignals(call: ToolCall): PolicySignal[] {
  if (call.toolId !== 'run_command') {
    return []
  }

  const args = argsObject(call)
  const shellMode = args.mode === 'shell'
  const command = shellMode
    ? String(args.command ?? '')
    : [
        String(args.executable ?? ''),
        ...(Array.isArray(args.args) ? args.args : []),
      ]
        .map(String)
        .join(' ')
  const signals: PolicySignal[] = [
    {
      code: shellMode ? 'shell_command' : 'process_spawn',
      severity: 'warning',
      detail: shellMode
        ? `Shell command delegated to the approval model: ${command.slice(0, 1_024)}`
        : `Spawn process: ${command.slice(0, 1_024)}`,
    },
  ]

  const dangerousPatterns: Array<[RegExp, string, string]> = [
    [
      /\brm\b(?=[^;&|\r\n]*(?:\s--recursive\b|\s-[a-z]*r[a-z]*\b))(?=[^;&|\r\n]*(?:\s--force\b|\s-[a-z]*f[a-z]*\b))/iu,
      'forced_recursive_delete',
      'Forced recursive rm deletion',
    ],
    [
      /\b(?:remove-item|ri|rm)\b(?=[^;&|\r\n]*\s-recurse\b)(?=[^;&|\r\n]*\s-force\b)/iu,
      'forced_recursive_delete',
      'Forced recursive PowerShell deletion',
    ],
    [
      /\b(?:del|erase|rmdir|rd)\b(?=[^&|\r\n]*\s\/s\b)(?=[^&|\r\n]*\s\/q\b)/iu,
      'forced_recursive_delete',
      'Quiet recursive Windows deletion',
    ],
    [
      /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*d|push\b)/iu,
      'destructive_git',
      'Destructive or remote Git operation',
    ],
    [
      /\b(?:npm|pnpm)\s+publish\b|\byarn\s+npm\s+publish\b|\bdocker\s+push\b/iu,
      'publish',
      'Package or image publication',
    ],
    [
      /\b(?:kubectl\s+(?:apply|delete)|terraform\s+(?:apply|destroy))\b/iu,
      'deployment',
      'Infrastructure mutation or deployment',
    ],
    [
      /\b(?:format|diskpart|wipefs|mkfs(?:\.\w+)?|clear-disk|initialize-disk)\b|\bdd\b[^\r\n]*\bof=\/dev\//iu,
      'disk_mutation',
      'Disk formatting or raw-device mutation',
    ],
  ]

  for (const [pattern, code, detail] of dangerousPatterns) {
    if (pattern.test(command)) {
      signals.push({
        code,
        severity: 'danger',
        detail,
      })
    }
  }

  return signals
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

    return {
      preconditions: [],
      policySignals: processPolicySignals(input.call),
    }
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
    if (precondition.expectedExists) {
      throw new PathGuardError(
        'PATH_ALREADY_EXISTS',
        'write_file only creates new files; use apply_patch for an existing file',
      )
    }

    after = String(args.content)
  } else if (operation === 'patch') {
    if (!precondition.expectedExists) {
      throw new PathGuardError('PATH_NOT_FOUND', 'Patch target does not exist')
    }

    after = applyTextPatch(
      before,
      String(args.patch),
      precondition.path,
    ).content
  } else {
    if (!precondition.expectedExists) {
      throw new PathGuardError('PATH_NOT_FOUND', 'Delete target does not exist')
    }

    after = ''
  }

  if (Buffer.byteLength(after, 'utf8') > MAX_MUTATION_FILE_BYTES) {
    throw new PathGuardError(
      'FILE_TOO_LARGE',
      `The resulting file exceeds ${MAX_MUTATION_FILE_BYTES} bytes`,
    )
  }

  const diff = createFileDiff(precondition.path, before, after)

  const plannedPrecondition =
    operation === 'patch'
      ? Object.freeze({
          ...precondition,
          patchHash: hash(String(args.patch)),
          expectedResultHash: hash(after),
        })
      : precondition

  return {
    preconditions: [plannedPrecondition],
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
      error instanceof PathGuardError || error instanceof TextPatchError
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
      'Create a new UTF-8 file inside the workspace. Use apply_patch when the file already exists.',
    inputSchema: WriteFileArgsSchema,
    effects: ['filesystem.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 200_000,
    validateArgs(args) {
      return Buffer.byteLength(args.content, 'utf8') > MAX_WRITE_BYTES
        ? `write_file content must not exceed ${MAX_WRITE_BYTES} UTF-8 bytes`
        : undefined
    },
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

  const applyPatch: ToolDefinition<typeof ApplyPatchArgsSchema> = {
    id: 'apply_patch',
    description:
      'Apply a strict single-file unified diff with one or more hunks. Context and line numbers must match exactly.',
    inputSchema: ApplyPatchArgsSchema,
    effects: ['filesystem.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    maxOutputBytes: 200_000,
    validateArgs(args) {
      return Buffer.byteLength(args.patch, 'utf8') > MAX_PATCH_BYTES
        ? `apply_patch patch must not exceed ${MAX_PATCH_BYTES} UTF-8 bytes`
        : undefined
    },
    async execute(args, context) {
      try {
        const precondition = mutationPrecondition(context.approvedCall, 'patch')
        const current = await readFile(precondition.absolutePath, 'utf8')
        const applied = applyTextPatch(current, args.patch, precondition.path)

        if (
          precondition.patchHash !== hash(args.patch) ||
          precondition.expectedResultHash !== hash(applied.content)
        ) {
          throw new PathGuardError(
            'RESOURCE_CHANGED',
            'The approved patch no longer matches its planned result',
          )
        }

        await atomicReplace(
          context.workspace.canonicalPath,
          precondition,
          applied.content,
          context.signal,
        )

        return {
          status: 'ok',
          content: {
            path: precondition.path,
            operation: 'patch',
            hunks: applied.hunks,
            addedLines: applied.addedLines,
            removedLines: applied.removedLines,
            contentHash: hash(applied.content),
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

  return [writeFile, applyPatch, deleteFile]
}

export function registerFileTools(registry: ToolRegistry): void {
  for (const definition of createFileToolDefinitions()) {
    registry.registerTool(definition)
  }
}
