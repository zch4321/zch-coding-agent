import { Type } from '@sinclair/typebox'
import { IPC_VERSION } from '../channels'
import { SessionIdSchema, TerminalIdSchema } from '../ids'
import { TerminalInfoSchema, TerminalSnapshotSchema } from '../terminal'
import { AcceptedSchema, ipcResultSchema } from './common'

export const TERMINAL_IPC_CONTRACTS = {
  'terminal:input': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        terminalId: TerminalIdSchema,
        data: Type.String({ maxLength: 262_144 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'terminal:open': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
        cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 1_000 })),
        rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { terminal: TerminalInfoSchema },
        { additionalProperties: false },
      ),
    ),
  },
  'terminal:list': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { terminals: Type.Array(TerminalInfoSchema, { maxItems: 128 }) },
        { additionalProperties: false },
      ),
    ),
  },
  'terminal:resize': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        terminalId: TerminalIdSchema,
        cols: Type.Integer({ minimum: 2, maximum: 1_000 }),
        rows: Type.Integer({ minimum: 1, maximum: 1_000 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'terminal:close': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        terminalId: TerminalIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'terminal:snapshot': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        terminalId: TerminalIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(TerminalSnapshotSchema),
  },
} as const
