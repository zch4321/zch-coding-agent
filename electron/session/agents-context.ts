import { createHash } from 'node:crypto'
import path from 'node:path'
import type { ContextAttachmentRef } from '../../shared/context'
import { PathGuard, PathGuardError } from '../safety/path-guard'

const AGENTS_FILES = ['AGENTS.md', 'AGENTS.override.md'] as const
const MAX_AGENTS_FILES = 16
const MAX_AGENTS_BYTES = 64 * 1_024
type AgentsInstructionKind = (typeof AGENTS_FILES)[number]

export interface AgentsInstruction {
  path: string
  kind: AgentsInstructionKind
  depth: number
  priority: number
  content: string
  totalBytes: number
  truncated: boolean
  sha256: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function directoryChain(portablePath: string): string[] {
  const normalized = portablePath.replace(/\\/gu, '/')
  const withoutFile = normalized.endsWith('/')
    ? normalized
    : normalized.includes('/')
      ? normalized.slice(0, normalized.lastIndexOf('/'))
      : ''
  const segments = withoutFile.split('/').filter(Boolean)
  const dirs = ['.']
  let current = ''

  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    dirs.push(current)
  }

  return dirs
}

interface AgentsCandidate {
  path: string
  kind: AgentsInstructionKind
  depth: number
  priority: number
}

function agentsCandidates(
  attachments: ContextAttachmentRef[],
): AgentsCandidate[] {
  const dirs = new Set<string>(['.'])

  for (const attachment of attachments) {
    const target =
      attachment.kind === 'directory'
        ? attachment.path.replace(/\\/gu, '/').replace(/\/$/u, '')
        : attachment.path
    for (const dir of directoryChain(target)) {
      dirs.add(dir || '.')
    }

    if (attachment.kind === 'directory') {
      dirs.add(target || '.')
    }
  }

  return [...dirs]
    .flatMap((dir) =>
      AGENTS_FILES.map((fileName) => ({
        path: dir === '.' ? fileName : `${dir}/${fileName}`,
        kind: fileName,
        depth: dir === '.' ? 0 : dir.split('/').filter(Boolean).length,
      })),
    )
    .map((candidate, index) => ({
      path: candidate.path,
      kind: candidate.kind,
      depth: candidate.depth,
      priority: index,
    }))
    .slice(0, MAX_AGENTS_FILES)
}

/** Loads AGENTS instructions from the workspace and selected attachments under path guards. */
export async function loadAgentsInstructions(input: {
  workspace: string
  attachments: ContextAttachmentRef[]
  guard?: PathGuard
  signal?: AbortSignal
}): Promise<AgentsInstruction[]> {
  const guard = input.guard ?? (await PathGuard.create(input.workspace))
  const results: AgentsInstruction[] = []

  for (const candidate of agentsCandidates(input.attachments)) {
    if (input.signal?.aborted) {
      throw input.signal.reason
    }

    try {
      const file = await guard.readFileBounded(
        candidate.path,
        MAX_AGENTS_BYTES,
        input.signal,
      )
      results.push({
        path: file.path,
        kind: candidate.kind,
        depth: candidate.depth,
        priority: candidate.priority,
        content: file.content,
        totalBytes: file.totalBytes,
        truncated: file.truncated,
        sha256: sha256(file.content),
      })
    } catch (error) {
      if (
        error instanceof PathGuardError &&
        (error.code === 'PATH_NOT_FOUND' || error.code === 'NOT_A_FILE')
      ) {
        continue
      }

      throw error
    }
  }

  return results
}

/** Combines instruction files into a labeled prompt section in load order. */
export function formatAgentsInstructions(
  instructions: AgentsInstruction[],
): string {
  if (instructions.length === 0) {
    return ''
  }

  const sections = instructions.map((instruction) =>
    [
      `<agents path="${instruction.path}" kind="${instruction.kind}" depth="${instruction.depth}" priority="${instruction.priority}" sha256="${instruction.sha256}" bytes="${instruction.totalBytes}" truncated="${instruction.truncated}">`,
      instruction.content,
      '</agents>',
    ].join('\n'),
  )

  return sections.join('\n\n')
}

/** Builds a stable cache key from the workspace and attachment path. */
export function agentsCacheKey(
  workspace: string,
  attachmentPath: string,
): string {
  return `${path.resolve(workspace)}::${attachmentPath}`
}
