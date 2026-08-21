import { renderTaggedText, unwrapTaggedText } from '../../shared/tagged-message'

const SWARM_SHARED_CONTEXT_TAG = 'swarm_shared_context'
const SWARM_TASK_TAG = 'swarm_task'

/** Formats common Swarm background as an escaped model-visible harness block. */
export function swarmSharedContextContent(value: string): string {
  return renderTaggedText(SWARM_SHARED_CONTEXT_TAG, value)
}

/** Formats one Child-specific Swarm assignment as an escaped user-input block. */
export function swarmTaskContent(value: string): string {
  return renderTaggedText(SWARM_TASK_TAG, value)
}

/** Returns the original task text from a tagged Swarm assignment when present. */
export function unwrapSwarmTaskContent(value: string): string | undefined {
  return unwrapTaggedText(SWARM_TASK_TAG, value)
}
