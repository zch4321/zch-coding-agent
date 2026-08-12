const SWARM_SHARED_CONTEXT_TAG = 'swarm_shared_context'
const SWARM_TASK_TAG = 'swarm_task'

function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function unescapeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function taggedText(tag: string, value: string): string {
  return `<${tag}>\n${escapeXmlText(value.trim())}\n</${tag}>`
}

function unwrapTaggedText(tag: string, value: string): string | undefined {
  const trimmed = value.trim()
  const opening = `<${tag}>\n`
  const closing = `\n</${tag}>`
  if (!trimmed.startsWith(opening) || !trimmed.endsWith(closing)) {
    return undefined
  }
  return unescapeXmlText(trimmed.slice(opening.length, -closing.length))
}

/** Formats common Swarm background as an escaped model-visible harness block. */
export function swarmSharedContextContent(value: string): string {
  return taggedText(SWARM_SHARED_CONTEXT_TAG, value)
}

/** Formats one Child-specific Swarm assignment as an escaped user-input block. */
export function swarmTaskContent(value: string): string {
  return taggedText(SWARM_TASK_TAG, value)
}

/** Returns the original task text from a tagged Swarm assignment when present. */
export function unwrapSwarmTaskContent(value: string): string | undefined {
  return unwrapTaggedText(SWARM_TASK_TAG, value)
}
