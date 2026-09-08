import type { ArtifactKind, ArtifactRef } from '../../shared/project-artifacts'
import type {
  PersistenceReader,
  PersistenceTransaction,
} from './database-service'
import { PersistenceError } from './persistence-error'

export interface ArtifactRecord extends ArtifactRef {
  ownerSessionId: string
  sourceKey: string
  relativePath: string
  status: 'active' | 'complete' | 'failed' | 'interrupted' | 'expired'
  createdAt: number
  finalizedAt?: number
  captureError?: string
}

const COLUMNS = `project_id AS projectId, kind, id, owner_session_id AS ownerSessionId,
  source_key AS sourceKey, relative_path AS relativePath, status, created_at AS createdAt,
  finalized_at AS finalizedAt, capture_error AS captureError`

/** Persists project roots, monotonic artifact identities and capture lifecycle independently of task handles. */
export class ProjectArtifactRepository {
  /** Finds a stable root, retaining its former binding until the filesystem link is verified. */
  root(
    reader: PersistenceReader,
    projectId: string,
  ): { id: number; workspace: string } | undefined {
    return reader
      .prepare(
        'SELECT id, workspace FROM project_runtime_roots WHERE project_id = ?',
      )
      .get(projectId) as { id: number; workspace: string } | undefined
  }

  /** Assigns one permanent root number to a project without reusing removed root numbers. */
  ensureRoot(
    transaction: PersistenceTransaction,
    projectId: string,
    workspace: string,
  ): { id: number; workspace: string } {
    transaction
      .prepare(
        'INSERT INTO project_runtime_roots(project_id, workspace) VALUES (?, ?) ON CONFLICT(project_id) DO NOTHING',
      )
      .run(projectId, workspace)
    return this.root(transaction, projectId)!
  }

  /** Updates the recorded workspace after the managed entry has been safely rebound. */
  bindRoot(
    transaction: PersistenceTransaction,
    projectId: string,
    workspace: string,
  ): void {
    transaction
      .prepare(
        'UPDATE project_runtime_roots SET workspace = ? WHERE project_id = ?',
      )
      .run(workspace, projectId)
  }

  /** Finds an artifact using its durable producer key rather than a process-local handle. */
  find(
    reader: PersistenceReader,
    projectId: string,
    kind: ArtifactKind,
    ownerSessionId: string,
    sourceKey: string,
  ): ArtifactRecord | undefined {
    return reader
      .prepare(
        `SELECT ${COLUMNS} FROM project_artifacts WHERE project_id = ? AND kind = ? AND owner_session_id = ? AND source_key = ?`,
      )
      .get(projectId, kind, ownerSessionId, sourceKey) as unknown as
      | ArtifactRecord
      | undefined
  }

  /** Allocates and registers a capture atomically; retries for the same source retain their ID. */
  allocate(
    transaction: PersistenceTransaction,
    input: {
      projectId: string
      kind: ArtifactKind
      ownerSessionId: string
      sourceKey: string
      now: number
    },
  ): ArtifactRecord {
    const existing = this.find(
      transaction,
      input.projectId,
      input.kind,
      input.ownerSessionId,
      input.sourceKey,
    )
    if (existing) return existing
    transaction
      .prepare(
        'INSERT INTO project_artifact_sequences(project_id, kind, next_id) VALUES (?, ?, 1) ON CONFLICT DO NOTHING',
      )
      .run(input.projectId, input.kind)
    const row = transaction
      .prepare(
        'SELECT next_id AS id FROM project_artifact_sequences WHERE project_id = ? AND kind = ?',
      )
      .get(input.projectId, input.kind)
    const id = Number(row?.id)
    if (!Number.isSafeInteger(id) || id < 1 || id >= Number.MAX_SAFE_INTEGER)
      throw new PersistenceError(
        'CODEC_INVALID',
        'Project artifact ID space is exhausted',
      )
    transaction
      .prepare(
        'UPDATE project_artifact_sequences SET next_id = next_id + 1 WHERE project_id = ? AND kind = ?',
      )
      .run(input.projectId, input.kind)
    const suffix =
      input.kind === 'terminals'
        ? '.log'
        : ['web-search', 'mcp'].includes(input.kind)
          ? '.json'
          : ''
    const relativePath = `artifacts/${input.kind}/${id}${suffix}`
    transaction
      .prepare(
        `INSERT INTO project_artifacts(project_id,kind,id,owner_session_id,source_key,relative_path,status,created_at)
      VALUES(?,?,?,?,?,?,'active',?)`,
      )
      .run(
        input.projectId,
        input.kind,
        id,
        input.ownerSessionId,
        input.sourceKey,
        relativePath,
        input.now,
      )
    return {
      ...input,
      projectId: input.projectId as ArtifactRef['projectId'],
      id,
      relativePath,
      status: 'active',
      createdAt: input.now,
    }
  }

  /** Seals a capture once; later reads and callbacks never renew its retention deadline. */
  finish(
    transaction: PersistenceTransaction,
    ref: ArtifactRef,
    now: number,
    error?: string,
  ): void {
    transaction
      .prepare(
        `UPDATE project_artifacts SET status = ?, finalized_at = ?, capture_error = ?
      WHERE project_id = ? AND kind = ? AND id = ? AND status = 'active'`,
      )
      .run(
        error ? 'failed' : 'complete',
        now,
        error?.slice(0, 1024) ?? null,
        ref.projectId,
        ref.kind,
        ref.id,
      )
  }

  /** Marks captures abandoned by the previous exclusive backend as interrupted. */
  recover(transaction: PersistenceTransaction, now: number): void {
    transaction
      .prepare(
        "UPDATE project_artifacts SET status = 'interrupted', finalized_at = ? WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM project_artifact_legacy_paths l WHERE l.project_id = project_artifacts.project_id AND l.relative_path = project_artifacts.relative_path AND l.state = 'pending')",
      )
      .run(now)
  }

  /** Lists a bounded page of finished captures eligible for collection. */
  expired(reader: PersistenceReader, cutoff: number): ArtifactRecord[] {
    return reader
      .prepare(
        `SELECT ${COLUMNS} FROM project_artifacts WHERE status IN ('complete','failed','interrupted') AND finalized_at <= ? AND NOT EXISTS (SELECT 1 FROM project_artifact_legacy_paths l WHERE l.project_id = project_artifacts.project_id AND l.relative_path = project_artifacts.relative_path AND l.state = 'pending') ORDER BY finalized_at, project_id, kind, id LIMIT 256`,
      )
      .all(cutoff) as unknown as ArtifactRecord[]
  }

  /** Marks a successfully collected capture without deleting its identity or sequence. */
  markExpired(transaction: PersistenceTransaction, ref: ArtifactRef): void {
    transaction
      .prepare(
        "UPDATE project_artifacts SET status = 'expired' WHERE project_id = ? AND kind = ? AND id = ? AND status <> 'active'",
      )
      .run(ref.projectId, ref.kind, ref.id)
  }

  /** Registers an exact old path for native and tool-input compatibility. */
  rememberLegacy(
    transaction: PersistenceTransaction,
    projectId: string,
    sessionId: string,
    oldPath: string,
    relativePath: string,
  ): void {
    transaction
      .prepare(
        `INSERT INTO project_artifact_legacy_paths(project_id,source_session_id,old_path,relative_path)
      VALUES(?,?,?,?) ON CONFLICT(project_id,old_path) DO UPDATE SET relative_path = excluded.relative_path`,
      )
      .run(projectId, sessionId, oldPath, relativePath)
  }

  /** Lists captures originating in one public owner Session for explicit Headless export. */
  owned(
    reader: PersistenceReader,
    projectId: string,
    sessionId: string,
  ): ArtifactRecord[] {
    return reader
      .prepare(
        `SELECT ${COLUMNS} FROM project_artifacts WHERE project_id = ? AND owner_session_id = ? ORDER BY kind, id`,
      )
      .all(projectId, sessionId) as unknown as ArtifactRecord[]
  }

  /** Commits a verified migration after its destination is atomically installed. */
  completeLegacy(
    transaction: PersistenceTransaction,
    projectId: string,
    oldPath: string,
  ): void {
    transaction
      .prepare(
        "UPDATE project_artifact_legacy_paths SET state = 'ready' WHERE project_id = ? AND old_path = ?",
      )
      .run(projectId, oldPath)
  }

  /** Looks up capture lifecycle metadata for one project-relative path. */
  byPath(
    reader: PersistenceReader,
    projectId: string,
    relativePath: string,
  ): ArtifactRecord | undefined {
    return reader
      .prepare(
        `SELECT ${COLUMNS} FROM project_artifacts WHERE project_id = ? AND relative_path = ?`,
      )
      .get(projectId, relativePath) as unknown as ArtifactRecord | undefined
  }

  /** Lists registered legacy paths longest-first so file mappings precede directory mappings. */
  legacy(
    reader: PersistenceReader,
    projectId: string,
  ): Array<{
    oldPath: string
    relativePath: string
    sessionId: string
    state: 'pending' | 'ready'
  }> {
    return reader
      .prepare(
        'SELECT old_path AS oldPath, relative_path AS relativePath, source_session_id AS sessionId, state FROM project_artifact_legacy_paths WHERE project_id = ? ORDER BY length(old_path) DESC',
      )
      .all(projectId) as unknown as Array<{
      oldPath: string
      relativePath: string
      sessionId: string
      state: 'pending' | 'ready'
    }>
  }
}
