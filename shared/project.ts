import { Type, type Static } from '@sinclair/typebox'
import {
  DateTimeSchema,
  DurableSchemaVersionSchema,
  MAX_PATH_LENGTH,
  RevisionSchema,
} from './durable'
import { ProjectIdSchema } from './ids'

export const ProjectRecordSchema = Type.Object(
  {
    schemaVersion: DurableSchemaVersionSchema,
    id: ProjectIdSchema,
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    revision: RevisionSchema,
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
)
export type ProjectRecord = Static<typeof ProjectRecordSchema>
