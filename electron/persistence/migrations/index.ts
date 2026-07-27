import initialSql from './0001_initial.sql?raw'
import fileChangeWorkspaceSql from './0002_file_change_workspace.sql?raw'
import fileChangeRetentionTotalsSql from './0003_file_change_retention_totals.sql?raw'
import providerTypeSql from './0004_provider_type.sql?raw'

export interface DatabaseMigration {
  version: number
  name: string
  sql: string
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
]
