import { Type } from '@sinclair/typebox'
import {
  BackgroundTaskPageSchema,
  BackgroundTaskTargetSchema,
  BackgroundTerminalTailSchema,
} from '../background-tasks'
import { IPC_VERSION } from '../channels'
import { SessionIdSchema, TerminalIdSchema } from '../ids'
import { AcceptedSchema, ipcResultSchema } from './common'

const context = {
  version: Type.Literal(IPC_VERSION),
  parentSessionId: SessionIdSchema,
}
const instance = Type.String({ minLength: 1, maxLength: 256 })
export const BACKGROUND_IPC_CONTRACTS = {
  'background:list': {
    payload: Type.Object(
      {
        ...context,
        before: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(BackgroundTaskPageSchema),
  },
  'background:cancel': {
    payload: Type.Object(
      {
        ...context,
        backendInstanceId: instance,
        target: BackgroundTaskTargetSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'background:terminal-tail': {
    payload: Type.Object(
      { ...context, backendInstanceId: instance, terminalId: TerminalIdSchema },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(BackgroundTerminalTailSchema),
  },
} as const
