import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigStore } from '../config/store'

const { createAgentRuntimeMock, openDatabase } = vi.hoisted(() => ({
  createAgentRuntimeMock: vi.fn(),
  openDatabase: vi.fn(),
}))

vi.mock('../persistence/database-service', () => ({
  DatabaseService: { open: openDatabase },
}))

vi.mock('../runtime/create-agent-runtime', () => ({
  createAgentRuntime: createAgentRuntimeMock,
}))

import { createBackendRuntime } from './create-backend-runtime'

afterEach(() => {
  vi.clearAllMocks()
})

describe('createBackendRuntime startup cleanup', () => {
  it('preserves the startup failure when cleanup and diagnostics also fail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'zch-backend-cleanup-'))
    const startupFailure = new Error('provider initialization failed')
    const cleanupFailure = new Error('database close failed')
    const diagnosticFailure = new Error('diagnostic sink failed')
    const close = vi.fn(() => {
      throw cleanupFailure
    })
    const onDiagnostic = vi.fn(() => {
      throw diagnosticFailure
    })
    openDatabase.mockReturnValue({ close })
    createAgentRuntimeMock.mockRejectedValue(startupFailure)

    try {
      await expect(
        createBackendRuntime({
          configStore: {} as ConfigStore,
          promptDirectory: path.join(root, 'prompts'),
          databasePath: path.join(root, 'data', 'agent.db'),
          runtimeDataDirectory: path.join(root, 'runtime'),
          onDiagnostic,
        }),
      ).rejects.toBe(startupFailure)
      expect(close).toHaveBeenCalledOnce()
      expect(onDiagnostic).toHaveBeenCalledWith(
        'Backend startup cleanup failed',
        cleanupFailure,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
