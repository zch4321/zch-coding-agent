import path from 'node:path'
import type { AgentExecutionId } from '../../shared/ids'
import { artifactPathFor } from '../project-artifacts/access'
import type { SessionTempPaths } from '../session-temp/service'

export interface SubagentArtifacts {
  directory: string
  activityPath: string
  resultPath: string
  sessionTemp?: SessionTempPaths
  available: boolean
  captureError?: string
  tail: Promise<void>
}

/** Allocates a child's registered output paths without publishing or sealing its capture. */
export async function allocateSubagentArtifacts(
  executionId: AgentExecutionId,
  sessionTemp: SessionTempPaths | undefined,
): Promise<SubagentArtifacts> {
  if (!sessionTemp) {
    return {
      directory: '',
      activityPath: '',
      resultPath: '',
      available: false,
      captureError: 'Session temp is unavailable',
      tail: Promise.resolve(),
    }
  }
  let directory = ''
  let captureError: string | undefined
  try {
    directory = await artifactPathFor(sessionTemp, ['subagents', executionId])
  } catch (error) {
    captureError = String(error)
  }
  return {
    directory,
    activityPath: path.join(directory, 'activity.jsonl'),
    resultPath: path.join(directory, 'result.md'),
    sessionTemp,
    available: captureError === undefined,
    captureError,
    tail: Promise.resolve(),
  }
}
