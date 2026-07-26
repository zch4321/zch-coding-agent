import type { ProjectId } from '../../shared/ids'
import { ProjectRecordSchema, type ProjectRecord } from '../../shared/project'
import { compileSchema } from '../schema-validator'
import {
  assertSchemaValue,
  dateTimeColumn,
  integerColumn,
  stringColumn,
} from './codec-helpers'

const validateProjectRecord = compileSchema(ProjectRecordSchema)

export interface ProjectRow {
  schema_version: number
  id: string
  path: string
  name: string
  revision: number
  created_at: string
  updated_at: string
}

/** Encodes a ProjectRecord into its SQLite column representation. */
export function encodeProjectRow(record: ProjectRecord): ProjectRow {
  assertSchemaValue<ProjectRecord>(
    validateProjectRecord,
    record,
    'ProjectRecord',
  )
  return {
    schema_version: record.schemaVersion,
    id: record.id,
    path: record.path,
    name: record.name,
    revision: record.revision,
    created_at: dateTimeColumn(record.createdAt, 'projects.created_at'),
    updated_at: dateTimeColumn(record.updatedAt, 'projects.updated_at'),
  }
}

/** Decodes and validates a SQLite row as a ProjectRecord. */
export function decodeProjectRow(row: Record<string, unknown>): ProjectRecord {
  const record = {
    schemaVersion: integerColumn(row.schema_version, 'projects.schema_version'),
    id: stringColumn(row.id, 'projects.id') as ProjectId,
    path: stringColumn(row.path, 'projects.path'),
    name: stringColumn(row.name, 'projects.name'),
    revision: integerColumn(row.revision, 'projects.revision'),
    createdAt: dateTimeColumn(row.created_at, 'projects.created_at'),
    updatedAt: dateTimeColumn(row.updated_at, 'projects.updated_at'),
  }
  assertSchemaValue<ProjectRecord>(
    validateProjectRecord,
    record,
    'ProjectRecord row',
  )
  return record
}
