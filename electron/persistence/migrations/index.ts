import initialSql from './0001_initial.sql?raw'

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
]
