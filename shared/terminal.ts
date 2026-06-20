import { Type, type Static } from '@sinclair/typebox'
import { TerminalIdSchema } from './ids'

export const TerminalStatusSchema = Type.Union([
  Type.Literal('opening'),
  Type.Literal('running'),
  Type.Literal('closed'),
  Type.Literal('failed'),
])
export type TerminalStatus = Static<typeof TerminalStatusSchema>

export const TerminalInfoSchema = Type.Object(
  {
    terminalId: TerminalIdSchema,
    cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
    shell: Type.String({ minLength: 1, maxLength: 4_096 }),
    status: TerminalStatusSchema,
    cols: Type.Integer({ minimum: 2, maximum: 1_000 }),
    rows: Type.Integer({ minimum: 1, maximum: 1_000 }),
    seq: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
export type TerminalInfo = Static<typeof TerminalInfoSchema>

export const TerminalSnapshotSchema = Type.Object(
  {
    terminal: TerminalInfoSchema,
    data: Type.String({ maxLength: 2_000_000 }),
    cursor: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    totalBytes: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
export type TerminalSnapshot = Static<typeof TerminalSnapshotSchema>
