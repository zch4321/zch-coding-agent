import { DOMAIN_STATE_API_CONTRACTS } from '../domain-state-api'
import {
  AcceptedSchema,
  EmptyPayloadSchema,
  domainIpcContract,
  ipcResultSchema,
} from './common'

export const APP_BOOTSTRAP_IPC_CONTRACTS = {
  'app:get-bootstrap': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['app:get-bootstrap'],
  ),
} as const

export const WINDOW_IPC_CONTRACTS = {
  'window:minimize': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(AcceptedSchema),
  },
  'window:toggle-maximize': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(AcceptedSchema),
  },
  'window:close': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(AcceptedSchema),
  },
} as const
