import { describe, expect, it } from 'vitest'
import legacyAppConfigV9 from './fixtures/app-config-v9.json'
import { DEFAULT_APP_CONFIG, type AppConfig } from './schema'
import { migrateConfig } from './migrations'

function legacyV9Config(): Record<string, unknown> {
  return structuredClone(legacyAppConfigV9) as Record<string, unknown>
}

describe('config v11 migration boundary', () => {
  it('creates the v11 defaults when no config exists', () => {
    expect(migrateConfig(undefined)).toEqual(DEFAULT_APP_CONFIG)
    expect(migrateConfig(undefined)).not.toBe(DEFAULT_APP_CONFIG)
  })

  it('rejects every legacy schema with reset guidance', () => {
    for (const schemaVersion of [0, 1, 7, 8]) {
      expect(() =>
        migrateConfig({
          ...structuredClone(DEFAULT_APP_CONFIG),
          schemaVersion,
        }),
      ).toThrow(`schema ${schemaVersion}; this build requires AppConfig v11`)
    }
  })

  it('migrates and clones a valid v9 config', () => {
    const source = legacyV9Config()
    const migrated = migrateConfig(source)
    expect(migrated).toMatchObject({
      schemaVersion: 11,
      providers: [
        {
          providerType: 'deepseek.chat-completions',
          revision: 1,
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
  })

  it('rejects malformed v9 data instead of adapting the current defaults', () => {
    const malformed = legacyV9Config()
    delete malformed.limits

    expect(() => migrateConfig(malformed)).toThrow(
      "must have required property 'limits'",
    )
  })

  it('migrates v10 defaults to the enlarged read and tool budgets', () => {
    const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
      string,
      unknown
    >
    source.schemaVersion = 10
    source.limits = {
      ...(source.limits as Record<string, unknown>),
      maxToolOutputBytes: 64 * 1_024,
      maxToolResultTokens: 8_000,
      maxToolTokensPerRun: 24_000,
      readFileOutputBytes: 64 * 1_024,
    }

    expect(migrateConfig(source)).toMatchObject({
      schemaVersion: 11,
      limits: {
        maxToolOutputBytes: 128 * 1_024,
        maxToolResultTokens: 64_000,
        maxToolTokensPerRun: 128_000,
        readFileOutputBytes: 128 * 1_024,
      },
    })
  })

  it('preserves customized v10 budgets', () => {
    const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
      string,
      unknown
    >
    source.schemaVersion = 10
    source.limits = {
      ...(source.limits as Record<string, unknown>),
      maxToolOutputBytes: 72_000,
      maxToolResultTokens: 12_000,
      maxToolTokensPerRun: 36_000,
      readFileOutputBytes: 80_000,
    }

    expect(migrateConfig(source)).toMatchObject({
      schemaVersion: 11,
      limits: {
        maxToolOutputBytes: 72_000,
        maxToolResultTokens: 12_000,
        maxToolTokensPerRun: 36_000,
        readFileOutputBytes: 80_000,
      },
    })
  })

  it('accepts and clones a valid v11 config', () => {
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

      expect(migrated.schemaVersion).toBe(11)
      expect(migrated.providers[0].providerType).toBe(providerType)
    }
  })

  it('rejects malformed v11 data instead of filling missing fields', () => {
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
