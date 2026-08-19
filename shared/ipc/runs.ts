import { Type } from '@sinclair/typebox'
import { IPC_VERSION } from '../channels'
import { DOMAIN_STATE_API_CONTRACTS } from '../domain-state-api'
import { CallIdSchema, RunIdSchema, SessionIdSchema } from '../ids'
import { AcceptedSchema, domainIpcContract, ipcResultSchema } from './common'

export const RUN_IPC_CONTRACTS = {
  'run:start': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['run:start']),
  'run:retry': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['run:retry']),
  'run:interrupt': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        runId: RunIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'run:interject': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        runId: RunIdSchema,
        message: Type.String({ minLength: 1, maxLength: 1_000_000 }),
        clientRequestId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
  'approval:decide': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        runId: RunIdSchema,
        callId: CallIdSchema,
        decision: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
        remember: Type.Optional(
          Type.Object(
            {
              workspaceScope: Type.Union([
                Type.Literal('workspace'),
                Type.Literal('global'),
              ]),
              expiresAt: Type.Optional(Type.String({ format: 'date-time' })),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(AcceptedSchema),
  },
} as const
