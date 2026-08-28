import type {
  BackgroundCancelInput,
  BackgroundListInput,
  BackgroundTaskPort,
  BackgroundWaitInput,
} from './contracts'
import type { JsonValue } from '../../shared/json'
import type { SessionId } from '../../shared/ids'

/** Breaks runtime construction cycles until durable background services are bound. */
export class BackgroundTaskBridge implements BackgroundTaskPort {
  #target: BackgroundTaskPort | undefined

  /** Binds the production background implementation once. */
  bind(target: BackgroundTaskPort): void {
    if (this.#target && this.#target !== target) {
      throw new Error('Background task bridge is already bound')
    }
    this.#target = target
  }

  /** Delegates a bounded wait to the bound background service. */
  wait(input: BackgroundWaitInput): Promise<JsonValue> {
    return this.#requireTarget().wait(input)
  }

  /** Delegates filtered task discovery to the bound background service. */
  list(input: BackgroundListInput): Promise<JsonValue> {
    return this.#requireTarget().list(input)
  }

  /** Delegates one owned target cancellation to the bound service. */
  cancel(input: BackgroundCancelInput): Promise<JsonValue> {
    return this.#requireTarget().cancel(input)
  }

  /** Cancels every background task owned by one public Session. */
  cancelSession(parentSessionId: SessionId): Promise<void> {
    return this.#requireTarget().cancelSession(parentSessionId)
  }

  #requireTarget(): BackgroundTaskPort {
    if (!this.#target) throw new Error('Background task runtime is unavailable')
    return this.#target
  }
}
