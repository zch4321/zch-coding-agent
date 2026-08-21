import type { RunId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { renderTaggedJson } from '../../shared/tagged-message'
import type { TodoState } from '../../shared/todo'

/** Renders the authoritative checklist snapshot for one active Run. */
export function todoStateContext(
  runId: RunId,
  todo: TodoState | undefined,
): string {
  return renderTaggedJson(
    'todo_state',
    (todo ? structuredClone(todo) : null) as JsonValue,
    { run_id: runId },
  )
}
