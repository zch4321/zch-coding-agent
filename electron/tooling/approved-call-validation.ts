import { createHash } from 'node:crypto'
import path from 'node:path'
import type { RunId, SessionId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import { PathGuardError } from '../safety/path-guard'
import { approvedCallBrand, type ApprovedToolCall } from './approved-tool-call'

/** Hashes tool arguments so an approval is bound to the exact call payload. */
export function createArgsHash(args: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex')
}

function comparablePath(value: string | undefined): string | undefined {
  if (!value) return undefined
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Checks that an approved call still matches its owner, arguments, and filesystem scope. */
export function revalidateApprovedToolCall(
  approvedCall: ApprovedToolCall,
  context: {
    sessionId: SessionId
    runId: RunId
    workspace: string
    sessionTempRoot?: string
  },
): void {
  if (approvedCall[approvedCallBrand] !== true) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'Tool execution requires an ApprovedToolCall issued by the permission pipeline',
    )
  }

  if (
    approvedCall.sessionId !== context.sessionId ||
    approvedCall.runId !== context.runId
  ) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'Approved call ownership does not match the execution context',
    )
  }

  if (approvedCall.argsHash !== createArgsHash(approvedCall.args)) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'Approved call arguments changed before execution',
    )
  }

  if (
    comparablePath(approvedCall.workspace) !==
      comparablePath(context.workspace) ||
    comparablePath(approvedCall.sessionTempRoot) !==
      comparablePath(context.sessionTempRoot)
  ) {
    throw new PathGuardError(
      'RESOURCE_CHANGED',
      'Approved call filesystem scope changed before execution',
    )
  }
}
