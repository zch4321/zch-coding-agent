import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG } from './schema'
import { migrateConfig } from './migrations'

describe('config v9 reset boundary', () => {
  it('creates the v9 defaults when no config exists', () => {
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
      ).toThrow('P3 requires AppConfig v9')
    }
  })

  it('accepts and clones a valid v9 config', () => {
    const source = structuredClone(DEFAULT_APP_CONFIG)
    const migrated = migrateConfig(source)
    expect(migrated).toEqual(source)
    expect(migrated).not.toBe(source)
    expect(migrated.providers[0]).toMatchObject({
      adapterId: 'deepseek.chat-completions',
      revision: 1,
    })
  })

  it('rejects malformed v9 data instead of filling missing fields', () => {
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
