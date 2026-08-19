import { Type } from '@sinclair/typebox'
import { IPC_VERSION } from '../channels'
import { DOMAIN_STATE_API_CONTRACTS } from '../domain-state-api'
import { SessionIdSchema } from '../ids'
import { domainIpcContract, ipcResultSchema } from './common'

export const SESSION_IPC_CONTRACTS = {
  'session:list': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['session:list']),
  'session:get': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['session:get']),
  'session:update': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:update'],
  ),
  'session:archive': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:archive'],
  ),
  'session:restore': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:restore'],
  ),
  'session:delete': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:delete'],
  ),
  'session:fork': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['session:fork']),
  'session:rewind': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:rewind'],
  ),
  'session:search': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['session:search'],
  ),
  'session:export-markdown': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        confirmed: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          canceled: Type.Boolean(),
          path: Type.Optional(Type.String({ maxLength: 4_096 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'message:list': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['message:list']),
  'message:search': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['message:search'],
  ),
  'file-change:list': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['file-change:list'],
  ),
  'file-change:revert': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['file-change:revert'],
  ),
} as const
