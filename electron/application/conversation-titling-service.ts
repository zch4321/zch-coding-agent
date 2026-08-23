import type { MessageId, RunId, SessionId } from '../../shared/ids'
import type { MessageRecord } from '../../shared/message'
import type { PublicConfig } from '../../shared/config'
import { getAuxiliaryModelSelection } from '../../shared/config'
import { normalizeTitle } from '../../shared/conversation-titles'
import type { SessionRecord } from '../../shared/session'
import type { ConfigStore } from '../config/store'
import type { DiagnosticSink } from '../diagnostics'
import {
  providerRequestDiagnostics,
  type ModelProvider,
  type ProviderEvent,
  type ProviderStreamContext,
} from '../providers/provider'
import { createConfiguredProvider } from '../providers/provider-factory'
import {
  resolveModelRoutePairFromConfig,
  type ResolvedModelRoute,
} from '../providers/model-route-resolver'
import type { PromptRegistry } from '../prompts/registry'
import type { RuntimeEventBus } from '../runtime/runtime-event-bus'
import type { RuntimeEventUnsubscribe } from '../runtime/runtime-events'
import { canonicalHash } from '../session/canonical-history'
import type { SessionService } from './session-service'
import type { OperationalLogService } from '../operational-logging/service'
import { ProviderAttemptRecorder } from '../operational-logging/provider-attempt-recorder'
import { ProviderTransportError } from '../providers/http-sse-transport'

const TITLING_TIMEOUT_MS = 15_000
const TITLING_MAX_OUTPUT_TOKENS = 128
const TITLING_INPUT_MAX_CHARS = 2_000

export interface ConversationTitlingOptions {
  configStore: ConfigStore
  sessions: SessionService
  prompts: PromptRegistry
  events: RuntimeEventBus
  fetchImpl?: typeof fetch
  onDiagnostic?: DiagnosticSink
  resolveRoute?: (
    config: PublicConfig,
    record: SessionRecord,
    completedRunRoute?: ResolvedModelRoute,
  ) => Promise<ResolvedModelRoute | undefined>
  getCompletedRunRoute?: (
    sessionId: SessionId,
    runId: RunId,
  ) => ResolvedModelRoute | undefined
  createProvider?: (route: ResolvedModelRoute) => ModelProvider
  timeoutMs?: number
  operationalLog?: Pick<OperationalLogService, 'log'>
}

/**
 * Resolves the titling route from the auxiliary role, the completed Run's
 * frozen main route, or finally the Session selection, in that order.
 */
export async function defaultResolveTitlingRoute(
  configStore: ConfigStore,
  config: PublicConfig,
  record: SessionRecord,
  completedRunRoute?: ResolvedModelRoute,
  onDiagnostic?: DiagnosticSink,
): Promise<ResolvedModelRoute | undefined> {
  const resolveSelection = async (selection: SessionRecord['modelSelection']) =>
    (await resolveModelRoutePairFromConfig(configStore, config, selection)).main
  const auxiliary = getAuxiliaryModelSelection(config)
  if (auxiliary) {
    try {
      return await resolveSelection(auxiliary)
    } catch (error) {
      onDiagnostic?.(
        'Auxiliary title route is unavailable; using the completed Run route',
        error,
        { audience: 'internal' },
      )
    }
  }
  if (completedRunRoute) return structuredClone(completedRunRoute)
  try {
    return await resolveSelection(record.modelSelection)
  } catch (error) {
    onDiagnostic?.('Conversation title fallback route is unavailable', error, {
      audience: 'internal',
    })
    return undefined
  }
}

/** Trims a raw model response into a safe conversation title candidate. */
export function sanitizeModelTitle(raw: string): string | undefined {
  const firstLine = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return undefined
  const stripped = firstLine
    .replace(/^[-*#>\s]+/u, '')
    .replace(/^(标题|title)[:：]\s*/iu, '')
    .replace(/^["'「『“‘]+|["'」』”’。.,，、]+$/gu, '')
    .trim()
  const normalized = normalizeTitle(stripped)
  return normalized.length > 0 ? normalized : undefined
}

function titlingRequestText(
  rules: string,
  userText: string,
  assistantText: string,
): string {
  return [
    rules,
    '',
    '<first_user_message>',
    userText,
    '</first_user_message>',
    '',
    '<first_assistant_reply>',
    assistantText,
    '</first_assistant_reply>',
  ].join('\n')
}

/**
 * Generates a one-shot model title for an auto-titled Session after its first
 * completed run. All failures are silent: the derived title simply stays.
 */
export class ConversationTitlingService {
  readonly #configStore: ConfigStore
  readonly #sessions: SessionService
  readonly #prompts: PromptRegistry
  readonly #onDiagnostic: DiagnosticSink | undefined
  readonly #resolveRoute: (
    config: PublicConfig,
    record: SessionRecord,
    completedRunRoute?: ResolvedModelRoute,
  ) => Promise<ResolvedModelRoute | undefined>
  readonly #getCompletedRunRoute:
    | ((sessionId: SessionId, runId: RunId) => ResolvedModelRoute | undefined)
    | undefined
  readonly #createProvider: (route: ResolvedModelRoute) => ModelProvider
  readonly #timeoutMs: number
  readonly #operationalLog: Pick<OperationalLogService, 'log'> | undefined
  readonly #attempted = new Set<SessionId>()
  readonly #inFlight = new Set<Promise<void>>()
  readonly #controllers = new Set<AbortController>()
  readonly #unsubscribe: RuntimeEventUnsubscribe
  #disposed = false

  constructor(options: ConversationTitlingOptions) {
    this.#configStore = options.configStore
    this.#sessions = options.sessions
    this.#prompts = options.prompts
    this.#onDiagnostic = options.onDiagnostic
    this.#resolveRoute =
      options.resolveRoute ??
      ((config, record, completedRunRoute) =>
        defaultResolveTitlingRoute(
          this.#configStore,
          config,
          record,
          completedRunRoute,
          this.#onDiagnostic,
        ))
    this.#getCompletedRunRoute = options.getCompletedRunRoute
    this.#timeoutMs = options.timeoutMs ?? TITLING_TIMEOUT_MS
    this.#operationalLog = options.operationalLog
    this.#createProvider =
      options.createProvider ??
      ((route) =>
        createConfiguredProvider(
          route.provider,
          route.apiKey,
          options.fetchImpl,
          route.snapshot.endpoint,
        ))
    this.#unsubscribe = options.events.subscribe({
      onAgentEvent: (event) => {
        if (event.type === 'run.status' && event.status === 'completed') {
          this.#schedule(
            event.sessionId,
            event.runId,
            this.#getCompletedRunRoute?.(event.sessionId, event.runId),
          )
        }
      },
    })
  }

  /** Waits for every in-flight titling attempt to settle. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#inFlight])
  }

  /** Stops listening and waits for any in-flight titling request to settle. */
  async dispose(): Promise<void> {
    this.#disposed = true
    this.#unsubscribe()
    for (const controller of this.#controllers) {
      controller.abort(new Error('Conversation titling service disposed'))
    }
    await this.settle()
  }

  #schedule(
    sessionId: SessionId,
    runId: RunId,
    completedRunRoute?: ResolvedModelRoute,
  ): void {
    if (this.#disposed || this.#attempted.has(sessionId)) return
    this.#attempted.add(sessionId)
    const pending = this.#generate(sessionId, runId, completedRunRoute)
      .catch((error) => {
        this.#onDiagnostic?.(
          `Conversation titling failed for Session ${sessionId}`,
          error,
          { audience: 'internal' },
        )
      })
      .finally(() => {
        this.#inFlight.delete(pending)
      })
    this.#inFlight.add(pending)
  }

  async #generate(
    sessionId: SessionId,
    runId: RunId,
    completedRunRoute?: ResolvedModelRoute,
  ): Promise<void> {
    const record = await this.#sessions
      .getRecord(sessionId)
      .catch(() => undefined)
    if (!record || record.titleSource !== 'auto') return

    const messages = await this.#sessions.listAllMessages(sessionId)
    const userText = firstUserText(messages)
    if (!userText) return
    const assistantText = firstAssistantText(messages)

    const route = await this.#resolveRoute(
      this.#configStore.getPublicConfig(),
      record,
      completedRunRoute,
    ).catch(() => undefined)
    if (!route || this.#disposed) return

    const prompt = this.#prompts.titlingPrompt(
      this.#configStore.getPublicConfig().assistant.language,
    )
    const provider = this.#createProvider(route)
    const raw = await this.#requestTitle(
      provider,
      route,
      prompt.content,
      userText,
      assistantText,
      sessionId,
      runId,
    )
    if (this.#disposed || raw === undefined) return

    const title = sanitizeModelTitle(raw)
    if (!title) return
    await this.#sessions.applyModelTitle({ sessionId, title })
  }

  /** Runs the bounded single-shot titling request; undefined on any failure. */
  async #requestTitle(
    provider: ModelProvider,
    route: ResolvedModelRoute,
    rules: string,
    userText: string,
    assistantText: string,
    parentSessionId: SessionId,
    parentRunId: RunId,
  ): Promise<string | undefined> {
    const controller = new AbortController()
    let timedOut = false
    this.#controllers.add(controller)
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('Conversation titling timed out'))
    }, this.#timeoutMs)
    const attempt = this.#operationalLog
      ? new ProviderAttemptRecorder(this.#operationalLog, {
          operation: 'title',
          sessionId: parentSessionId,
          runId: parentRunId,
          providerCallId: `title:${parentRunId}`,
          providerId: route.snapshot.providerId,
          providerType: provider.providerType,
          model: route.snapshot.model,
          reasoning: route.snapshot.reasoning,
          endpoint: route.snapshot.endpoint,
          messageCount: 1,
          toolCount: 0,
        })
      : undefined
    try {
      const sessionId = 'titling:session' as SessionId
      const messages: MessageRecord[] = [
        {
          schemaVersion: 1,
          id: 'titling:user' as MessageId,
          sessionId,
          seq: 1,
          visibility: 'visible',
          turnId: 'titling:user' as MessageId,
          inHistory: true,
          createdAt: new Date().toISOString(),
          kind: 'user_input',
          clientRequestId: 'titling-request',
          parts: [
            {
              type: 'text',
              text: titlingRequestText(rules, userText, assistantText),
            },
          ],
          metadata: {
            schemaVersion: 1,
            submission: { type: 'message' },
          },
        },
      ]
      const compiled = provider.compile({
        history: {
          sessionId,
          messages,
          sourceHash: canonicalHash(messages),
        },
        route: route.snapshot,
        tools: [],
        maxOutputTokens: TITLING_MAX_OUTPUT_TOKENS,
      })
      attempt?.attachRequestDiagnostics(providerRequestDiagnostics(compiled))
      const context: ProviderStreamContext = { signal: controller.signal }
      let text = ''
      let completed = false
      let completedEvent:
        | Extract<ProviderEvent, { type: 'completed' }>
        | undefined
      let removeAbortListener: () => void = () => undefined
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () =>
          reject(
            controller.signal.reason ??
              new Error('Conversation title request aborted'),
          )
        removeAbortListener = () =>
          controller.signal.removeEventListener('abort', abort)
        controller.signal.addEventListener('abort', abort, { once: true })
      })
      const consume = async () => {
        for await (const event of provider.stream(compiled, context)) {
          if (event.type === 'text.delta') {
            text += event.delta
          } else if (event.type === 'completed') {
            if (completed) {
              throw new Error('Titling provider produced multiple completions')
            }
            completed = true
            completedEvent = event
            text = event.turn.parts
              .flatMap((part) => (part.type === 'text' ? [part.text] : []))
              .join('\n')
          }
        }
      }
      await Promise.race([consume(), aborted]).finally(removeAbortListener)
      if (!completed) {
        throw new Error('Titling provider stream ended without completion')
      }
      attempt?.completed(
        completedEvent
          ? {
              durationMs: completedEvent.timing.totalMs,
              ttftMs: completedEvent.timing.ttftMs,
              responseBytes: completedEvent.timing.responseBytes,
              usage: completedEvent.turn.usage,
            }
          : {},
      )
      return text
    } catch (error) {
      if (controller.signal.aborted && !timedOut && this.#disposed) {
        attempt?.completed({ outcome: 'cancelled' })
        return undefined
      }
      const transport = titleTransportError(error)
      attempt?.failed(error, {
        code: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_TITLE_FAILED',
        ...(transport?.status === undefined
          ? {}
          : { httpStatus: transport.status }),
        ...(transport?.providerErrorCode
          ? { providerErrorCode: transport.providerErrorCode }
          : {}),
        ...(transport?.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: transport.retryAfterMs }),
        ...(transport?.requestId ? { requestId: transport.requestId } : {}),
        ...(transport?.evidence
          ? { responseBytes: Buffer.byteLength(transport.evidence.content) }
          : {}),
      })
      this.#onDiagnostic?.('Conversation title request failed', error, {
        audience: 'internal',
      })
      return undefined
    } finally {
      clearTimeout(timer)
      this.#controllers.delete(controller)
    }
  }
}

function titleTransportError(
  error: unknown,
  depth = 0,
): ProviderTransportError | undefined {
  if (error instanceof ProviderTransportError) return error
  if (!error || typeof error !== 'object' || depth >= 3) return undefined
  return titleTransportError(Reflect.get(error, 'cause'), depth + 1)
}

function recordText(record: MessageRecord): string {
  return record.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .slice(0, TITLING_INPUT_MAX_CHARS)
}

/** Returns the first original visible user message text, bounded for prompt use. */
function firstUserText(messages: readonly MessageRecord[]): string {
  const record = messages.find(
    (message) =>
      message.visibility === 'visible' &&
      message.kind === 'user_input' &&
      'clientRequestId' in message,
  )
  return record ? recordText(record) : ''
}

/** Returns the first visible assistant reply text, bounded for prompt use. */
function firstAssistantText(messages: readonly MessageRecord[]): string {
  const record = messages.find(
    (message) =>
      message.visibility === 'visible' && message.kind === 'assistant_turn',
  )
  return record ? recordText(record) : ''
}
