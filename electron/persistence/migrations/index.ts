import initialSql from './0001_initial.sql?raw'
import fileChangeWorkspaceSql from './0002_file_change_workspace.sql?raw'
import fileChangeRetentionTotalsSql from './0003_file_change_retention_totals.sql?raw'
import providerTypeSql from './0004_provider_type.sql?raw'
import subagentExecutionsSql from './0005_subagent_executions.sql?raw'
import reasoningLevelsSql from './0006_reasoning_levels.sql?raw'

export interface DatabaseMigration {
  version: number
  name: string
  sql: string
  /**
   * Table-rebuild migrations set this to run with foreign key enforcement
   * paused; the runner validates `PRAGMA foreign_key_check` before committing.
   */
  disableForeignKeys?: boolean
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: '0001_initial',
    sql: initialSql,
  },
  {
    version: 2,
    name: '0002_file_change_workspace',
    sql: fileChangeWorkspaceSql,
  },
  {
    version: 3,
    name: '0003_file_change_retention_totals',
    sql: fileChangeRetentionTotalsSql,
  },
  {
    version: 4,
    name: '0004_provider_type',
    sql: providerTypeSql,
  },
  {
    version: 5,
    name: '0005_subagent_executions',
    sql: subagentExecutionsSql,
  },
  {
    version: 6,
    name: '0006_reasoning_levels',
    sql: reasoningLevelsSql,
    disableForeignKeys: true,
  },
]
