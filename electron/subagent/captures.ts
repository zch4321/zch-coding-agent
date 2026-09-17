import { appendFileContents as appendFile } from '../common/filesystem'
import type { AgentExecutionId } from '../../shared/ids'
import type { SubagentExecutionRecord } from '../persistence/subagent-repository'
import { finishArtifact } from '../project-artifacts/access'
import {
  touchSessionTempPath,
  writeSessionArtifactText,
  type SessionTempPaths,
} from '../session-temp/service'
import {
  allocateSubagentArtifacts,
  type SubagentArtifacts,
} from './execution-artifacts'

/** Keeps per-execution capture writers independent from the child conversation lifecycle. */
export class SubagentCaptures {
  readonly #artifacts = new Map<AgentExecutionId, SubagentArtifacts>()
  /** Reads live capture state for one execution. */
  get(id: AgentExecutionId): SubagentArtifacts | undefined {
    return this.#artifacts.get(id)
  }
  /** Opens an execution-scoped append-only activity capture. */
  async initialize(
    record: SubagentExecutionRecord,
    sessionTemp: SessionTempPaths | undefined,
  ): Promise<SubagentArtifacts> {
    const existing = this.#artifacts.get(record.id)
    if (existing) return existing
    const artifacts = await allocateSubagentArtifacts(record.id, sessionTemp)
    this.#artifacts.set(record.id, artifacts)
    if (!artifacts.available || !sessionTemp) return artifacts
    try {
      await writeSessionArtifactText(
        sessionTemp,
        ['subagents', record.id, 'activity.jsonl'],
        `${JSON.stringify({
          ts: new Date().toISOString(),
          type: 'status',
          status: record.status,
          executionId: record.id,
          name: record.name,
        })}\n`,
      )
    } catch (error) {
      artifacts.available = false
      artifacts.captureError =
        error instanceof Error ? error.message : String(error)
    }
    return artifacts
  }

  /** Appends bounded activity after previous writes. */
  append(record: SubagentExecutionRecord, value: unknown): void {
    const artifacts = this.#artifacts.get(record.id)
    if (!artifacts?.available) return
    artifacts.tail = artifacts.tail
      .then(async () => {
        await artifacts.sessionTemp?.artifactAccess?.validate?.(
          artifacts.activityPath,
        )
        await appendFile(artifacts.activityPath, `${JSON.stringify(value)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        })
        if (
          artifacts.sessionTemp &&
          record.status !== 'queued' &&
          record.status !== 'preparing' &&
          record.status !== 'running'
        ) {
          await touchSessionTempPath(artifacts.sessionTemp)
        }
      })
      .catch((error: unknown) => {
        artifacts.available = false
        artifacts.captureError =
          error instanceof Error ? error.message : String(error)
      })
  }

  /** Seals the capture after every activity/result write. */
  async finish(executionId: AgentExecutionId): Promise<void> {
    const artifact = this.#artifacts.get(executionId)
    await artifact?.tail
    if (!artifact) return
    await finishArtifact(
      artifact.sessionTemp,
      ['subagents', executionId],
      artifact.captureError,
    ).catch((error: unknown) => {
      artifact.available = false
      artifact.captureError = String(error)
    })
  }

  /** Writes the completed response into this execution artifact. */
  async writeResult(
    record: SubagentExecutionRecord,
    sessionTemp: SessionTempPaths | undefined,
    response: string,
  ): Promise<void> {
    const artifacts = this.#artifacts.get(record.id)
    if (!sessionTemp) return
    if (!artifacts?.available) return
    await artifacts.tail
    try {
      await writeSessionArtifactText(
        sessionTemp,
        ['subagents', record.id, 'result.md'],
        response,
      )
    } catch (error) {
      artifacts.available = false
      artifacts.captureError =
        error instanceof Error ? error.message : String(error)
    }
  }
}
