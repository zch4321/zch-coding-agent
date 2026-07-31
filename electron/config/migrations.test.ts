import { describe, expect, it } from 'vitest'
import legacyAppConfigV9 from './fixtures/app-config-v9.json'
import { DEFAULT_APP_CONFIG, type AppConfig } from './schema'
import { migrateConfig } from './migrations'

function legacyV9Config(): Record<string, unknown> {
  return structuredClone(legacyAppConfigV9) as Record<string, unknown>
}

function legacyCurrentShapeConfig(
  schemaVersion: 10 | 11,
): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  source.schemaVersion = schemaVersion
  delete source.subagents
  ;(source.limits as Record<string, unknown>).maxToolTokensPerRun = 128_000
  for (const provider of source.providers as Array<Record<string, unknown>>) {
    delete provider.modelConfigurationIds
  }
  return source
}

function legacyV12Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  source.schemaVersion = 12
  delete source.subagents
  ;(source.limits as Record<string, unknown>).maxToolTokensPerRun = 128_000
  return source
}

function legacyV13Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  source.schemaVersion = 13
  ;(source.limits as Record<string, unknown>).maxToolTokensPerRun = 128_000
  return source
}

describe('config v14 migration boundary', () => {
  it('creates the v14 defaults when no config exists', () => {
    expect(migrateConfig(undefined)).toEqual(DEFAULT_APP_CONFIG)
    expect(migrateConfig(undefined)).not.toBe(DEFAULT_APP_CONFIG)
    expect(migrateConfig(undefined).limits.maxConcurrentRuns).toBe(16)
  })

  it('rejects every legacy schema with reset guidance', () => {
    for (const schemaVersion of [0, 1, 7, 8]) {
      expect(() =>
        migrateConfig({
          ...structuredClone(DEFAULT_APP_CONFIG),
          schemaVersion,
        }),
      ).toThrow(`schema ${schemaVersion}; this build requires AppConfig v14`)
    }
  })

  it('migrates and clones a valid v9 config', () => {
    const source = legacyV9Config()
    const migrated = migrateConfig(source)
    expect(migrated).toMatchObject({
      schemaVersion: 14,
      providers: [
        {
          providerType: 'deepseek.chat-completions',
          revision: 1,
          modelConfigurationIds: ['deepseek-v4-pro'],
        },
      ],
    })
    expect(migrated).not.toBe(source)
    expect(source.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adapterId: 'deepseek.chat-completions',
        }),
      ]),
    )
    expect(migrated.limits).not.toHaveProperty('maxToolTokensPerRun')
  })

  it('rejects malformed v9 data instead of adapting the current defaults', () => {
    const malformed = legacyV9Config()
    delete malformed.limits

    expect(() => migrateConfig(malformed)).toThrow(
      "must have required property 'limits'",
    )
  })

  it('migrates v10 defaults to the enlarged read and tool budgets', () => {
    const source = legacyCurrentShapeConfig(10)
    source.limits = {
      ...(source.limits as Record<string, unknown>),
      maxToolOutputBytes: 64 * 1_024,
      maxToolResultTokens: 8_000,
      maxToolTokensPerRun: 24_000,
      readFileOutputBytes: 64 * 1_024,
    }

    expect(migrateConfig(source)).toMatchObject({
      schemaVersion: 14,
      limits: {
        maxToolOutputBytes: 128 * 1_024,
        maxToolResultTokens: 64_000,
        readFileOutputBytes: 128 * 1_024,
      },
    })
    expect(migrateConfig(source).limits).not.toHaveProperty(
      'maxToolTokensPerRun',
    )
  })

  it('preserves customized v10 budgets', () => {
    const source = legacyCurrentShapeConfig(10)
    source.limits = {
      ...(source.limits as Record<string, unknown>),
      maxToolOutputBytes: 72_000,
      maxToolResultTokens: 12_000,
      maxToolTokensPerRun: 36_000,
      readFileOutputBytes: 80_000,
    }

    expect(migrateConfig(source)).toMatchObject({
      schemaVersion: 14,
      limits: {
        maxToolOutputBytes: 72_000,
        maxToolResultTokens: 12_000,
        readFileOutputBytes: 80_000,
      },
    })
    expect(migrateConfig(source).limits).not.toHaveProperty(
      'maxToolTokensPerRun',
    )
  })

  it('migrates v11 model configuration selections to the main model', () => {
    const source = legacyCurrentShapeConfig(11)
    const migrated = migrateConfig(source)

    expect(migrated).toMatchObject({
      schemaVersion: 14,
      providers: [
        {
          model: 'deepseek-v4-pro',
          modelConfigurationIds: ['deepseek-v4-pro'],
        },
      ],
    })
  })

  it('migrates v12 with subagent defaults and preserves concurrency', () => {
    const source = legacyV12Config()
    ;(source.limits as Record<string, unknown>).maxConcurrentRuns = 7
    const migrated = migrateConfig(source)

    expect(migrated).toMatchObject({
      schemaVersion: 14,
      limits: { maxConcurrentRuns: 7 },
      subagents: {
        enabled: false,
        workerTimeoutMs: 1_800_000,
      },
    })
  })

  it('migrates v13 and drops the retired run-wide Tool Result budget', () => {
    const source = legacyV13Config()
    const migrated = migrateConfig(source)

    expect(migrated.schemaVersion).toBe(14)
    expect(migrated.limits).not.toHaveProperty('maxToolTokensPerRun')
    expect((source.limits as Record<string, unknown>).maxToolTokensPerRun).toBe(
      128_000,
    )
  })

  it('accepts and clones a valid v14 config', () => {
    const source = structuredClone(DEFAULT_APP_CONFIG)
    const migrated = migrateConfig(source)
    expect(migrated).toEqual(source)
    expect(migrated).not.toBe(source)
    expect(migrated.providers[0]).toMatchObject({
      providerType: 'deepseek.chat-completions',
      revision: 1,
    })
  })

  it('accepts the new Provider Types without a schema-version migration', () => {
    for (const providerType of [
      'generic.responses',
      'generic.anthropic',
    ] as const) {
      const source = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
      source.providers[0].providerType = providerType
      const migrated = migrateConfig(source)

      expect(migrated.schemaVersion).toBe(14)
      expect(migrated.providers[0].providerType).toBe(providerType)
    }
  })

  it('rejects malformed v14 data instead of filling missing fields', () => {
    const malformed = structuredClone(DEFAULT_APP_CONFIG) as Record<
      string,
      unknown
    >
    delete malformed.providers
    expect(() => migrateConfig(malformed)).toThrow(
      "must have required property 'providers'",
    )
  })
})
