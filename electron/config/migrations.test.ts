import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from './schema'
import { migrateConfig } from './migrations'

function legacyV9Config(): Record<string, unknown> {
  const current = structuredClone(DEFAULT_APP_CONFIG)
  return {
    ...current,
    schemaVersion: 9,
    providers: current.providers.map((provider) => {
      const legacy = { ...provider } as Record<string, unknown>
      Reflect.deleteProperty(legacy, 'providerType')
      return {
        ...legacy,
        protocol: 'openai-compatible',
        adapterId: 'deepseek.chat-completions',
        profile: 'deepseek',
      }
    }),
  }
}

describe('config v10 migration boundary', () => {
  it('creates the v10 defaults when no config exists', () => {
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
      ).toThrow(`schema ${schemaVersion}; this build requires AppConfig v10`)
    }
  })

  it('migrates and clones a valid v9 config', () => {
    const source = legacyV9Config()
    const migrated = migrateConfig(source)
    expect(migrated).toMatchObject({
      schemaVersion: 10,
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

  it('accepts and clones a valid v10 config', () => {
    const source = structuredClone(DEFAULT_APP_CONFIG)
    const migrated = migrateConfig(source)
    expect(migrated).toEqual(source)
    expect(migrated).not.toBe(source)
    expect(migrated.providers[0]).toMatchObject({
      providerType: 'deepseek.chat-completions',
      revision: 1,
    })
  })

  it('rejects malformed v10 data instead of filling missing fields', () => {
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
