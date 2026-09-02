import { createHash } from 'node:crypto'
import { Type } from '@sinclair/typebox'
import type { PublicConfig } from '../../shared/config'
import {
  ensureDirectory,
  readUtf8File,
  removeFileIfPresent,
  writeUtf8Atomic,
} from '../common/filesystem'
import { PathGuard, PathGuardError } from '../safety/path-guard'
import { resolveSessionTempToolPath } from '../session-temp/path-alias'
import type { SessionTempPaths } from '../session-temp/service'
import {
  isSessionScratchTarget,
  resolveFileMutationTarget,
  type FileMutationTarget,
} from './file-tool-target'
import {
  MAX_MUTATION_FILE_BYTES,
  MAX_PATCH_BYTES,
  MAX_WRITE_BYTES,
} from './file-tool-limits'
import {
  argsObject,
  filePolicySignals,
  gitPolicySignals,
  operationFor,
  processPolicySignals,
} from './file-tool-policy'
import type { FileOperation, ToolResourcePlan } from './file-tool-types'
import { projectFileMutationResult } from './tool-result-formatters'
import type { ToolCall, ToolDefinition, ToolResult } from './types'
import type { ToolRegistry } from './tool-registry'
import { applyTextPatch, TextPatchError } from './text-patch'

const WriteFileArgsSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4_096,
      description:
        'Workspace-relative path or absolute path inside Session scratch. Missing parent directories are created and an existing regular file is replaced.',
    }),
    content: Type.String({
      maxLength: MAX_WRITE_BYTES,
      description: 'Complete UTF-8 content to write to the file.',
    }),
  },
  { additionalProperties: false },
)

const ApplyPatchArgsSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4_096,
      description:
        'Workspace-relative path or absolute Session-scratch path of one existing UTF-8 text file to modify.',
    }),
    patch: Type.String({
      minLength: 1,
      maxLength: MAX_PATCH_BYTES,
      description:
        'Single-file unified diff. Every context/deleted sequence must have one exact match in the latest file content.',
    }),
  },
  { additionalProperties: false },
)

const DeleteFileArgsSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 4_096,
      description:
        'Workspace-relative path or absolute Session-scratch path of one regular file to delete. A missing target is a successful no-op.',
    }),
  },
  { additionalProperties: false },
)

type FileToolLimits = Pick<
  PublicConfig['limits'],
  'editableFileBytes' | 'writeFileBytes' | 'patchBytes'
>

const DEFAULT_FILE_TOOL_LIMITS: FileToolLimits = {
  editableFileBytes: MAX_MUTATION_FILE_BYTES,
  writeFileBytes: MAX_WRITE_BYTES,
  patchBytes: MAX_PATCH_BYTES,
}

function fileLimits(limits?: Partial<FileToolLimits>): FileToolLimits {
  return {
    editableFileBytes: Math.min(
      limits?.editableFileBytes ?? MAX_MUTATION_FILE_BYTES,
      MAX_MUTATION_FILE_BYTES,
    ),
    writeFileBytes: Math.min(
      limits?.writeFileBytes ?? MAX_WRITE_BYTES,
      MAX_WRITE_BYTES,
    ),
    patchBytes: Math.min(
      limits?.patchBytes ?? MAX_PATCH_BYTES,
      MAX_PATCH_BYTES,
    ),
  }
}

/** Builds current path validation and policy metadata for one tool call. */
export async function prepareToolResourcePlan(input: {
  workspace: string
  sessionTemp?: SessionTempPaths
  call: ToolCall
  definition: ToolDefinition
  limits?: Partial<FileToolLimits>
}): Promise<ToolResourcePlan> {
  const operation = operationFor(input.call.toolId)
  if (!operation) {
    if (input.definition.effects.includes('filesystem.read')) {
      const args = argsObject(input.call)
      const candidate = typeof args.path === 'string' ? args.path : '.'
      const guard = PathGuard.fromCanonical(
        input.workspace,
        input.sessionTemp?.root,
      )
      await guard.resolveExisting(
        resolveSessionTempToolPath(candidate, input.sessionTemp),
      )
    }
    return {
      policySignals: [
        ...processPolicySignals(input.call),
        ...gitPolicySignals(input.call),
      ],
    }
  }

  const args = argsObject(input.call)
  const target = await currentTarget(
    input.workspace,
    input.sessionTemp,
    String(args.path),
    operation,
  )
  const scratchMutation = await isSessionScratchTarget(
    target,
    input.workspace,
    input.sessionTemp,
  )
  if (target.rootKind === 'session-temp' && !scratchMutation) {
    throw new PathGuardError(
      'PATH_OUTSIDE_WORKSPACE',
      'Built-in file mutations may only write to the Session scratch directory; artifacts are application-owned',
    )
  }

  const limits = fileLimits(input.limits)
  let afterBytes = 0
  if (operation === 'write') {
    afterBytes = Buffer.byteLength(String(args.content), 'utf8')
  } else if (operation === 'patch') {
    const before = await readPatchTarget(target, limits.editableFileBytes)
    const applied = applyTextPatch(before, String(args.patch), target.path)
    afterBytes = Buffer.byteLength(applied.content, 'utf8')
    if (afterBytes > limits.editableFileBytes) {
      throw new PathGuardError(
        'FILE_TOO_LARGE',
        `The resulting file exceeds ${limits.editableFileBytes} bytes`,
      )
    }
  }

  return {
    scratchMutation,
    policySignals: filePolicySignals(operation, target.path, {
      beforeBytes: target.size,
      afterBytes,
    }),
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
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

async function currentTarget(
  workspace: string,
  sessionTemp: SessionTempPaths | undefined,
  targetPath: string,
  operation: FileOperation,
): Promise<FileMutationTarget> {
  return resolveFileMutationTarget({
    workspace,
    sessionTemp,
    path: targetPath,
    operation,
  })
}

async function readPatchTarget(
  target: FileMutationTarget,
  maximumBytes: number,
): Promise<string> {
  if (!target.exists || !target.realPath) {
    throw new PathGuardError('PATH_NOT_FOUND', 'Patch target does not exist')
  }
  if (target.size > maximumBytes) {
    throw new PathGuardError(
      'FILE_TOO_LARGE',
      `File mutations support files up to ${maximumBytes} bytes`,
    )
  }
  try {
    return await readUtf8File(target.realPath, maximumBytes)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EFBIG'
    ) {
      throw new PathGuardError(
        'FILE_TOO_LARGE',
        error instanceof Error ? error.message : 'File is too large',
      )
    }
    throw error
  }
}

/** Creates schemas and handlers for write, patch, and idempotent delete tools. */
export function createFileToolDefinitions(
  getLimits: () => Partial<FileToolLimits> = () => DEFAULT_FILE_TOOL_LIMITS,
): ToolDefinition[] {
  const writeFile: ToolDefinition<typeof WriteFileArgsSchema> = {
    id: 'write_file',
    executionMode: 'serial',
    description:
      'Write complete UTF-8 content to a workspace or Session-scratch file. Creates missing parents and replaces an existing regular file while preserving its permission mode.',
    inputSchema: WriteFileArgsSchema,
    effects: ['filesystem.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    projectResultForModel: (result) =>
      projectFileMutationResult(result, 'written'),
    validateArgs(args) {
      const limit = fileLimits(getLimits()).writeFileBytes
      return Buffer.byteLength(args.content, 'utf8') > limit
        ? `write_file content must not exceed ${limit} UTF-8 bytes`
        : undefined
    },
    async execute(args, context) {
      try {
        let target = await currentTarget(
          context.workspace.canonicalPath,
          context.sessionTemp,
          args.path,
          'write',
        )
        await ensureDirectory(target.parentRealPath)
        target = await currentTarget(
          context.workspace.canonicalPath,
          context.sessionTemp,
          args.path,
          'write',
        )
        await writeUtf8Atomic(target.absolutePath, args.content, {
          signal: context.signal,
        })
        return {
          status: 'ok',
          content: {
            path: target.path,
            operation: 'write',
            created: !target.exists,
            contentHash: contentHash(args.content),
          },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const applyPatch: ToolDefinition<typeof ApplyPatchArgsSchema> = {
    id: 'apply_patch',
    executionMode: 'serial',
    description:
      'Apply a single-file unified diff to the latest file content. Every context/deleted sequence must match exactly once; missing or ambiguous context causes no write.',
    inputSchema: ApplyPatchArgsSchema,
    effects: ['filesystem.write'],
    defaultRisk: 'review',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    projectResultForModel: (result) =>
      projectFileMutationResult(result, 'patched'),
    validateArgs(args) {
      const limit = fileLimits(getLimits()).patchBytes
      return Buffer.byteLength(args.patch, 'utf8') > limit
        ? `apply_patch patch must not exceed ${limit} UTF-8 bytes`
        : undefined
    },
    async execute(args, context) {
      try {
        const limits = fileLimits(getLimits())
        const target = await currentTarget(
          context.workspace.canonicalPath,
          context.sessionTemp,
          args.path,
          'patch',
        )
        const current = await readPatchTarget(target, limits.editableFileBytes)
        const applied = applyTextPatch(current, args.patch, target.path)
        if (
          Buffer.byteLength(applied.content, 'utf8') > limits.editableFileBytes
        ) {
          throw new PathGuardError(
            'FILE_TOO_LARGE',
            `The resulting file exceeds ${limits.editableFileBytes} bytes`,
          )
        }
        await writeUtf8Atomic(target.absolutePath, applied.content, {
          signal: context.signal,
        })
        return {
          status: 'ok',
          content: {
            path: target.path,
            operation: 'patch',
            hunks: applied.hunks,
            addedLines: applied.addedLines,
            removedLines: applied.removedLines,
            contentHash: contentHash(applied.content),
          },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  const deleteFile: ToolDefinition<typeof DeleteFileArgsSchema> = {
    id: 'delete_file',
    executionMode: 'serial',
    description:
      'Delete one regular file inside the workspace or Session scratch. A missing target is an idempotent success.',
    inputSchema: DeleteFileArgsSchema,
    effects: ['filesystem.delete'],
    defaultRisk: 'high',
    supportsAbort: true,
    defaultTimeoutMs: 20_000,
    projectResultForModel: (result) =>
      projectFileMutationResult(result, 'deleted'),
    async execute(args, context) {
      try {
        const target = await currentTarget(
          context.workspace.canonicalPath,
          context.sessionTemp,
          args.path,
          'delete',
        )
        const deleted = target.exists
          ? await removeFileIfPresent(target.absolutePath, context.signal)
          : false
        return {
          status: 'ok',
          content: {
            path: target.path,
            operation: 'delete',
            deleted,
          },
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  }

  return [writeFile, applyPatch, deleteFile]
}

/** Registers all file mutation definitions with the tool registry. */
export function registerFileTools(
  registry: ToolRegistry,
  getLimits?: () => Partial<FileToolLimits>,
): void {
  for (const definition of createFileToolDefinitions(getLimits)) {
    registry.registerTool(definition)
  }
}
