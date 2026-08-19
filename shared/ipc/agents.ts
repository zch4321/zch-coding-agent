import { Type } from '@sinclair/typebox'
import {
  AgentExecutionDetailSchema,
  AgentExecutionListCursorSchema,
  AgentExecutionSummaryPageSchema,
  MAX_AGENT_EXECUTION_PAGE_RECORDS,
} from '../agent-execution'
import { IPC_VERSION } from '../channels'
import { DOMAIN_STATE_API_CONTRACTS } from '../domain-state-api'
import { MAX_MESSAGE_PAGE_RECORDS } from '../durable'
import { AgentExecutionIdSchema, SessionIdSchema } from '../ids'
import { PlanStatusSchema } from '../orchestration'
import { ipcResultSchema } from './common'

export const AGENT_EXECUTION_IPC_CONTRACTS = {
  'agent-execution:list': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        parentSessionId: SessionIdSchema,
        before: Type.Optional(AgentExecutionListCursorSchema),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_AGENT_EXECUTION_PAGE_RECORDS,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { page: AgentExecutionSummaryPageSchema },
        { additionalProperties: false },
      ),
    ),
  },
  'agent-execution:get': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        parentSessionId: SessionIdSchema,
        executionId: AgentExecutionIdSchema,
        beforeSeq: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_MESSAGE_PAGE_RECORDS }),
        ),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        { detail: AgentExecutionDetailSchema },
        { additionalProperties: false },
      ),
    ),
  },
} as const

export const PLAN_IPC_CONTRACTS = {
  'plan:update-status': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        sessionId: SessionIdSchema,
        status: PlanStatusSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      DOMAIN_STATE_API_CONTRACTS['session:update'].result,
    ),
  },
} as const
