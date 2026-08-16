/** Model-visible Git tools that inspect repository state without mutating it. */
export const GIT_READ_ONLY_TOOL_IDS = [
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_refs',
] as const

const GIT_READ_ONLY_TOOL_ID_SET = new Set<string>(GIT_READ_ONLY_TOOL_IDS)

/** Returns whether a tool ID belongs to the built-in read-only Git catalog. */
export function isGitReadOnlyToolId(toolId: string): boolean {
  return GIT_READ_ONLY_TOOL_ID_SET.has(toolId)
}
