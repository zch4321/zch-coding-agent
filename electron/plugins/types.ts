import type { CallId, RunId, SessionId } from '../../shared/ids'
import type { JsonObject, JsonValue } from '../../shared/json'
import type { ToolCall, ToolRegistrationPort, ToolResult } from '../tools/types'

export type HookName =
  | 'onSessionStart'
  | 'onSessionEnd'
  | 'beforeLLMCall'
  | 'afterLLMCall'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'beforeApproval'

interface HookContextBase {
  version: 1
  sessionId: SessionId
}

export interface HookContextMap {
  onSessionStart: HookContextBase & {
    workspace: string
    mode: string
  }
  onSessionEnd: HookContextBase & {
    reason: string
  }
  beforeLLMCall: HookContextBase & {
    runId: RunId
    messages: readonly JsonValue[]
    params: Readonly<JsonObject>
  }
  afterLLMCall: HookContextBase & {
    runId: RunId
    response: JsonValue
    usage?: JsonValue
  }
  beforeToolCall: HookContextBase & {
    runId: RunId
    call: Readonly<ToolCall>
    currentRisk: 'low' | 'review' | 'high'
  }
  afterToolCall: HookContextBase & {
    runId: RunId
    call: Readonly<ToolCall>
    result: Readonly<ToolResult>
  }
  beforeApproval: HookContextBase & {
    runId: RunId
    callId: CallId
    policySignals: readonly JsonValue[]
  }
}

export interface BeforeLLMCallPatch {
  messages?: JsonValue[]
  params?: JsonObject
}

export interface HookHandlerResultMap {
  onSessionStart: void
  onSessionEnd: void
  beforeLLMCall: { patch?: BeforeLLMCallPatch } | void
  afterLLMCall: void
  beforeToolCall:
    | {
        allow: false
        reason: string
      }
    | {
        allow?: true
        raiseRisk?: 'review' | 'high'
      }
    | void
  afterToolCall: void
  beforeApproval: void
}

export type HookHandler<Name extends HookName> = (
  context: Readonly<HookContextMap[Name]>,
) => HookHandlerResultMap[Name] | Promise<HookHandlerResultMap[Name]>

export interface HookDiagnostic {
  hook: HookName
  message: string
}

export interface BeforeLLMCallEmitResult {
  patches: BeforeLLMCallPatch[]
  diagnostics: HookDiagnostic[]
}

export interface BeforeToolCallEmitResult {
  allow: boolean
  risk: 'unchanged' | 'review' | 'high'
  reason?: string
  diagnostics: HookDiagnostic[]
}

export interface ObservationEmitResult {
  diagnostics: HookDiagnostic[]
}

export interface PluginApi {
  on<Name extends HookName>(hook: Name, handler: HookHandler<Name>): () => void
  registerTool: ToolRegistrationPort['registerTool']
}
