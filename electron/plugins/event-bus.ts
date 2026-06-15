import type {
  BeforeLLMCallEmitResult,
  BeforeToolCallEmitResult,
  HookContextMap,
  HookDiagnostic,
  HookHandler,
  HookHandlerResultMap,
  HookName,
  ObservationEmitResult,
  PluginApi,
} from './types'
import type { ToolDefinition, ToolRegistrationPort } from '../tools/types'

export interface PluginEventBusOptions {
  timeoutMs?: number
  onDiagnostic?: (diagnostic: HookDiagnostic, error?: unknown) => void
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }

  Object.freeze(value)

  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }

  return value
}

function readonlySnapshot<Value>(value: Value): Readonly<Value> {
  return deepFreeze(structuredClone(value))
}

export class PluginEventBus implements PluginApi {
  readonly #timeoutMs: number
  readonly #onDiagnostic: PluginEventBusOptions['onDiagnostic']
  readonly #handlers = new Map<HookName, Set<HookHandler<HookName>>>()
  #toolRegistrationPort: ToolRegistrationPort | undefined

  constructor(options: PluginEventBusOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 2_000
    this.#onDiagnostic = options.onDiagnostic
  }

  on<Name extends HookName>(
    hook: Name,
    handler: HookHandler<Name>,
  ): () => void {
    let handlers = this.#handlers.get(hook)

    if (!handlers) {
      handlers = new Set()
      this.#handlers.set(hook, handlers)
    }

    handlers.add(handler as HookHandler<HookName>)
    return () => {
      handlers?.delete(handler as HookHandler<HookName>)
    }
  }

  setToolRegistrationPort(port: ToolRegistrationPort | undefined): void {
    this.#toolRegistrationPort = port
  }

  registerTool(definition: ToolDefinition): void {
    if (!this.#toolRegistrationPort) {
      throw new Error('Tool registration is not available in the current stage')
    }

    this.#toolRegistrationPort.registerTool(definition)
  }

  emit(
    hook: 'beforeLLMCall',
    context: HookContextMap['beforeLLMCall'],
  ): Promise<BeforeLLMCallEmitResult>
  emit(
    hook: 'beforeToolCall',
    context: HookContextMap['beforeToolCall'],
  ): Promise<BeforeToolCallEmitResult>
  emit<Name extends Exclude<HookName, 'beforeLLMCall' | 'beforeToolCall'>>(
    hook: Name,
    context: HookContextMap[Name],
  ): Promise<ObservationEmitResult>
  async emit(
    hook: HookName,
    context: HookContextMap[HookName],
  ): Promise<
    BeforeLLMCallEmitResult | BeforeToolCallEmitResult | ObservationEmitResult
  > {
    const handlers = [
      ...(this.#handlers.get(hook) ?? []),
    ] as HookHandler<HookName>[]
    const snapshot = readonlySnapshot(context)
    const diagnostics: HookDiagnostic[] = []

    if (hook === 'beforeLLMCall') {
      const patches: BeforeLLMCallEmitResult['patches'] = []

      for (const handler of handlers) {
        const result = await this.#invoke(hook, handler, snapshot, diagnostics)

        if (result && typeof result === 'object' && 'patch' in result) {
          const patch = result.patch

          if (patch) {
            patches.push(structuredClone(patch))
          }
        }
      }

      return { patches, diagnostics }
    }

    if (hook === 'beforeToolCall') {
      let risk: BeforeToolCallEmitResult['risk'] = 'unchanged'

      for (const handler of handlers) {
        const result = await this.#invoke(hook, handler, snapshot, diagnostics)

        if (result === undefined) {
          if (diagnostics.at(-1)?.hook === hook) {
            return {
              allow: false,
              risk,
              reason: 'A security hook failed or timed out',
              diagnostics,
            }
          }
          continue
        }

        if (
          typeof result === 'object' &&
          'allow' in result &&
          result.allow === false &&
          'reason' in result
        ) {
          return {
            allow: false,
            risk,
            reason: result.reason,
            diagnostics,
          }
        }

        if (
          typeof result === 'object' &&
          'raiseRisk' in result &&
          result.raiseRisk
        ) {
          if (result.raiseRisk === 'high' || risk === 'unchanged') {
            risk = result.raiseRisk
          }
        }
      }

      return { allow: true, risk, diagnostics }
    }

    for (const handler of handlers) {
      await this.#invoke(hook, handler, snapshot, diagnostics)
    }

    return { diagnostics }
  }

  async #invoke(
    hook: HookName,
    handler: HookHandler<HookName>,
    context: Readonly<HookContextMap[HookName]>,
    diagnostics: HookDiagnostic[],
  ): Promise<HookHandlerResultMap[HookName] | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Hook timed out after ${this.#timeoutMs}ms`)),
          this.#timeoutMs,
        )
      })
      return await Promise.race([Promise.resolve(handler(context)), timeout])
    } catch (error) {
      const diagnostic = {
        hook,
        message:
          error instanceof Error ? error.message : 'Hook failed unexpectedly',
      }
      diagnostics.push(diagnostic)
      this.#onDiagnostic?.(diagnostic, error)
      return undefined
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}
