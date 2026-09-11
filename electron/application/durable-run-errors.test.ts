import { describe, expect, it, vi } from 'vitest'
import type { MessageId, SessionId } from '../../shared/ids'
import { sessionFault } from '../session/session-common'
import { DurableRunApplicationService } from './durable-run-application-service'

describe('durable retry failure semantics', () => {
  it.each(['load', 'start'] as const)(
    'preserves domain failure after rewind when %s fails',
    async (stage) => {
      const rewind = vi.fn().mockResolvedValue({ commit: {} })
      const fail = () =>
        sessionFault('PRECONDITION_FAILED', 'Credential required', {
          requiredVersion: 2,
        })
      const ensureLoaded = vi.fn(async () => {
        if (stage === 'load') fail()
      })
      const retryRun = vi.fn(fail)
      const service = new DurableRunApplicationService({
        sessions: {
          getOriginalVisibleUser: vi
            .fn()
            .mockResolvedValue({ id: 'message-1' }),
          rewind,
        },
        registry: { ensureLoaded },
        manager: { retryRun },
      } as unknown as ConstructorParameters<
        typeof DurableRunApplicationService
      >[0])
      const input = {
        version: 1 as const,
        sessionId: 'session-1' as SessionId,
        userMessageId: 'message-1' as MessageId,
        expectedRevision: 1,
        clientRequestId: 'retry-1',
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(service.retry(input)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
          message: 'Credential required',
          details: { requiredVersion: 2, mutationSucceeded: true },
        })
      }
      expect(rewind).toHaveBeenCalledTimes(2)
      expect(ensureLoaded).toHaveBeenCalledTimes(2)
      expect(retryRun).toHaveBeenCalledTimes(stage === 'start' ? 2 : 0)
    },
  )
})
