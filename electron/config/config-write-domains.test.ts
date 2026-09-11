import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigSetRequestSchema } from '../../shared/config'
import { compileSchema } from '../schema-validator'
import { SecretStore } from './secret-store'
import { ConfigStore } from './store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('configuration write ownership', () => {
  it('keeps limits unchanged across Provider and credential updates and rejects cross-domain IPC fields', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'zch-config-domains-'),
    )
    directories.push(directory)
    const store = new ConfigStore(
      path.join(directory, 'config.json'),
      new SecretStore(path.join(directory, 'secrets.json'), {
        platform: 'win32',
        isAsyncEncryptionAvailable: async () => true,
        getSelectedStorageBackend: () => 'test',
        encryptStringAsync: async (value) => Buffer.from(value),
        decryptStringAsync: async (value) => ({
          result: value.toString(),
          shouldReEncrypt: false,
        }),
      }),
    )
    await store.initialize()
    const limits = {
      ...store.getPublicConfig().limits,
      maxContextTokens: 333_333,
    }
    await store.update({ version: 1, kind: 'limits', value: limits })
    const request = {
      version: 1 as const,
      kind: 'provider-settings' as const,
      providerId: 'isolated-provider',
      providerType: 'generic.responses' as const,
      label: 'Isolated',
      baseURL: 'https://provider.example/v1',
      model: 'model-a',
    }
    const validate = compileSchema(ConfigSetRequestSchema)
    expect(validate(request)).toBe(true)
    expect(
      validate({ ...request, limits: { ...limits, maxContextTokens: 10_000 } }),
    ).toBe(false)
    await store.update(request)
    await store.update({
      ...request,
      label: 'Renamed',
      apiKey: 'synthetic-test-key',
    })
    expect(store.getPublicConfig().limits).toEqual(limits)
    await store.reloadFromDisk()
    expect(store.getPublicConfig().limits).toEqual(limits)
  })
})
