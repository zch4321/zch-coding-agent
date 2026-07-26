import { createHash } from 'node:crypto'
import type {
  ContextAttachmentChip,
  ContextAttachmentRef,
} from '../../shared/context'
import type { PublicConfig } from '../../shared/config'
import { PathGuard } from '../safety/path-guard'
import { estimateTextTokens } from '../tools/context-budget'
import {
  formatAgentsInstructions,
  loadAgentsInstructions,
} from './agents-context'

const MAX_CONTEXT_ATTACHMENTS = 32
const MAX_DIRECTORY_ENTRIES = 200

export interface PreparedRunContext {
  providerContent: string
  chips: ContextAttachmentChip[]
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeAttachment(
  attachment: ContextAttachmentRef,
): ContextAttachmentRef {
  return {
    kind: attachment.kind,
    path: attachment.path.replace(/\\/gu, '/'),
    source: attachment.source ?? 'mention',
  }
}

function dedupeAttachments(
  attachments: ContextAttachmentRef[],
): ContextAttachmentRef[] {
  const seen = new Set<string>()
  const result: ContextAttachmentRef[] = []

  for (const raw of attachments) {
    const attachment = normalizeAttachment(raw)
    const key = `${attachment.kind}:${attachment.path}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(attachment)
  }

  return result.slice(0, MAX_CONTEXT_ATTACHMENTS)
}

/** Prepares run context. */
export async function prepareRunContext(input: {
  workspace: string
  attachments: ContextAttachmentRef[]
  config: PublicConfig
  signal?: AbortSignal
}): Promise<PreparedRunContext> {
  const attachments = dedupeAttachments(input.attachments)
  const guard = await PathGuard.create(input.workspace)
  const chips: ContextAttachmentChip[] = []
  const attachmentSections: string[] = []
  const agents = await loadAgentsInstructions({
    workspace: input.workspace,
    attachments,
    guard,
    signal: input.signal,
  })
  const agentsContent = formatAgentsInstructions(agents)

  for (const attachment of attachments) {
    if (input.signal?.aborted) {
      throw input.signal.reason
    }

    if (attachment.kind === 'file') {
      const file = await guard.readFileBounded(
        attachment.path,
        input.config.limits.readFileOutputBytes,
        input.signal,
      )
      chips.push({
        kind: 'file',
        path: file.path,
        source: attachment.source ?? 'mention',
        totalBytes: file.totalBytes,
        truncated: file.truncated,
      })
      attachmentSections.push(
        [
          `<context_file path="${file.path}" sha256="${sha256(file.content)}" bytes="${file.totalBytes}" truncated="${file.truncated}">`,
          file.content,
          '</context_file>',
        ].join('\n'),
      )
      continue
    }

    const entries = await guard.listDirectory(attachment.path)
    const visible = entries
      .filter((entry) => entry.type === 'file' || entry.type === 'directory')
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === 'directory' ? -1 : 1
        }

        return left.path.localeCompare(right.path)
      })
    const limited = visible.slice(0, MAX_DIRECTORY_ENTRIES)
    chips.push({
      kind: 'directory',
      path: attachment.path,
      source: attachment.source ?? 'mention',
      truncated: visible.length > limited.length,
    })
    attachmentSections.push(
      [
        `<context_directory path="${attachment.path}" entries="${visible.length}" truncated="${visible.length > limited.length}">`,
        limited
          .map(
            (entry) =>
              `${entry.type === 'directory' ? 'dir ' : 'file'} ${entry.path}`,
          )
          .join('\n'),
        '</context_directory>',
      ].join('\n'),
    )
  }

  if (!agentsContent && attachmentSections.length === 0) {
    return { providerContent: '', chips }
  }

  const providerContent = [agentsContent, ...attachmentSections]
    .filter(Boolean)
    .join('\n\n')
  const estimatedTokens = estimateTextTokens(
    attachmentSections.join('\n\n'),
    input.config.limits.tokenEstimation,
  )
  if (estimatedTokens > input.config.limits.maxAttachmentContextTokens) {
    const references = attachments.map(
      (attachment) => `${attachment.kind} ${attachment.path}`,
    )
    return {
      providerContent: [
        agentsContent,
        [
          `<context_attachments content="filenames_only" reason="token_budget_exceeded" estimated_tokens="${estimatedTokens}" max_tokens="${input.config.limits.maxAttachmentContextTokens}">`,
          ...references,
          '</context_attachments>',
        ].join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n'),
      chips: chips.map((chip) => ({ ...chip, truncated: true })),
    }
  }

  return {
    providerContent,
    chips,
  }
}
