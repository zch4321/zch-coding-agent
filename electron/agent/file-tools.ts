import { readFile } from 'node:fs/promises'
import { Type } from '@sinclair/typebox'
import type { PublicConfig } from '../../shared/config'
import type { ToolCall, ToolDefinition, ToolResult } from '../tools/types'
import { atomicDelete, atomicReplace } from './file-tool-atomic'
import { createFileDiff } from './file-tool-diff'
import {
  MAX_DIFF_CHARS,
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
import { captureFilePrecondition, hash } from './file-tool-preconditions'
export { createFileDiff } from './file-tool-diff'
export { revalidateResourcePreconditions } from './file-tool-preconditions'
import type {
  FileOperation,
  FilePrecondition,
  ToolResourcePlan,
} from './file-tool-types'
export type {
  FileOperation,
  FilePrecondition,
  ToolResourcePlan,
} from './file-tool-types'
import { PathGuard, PathGuardError } from '../safety/path-guard'
import type { ApprovedToolCall } from '../tools/approved-tool-call'
import type { ToolRegistry } from './tool-registry'
import { applyTextPatch, TextPatchError } from './text-patch'

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

type FileToolLimits = Pick<
  PublicConfig['limits'],
  'editableFileBytes' | 'writeFileBytes' | 'patchBytes' | 'diffChars'
>

const DEFAULT_FILE_TOOL_LIMITS: FileToolLimits = {
  editableFileBytes: MAX_MUTATION_FILE_BYTES,
  writeFileBytes: MAX_WRITE_BYTES,
  patchBytes: MAX_PATCH_BYTES,
  diffChars: MAX_DIFF_CHARS,
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
    diffChars: Math.min(limits?.diffChars ?? MAX_DIFF_CHARS, MAX_DIFF_CHARS),
  }
}

export async function prepareToolResourcePlan(input: {
  workspace: string
  call: ToolCall
  definition: ToolDefinition
  limits?: Partial<FileToolLimits>
}): Promise<ToolResourcePlan> {
  const guard = PathGuard.fromCanonical(input.workspace)
  const operation = operationFor(input.call.toolId)
  const limits = fileLimits(input.limits)

  if (!operation) {
    if (input.definition.effects.includes('filesystem.read')) {
      const args = argsObject(input.call)
      const candidate = typeof args.path === 'string' ? args.path : '.'
      await guard.resolveExisting(candidate)
    }

    return {
      preconditions: [],
      policySignals: [
        ...processPolicySignals(input.call),
        ...gitPolicySignals(input.call),
      ],
    }
  }

  const args = argsObject(input.call)
  const targetPath = String(args.path)
  const precondition = await captureFilePrecondition(
    guard,
    targetPath,
    operation,
    limits.editableFileBytes,
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

  if (Buffer.byteLength(after, 'utf8') > limits.editableFileBytes) {
    throw new PathGuardError(
      'FILE_TOO_LARGE',
      `The resulting file exceeds ${limits.editableFileBytes} bytes`,
    )
  }

  const diff = createFileDiff(precondition.path, before, after)

  if (diff.length > limits.diffChars) {
    throw new PathGuardError(
      'FILE_TOO_LARGE',
      `The preview diff exceeds ${limits.diffChars} characters`,
    )
  }

  const plannedPrecondition = Object.freeze({
    ...precondition,
    ...(operation === 'patch' ? { patchHash: hash(String(args.patch)) } : {}),
    expectedResultHash: hash(after),
    expectedResultContent: after,
  })

  return {
    preconditions: [plannedPrecondition],
    policySignals: filePolicySignals(
      operation,
      precondition.path,
      before,
      after,
    ),
    diff,
    diffHash: hash(diff),
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

export function createFileToolDefinitions(
  getLimits: () => Partial<FileToolLimits> = () => DEFAULT_FILE_TOOL_LIMITS,
): ToolDefinition[] {
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
      const limit = fileLimits(getLimits()).writeFileBytes
      return Buffer.byteLength(args.content, 'utf8') > limit
        ? `write_file content must not exceed ${limit} UTF-8 bytes`
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
      const limit = fileLimits(getLimits()).patchBytes
      return Buffer.byteLength(args.patch, 'utf8') > limit
        ? `apply_patch patch must not exceed ${limit} UTF-8 bytes`
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

export function registerFileTools(
  registry: ToolRegistry,
  getLimits?: () => Partial<FileToolLimits>,
): void {
  for (const definition of createFileToolDefinitions(getLimits)) {
    registry.registerTool(definition)
  }
}
