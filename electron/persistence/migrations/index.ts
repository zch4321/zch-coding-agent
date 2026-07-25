import initialSql from './0001_initial.sql?raw'
import fileChangeWorkspaceSql from './0002_file_change_workspace.sql?raw'

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
]
