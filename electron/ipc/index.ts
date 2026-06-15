import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import type { ValidateFunction } from 'ajv'
import {
  IPC_CONTRACTS,
  IPC_VERSION,
  type IpcChannel,
  type IpcError,
  type IpcPayload,
  type IpcResult,
} from '../../shared/ipc-contract'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { validateIpcSender } from './validate-sender'
import {
  DEFAULT_PAYLOAD_LIMITS,
  toJsonDetails,
  validatePayloadLimits,
  type PayloadLimits,
} from './validators'

export type IpcBusinessHandler<Channel extends IpcChannel> = (
  payload: IpcPayload<Channel>,
  event: IpcMainInvokeEvent,
) => Promise<unknown> | unknown

export type IpcBusinessHandlers = {
  [Channel in IpcChannel]?: IpcBusinessHandler<Channel>
}

export interface IpcRegistrarOptions {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  getTrustedWebContents: () => WebContents | undefined
  isAllowedUrl: (url: string) => boolean
  handlers?: IpcBusinessHandlers
  limits?: PayloadLimits
  onDiagnostic?: (message: string, error?: unknown) => void
}

export class IpcFault extends Error {
  readonly error: IpcError

  constructor(error: IpcError) {
    super(error.message)
    this.name = 'IpcFault'
    this.error = error
  }
}

const payloadValidators = Object.fromEntries(
  Object.entries(IPC_CONTRACTS).map(([channel, contract]) => [
    channel,
    compileSchema(contract.payload),
  ]),
) as Record<IpcChannel, ValidateFunction>

const resultValidators = Object.fromEntries(
  Object.entries(IPC_CONTRACTS).map(([channel, contract]) => [
    channel,
    compileSchema(contract.result),
  ]),
) as Record<IpcChannel, ValidateFunction>

function failure<Channel extends IpcChannel>(
  error: IpcError,
): IpcResult<Channel> {
  return {
    version: IPC_VERSION,
    ok: false,
    error,
  } as IpcResult<Channel>
}

function success<Channel extends IpcChannel>(
  value: unknown,
): IpcResult<Channel> {
  return {
    version: IPC_VERSION,
    ok: true,
    value,
  } as IpcResult<Channel>
}

export async function handleIpcInvocation<Channel extends IpcChannel>(
  channel: Channel,
  event: IpcMainInvokeEvent,
  payload: unknown,
  options: Omit<IpcRegistrarOptions, 'ipcMain'>,
): Promise<IpcResult<Channel>> {
  const sender = validateIpcSender(
    event,
    options.getTrustedWebContents(),
    options.isAllowedUrl,
  )

  if (!sender.valid) {
    return failure({
      code: 'INVALID_SENDER',
      message: sender.reason,
    })
  }

  const limitResult = validatePayloadLimits(
    payload,
    options.limits ?? DEFAULT_PAYLOAD_LIMITS,
  )

  if (!limitResult.valid) {
    return failure({
      code: limitResult.code,
      message: limitResult.message,
    })
  }

  const validatePayload = payloadValidators[channel]

  if (!validatePayload(payload)) {
    return failure({
      code: 'INVALID_PAYLOAD',
      message: formatSchemaErrors(validatePayload.errors),
    })
  }

  const handler = options.handlers?.[channel] as
    | IpcBusinessHandler<Channel>
    | undefined

  if (!handler) {
    return failure({
      code: 'NOT_AVAILABLE',
      message: `${channel} is not available in the current implementation stage`,
    })
  }

  try {
    const result = success<Channel>(
      await handler(payload as IpcPayload<Channel>, event),
    )
    const validateResult = resultValidators[channel]

    if (!validateResult(result)) {
      options.onDiagnostic?.(
        `IPC handler ${channel} returned an invalid result`,
        validateResult.errors,
      )
      return failure({
        code: 'INTERNAL_ERROR',
        message: 'IPC handler returned an invalid result',
      })
    }

    return result
  } catch (error) {
    if (error instanceof IpcFault) {
      return failure(error.error)
    }

    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'SECRET_STORAGE_UNAVAILABLE'
        ? 'SECRET_STORAGE_UNAVAILABLE'
        : 'INTERNAL_ERROR'

    options.onDiagnostic?.(`IPC handler ${channel} failed`, error)
    return failure({
      code,
      message:
        code === 'SECRET_STORAGE_UNAVAILABLE'
          ? 'Secure credential storage is unavailable'
          : 'The request could not be completed',
      details:
        code === 'SECRET_STORAGE_UNAVAILABLE'
          ? undefined
          : toJsonDetails({ channel }),
    })
  }
}

export function registerIpcHandlers(options: IpcRegistrarOptions): () => void {
  const channels = Object.keys(IPC_CONTRACTS) as IpcChannel[]

  for (const channel of channels) {
    options.ipcMain.handle(channel, (event, payload) =>
      handleIpcInvocation(channel, event, payload, options),
    )
  }

  return () => {
    for (const channel of channels) {
      options.ipcMain.removeHandler(channel)
    }
  }
}
