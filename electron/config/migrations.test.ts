import { describe, expect, it } from 'vitest'
import { REASONING_EFFORTS } from '../../shared/config'
import legacyAppConfigV20 from './fixtures/app-config-v20.json'
import legacyAppConfigV21 from './fixtures/app-config-v21.json'
import legacyAppConfigV9 from './fixtures/app-config-v9.json'
import { DEFAULT_APP_CONFIG, type AppConfig } from './schema'
import { migrateConfig } from './migrations'

function legacyV9Config(): Record<string, unknown> {
  return structuredClone(legacyAppConfigV9) as Record<string, unknown>
}

/** Returns a mutable clone of the frozen production v20 boundary fixture. */
function legacyV20Config(): Record<string, unknown> {
  return structuredClone(legacyAppConfigV20) as Record<string, unknown>
}

/** Returns a mutable clone of the frozen production v21 boundary fixture. */
function legacyV21Config(): Record<string, unknown> {
  return structuredClone(legacyAppConfigV21) as Record<string, unknown>
}

/** Explodes the current DEFAULT models section into pre-v21 top-level fields. */
function legacyModelFields(source: Record<string, unknown>): void {
  source.logging = {
    enabled: false,
    retentionDays: 14,
    maxTotalBytes: 500_000_000,
  }
  const models = source.models as Record<string, unknown>
  const providers = models.providers as Array<Record<string, unknown>>
  for (const provider of providers) {
    provider.reasoning = models.defaultModelReasoning ?? 'high'
  }
  source.activeProviderId = models.defaultModelProvider
  source.providers = providers
  source.approval = {
    approverProviderId:
      models.auxiliaryModelProvider || models.defaultModelProvider,
    approverModel: models.auxiliaryModel,
    reasoning: 'high',
  }
  source.modelPool = models.modelPool
  delete source.models
}

function removeApprovalReasoning(source: Record<string, unknown>): void {
  delete (source.approval as Record<string, unknown>).reasoning
}

function removeMaxAgentsPerSwarm(source: Record<string, unknown>): void {
  delete (source.subagents as Record<string, unknown>).maxAgentsPerSwarm
}

function removeExecutionEnvironment(source: Record<string, unknown>): void {
  delete source.executionEnvironment
}

function legacyCurrentShapeConfig(
  schemaVersion: 10 | 11,
): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  legacyModelFields(source)
  source.schemaVersion = schemaVersion
  removeExecutionEnvironment(source)
  removeApprovalReasoning(source)
  delete source.subagents
  delete source.modelPool
  ;(source.limits as Record<string, unknown>).maxToolTokensPerRun = 128_000
  for (const provider of source.providers as Array<Record<string, unknown>>) {
    provider.model = 'deepseek-v4-pro'
    delete provider.enabledModelIds
  }
  return source
}

function legacyV12Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  legacyModelFields(source)
  source.schemaVersion = 12
  removeExecutionEnvironment(source)
  removeApprovalReasoning(source)
  delete source.subagents
  delete source.modelPool
  ;(source.limits as Record<string, unknown>).maxToolTokensPerRun = 128_000
  for (const provider of source.providers as Array<Record<string, unknown>>) {
    provider.model = 'deepseek-v4-pro'
    provider.modelConfigurationIds = ['deepseek-v4-pro']
    delete provider.enabledModelIds
  }
  return source
}

function legacyV13Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  legacyModelFields(source)
  source.schemaVersion = 13
  removeExecutionEnvironment(source)
  removeApprovalReasoning(source)
  removeMaxAgentsPerSwarm(source)
  delete source.modelPool
  ;(source.limits as Record<string, unknown>).maxToolTokensPerRun = 128_000
  for (const provider of source.providers as Array<Record<string, unknown>>) {
    provider.model = 'deepseek-v4-pro'
    provider.modelConfigurationIds = ['deepseek-v4-pro']
    delete provider.enabledModelIds
  }
  return source
}

function legacyV14Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  legacyModelFields(source)
  source.schemaVersion = 14
  removeExecutionEnvironment(source)
  removeApprovalReasoning(source)
  removeMaxAgentsPerSwarm(source)
  delete source.modelPool
  for (const provider of source.providers as Array<Record<string, unknown>>) {
    provider.model = 'deepseek-v4-pro'
    provider.modelConfigurationIds = ['deepseek-v4-pro']
    delete provider.enabledModelIds
  }
  return source
}

function legacyV15Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  legacyModelFields(source)
  source.schemaVersion = 15
  removeExecutionEnvironment(source)
  removeApprovalReasoning(source)
  removeMaxAgentsPerSwarm(source)
  delete source.modelPool
  return source
}

function legacyV16Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  legacyModelFields(source)
  source.schemaVersion = 16
  removeExecutionEnvironment(source)
  removeApprovalReasoning(source)
  removeMaxAgentsPerSwarm(source)
  return source
}

function legacyV17Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  legacyModelFields(source)
  source.schemaVersion = 17
  removeExecutionEnvironment(source)
  removeMaxAgentsPerSwarm(source)
  return source
}

function legacyV18Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  legacyModelFields(source)
  source.schemaVersion = 18
  removeExecutionEnvironment(source)
  removeMaxAgentsPerSwarm(source)
  return source
}

function legacyV19Config(): Record<string, unknown> {
  const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
    string,
    unknown
  >
  legacyModelFields(source)
  source.schemaVersion = 19
  removeExecutionEnvironment(source)
  return source
}

describe('config v23 migration boundary', () => {
  it('creates the v23 defaults when no config exists', () => {
    expect(migrateConfig(undefined)).toEqual(DEFAULT_APP_CONFIG)
    expect(migrateConfig(undefined)).not.toBe(DEFAULT_APP_CONFIG)
    expect(migrateConfig(undefined).limits.maxConcurrentRuns).toBe(16)
    expect(migrateConfig(undefined).models.modelPool).toEqual({ entries: [] })
  })

  it('moves v22 trace settings into the split logging configuration', () => {
    const source = structuredClone(DEFAULT_APP_CONFIG) as unknown as Record<
      string,
      unknown
    >
    source.schemaVersion = 22
    source.logging = {
      enabled: true,
      retentionDays: 31,
      maxTotalBytes: 321_000_000,
    }

    expect(migrateConfig(source)).toMatchObject({
      schemaVersion: 23,
      logging: {
        operational: {
          level: 'info',
          retentionDays: 14,
          maxTotalBytes: 50_000_000,
        },
        trace: {
          enabled: true,
          retentionDays: 31,
          maxTotalBytes: 321_000_000,
        },
      },
    })
  })

  it('rejects every legacy schema with reset guidance', () => {
    for (const schemaVersion of [0, 1, 7, 8]) {
      expect(() =>
        migrateConfig({
          ...structuredClone(DEFAULT_APP_CONFIG),
          schemaVersion,
        }),
      ).toThrow(`schema ${schemaVersion}; this build requires AppConfig v23`)
    }
  })

  it('migrates v16 model pool state and makes approval reasoning explicit', () => {
    const source = legacyV16Config()
    ;(source.providers as Array<Record<string, unknown>>)[0]!.reasoning = 'off'
    source.modelPool = {
      entries: [
        {
          id: ' worker ',
          enabled: false,
          providerId: 'deepseek',
          model: 'worker-model',
          reasoning: 'high',
          capability: 'standard',
          maxParallel: 3,
        },
      ],
    }

    expect(migrateConfig(source)).toMatchObject({
      schemaVersion: 23,
      models: {
        auxiliaryModelProvider: '',
        auxiliaryModel: '',
        modelPool: {
          entries: [{ id: 'worker', model: 'worker-model' }],
        },
      },
    })
    expect(
      migrateConfig(source).models.modelPool.entries[0],
    ).not.toHaveProperty('capability')
    expect(
      migrateConfig(source).models.modelPool.entries[0],
    ).not.toHaveProperty('maxParallel')
  })

  it('migrates v17 pool entries without retaining duplicated capability', () => {
    const source = legacyV17Config()
    source.modelPool = {
      entries: [
        {
          id: ' worker ',
          enabled: false,
          providerId: 'deepseek',
          model: 'worker-model',
          reasoning: 'xhigh',
          capability: 'strong',
          maxParallel: 5,
        },
      ],
    }

    const migrated = migrateConfig(source)

    expect(migrated).toMatchObject({
      schemaVersion: 23,
      models: {
        modelPool: {
          entries: [
            {
              id: 'worker',
              model: 'worker-model',
              reasoning: 'xhigh',
            },
          ],
        },
      },
    })
    expect(migrated.models.modelPool.entries[0]).not.toHaveProperty(
      'capability',
    )
    expect(migrated.models.modelPool.entries[0]).not.toHaveProperty(
      'maxParallel',
    )
  })

  it('keeps the v16 Provider and model pool reasoning boundary frozen', () => {
    const providerReasoning = legacyV16Config()
    ;(
      providerReasoning.providers as Array<Record<string, unknown>>
    )[0]!.reasoning = 'low'
    expect(() => migrateConfig(providerReasoning)).toThrow()

    const providerAnnotation = legacyV16Config()
    ;(
      providerAnnotation.providers as Array<Record<string, unknown>>
    )[0]!.modelOverrides = {
      'worker-model': { reasoningEfforts: ['high'] },
    }
    expect(() => migrateConfig(providerAnnotation)).toThrow()

    const poolReasoning = legacyV16Config()
    poolReasoning.modelPool = {
      entries: [
        {
          id: 'worker',
          enabled: false,
          providerId: 'deepseek',
          model: 'worker-model',
          reasoning: 'xhigh',
          capability: 'standard',
          maxParallel: 1,
        },
      ],
    }
    expect(() => migrateConfig(poolReasoning)).toThrow()
  })

  it('accepts all six reasoning efforts in a current model pool', () => {
    const source = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
    source.models.modelPool.entries = REASONING_EFFORTS.map(
      (reasoning, index) => ({
        id: `worker-${index}`,
        enabled: false,
        providerId: 'deepseek',
        model: `worker-model-${index}`,
        reasoning,
      }),
    )

    expect(migrateConfig(source).models.modelPool).toEqual(
      source.models.modelPool,
    )
  })

  it('migrates and clones a valid v9 config', () => {
    const source = legacyV9Config()
    const migrated = migrateConfig(source)
    expect(migrated).toMatchObject({
      schemaVersion: 23,
      models: {
        modelPool: { entries: [] },
        providers: [
          {
            providerType: 'deepseek.chat-completions',
            revision: 1,
            enabledModelIds: ['deepseek-v4-pro'],
          },
        ],
      },
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

    expect(() => migrateConfig(malformed)).toThrow('/limits is required')
  })

  it('rejects v9 configs carrying reasoning values introduced after v9', () => {
    const source = legacyV9Config()
    ;(source.providers as Array<Record<string, unknown>>)[0]!.reasoning = 'low'

    expect(() => migrateConfig(source)).toThrow()
  })

  it('rejects v14 configs carrying per-model annotations introduced after v14', () => {
    const source = legacyV14Config()
    ;(source.providers as Array<Record<string, unknown>>)[0]!.modelOverrides = {
      'deepseek-v4-pro': { reasoningEfforts: ['low'] },
    }

    expect(() => migrateConfig(source)).toThrow()
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
      schemaVersion: 23,
      models: { modelPool: { entries: [] } },
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
      schemaVersion: 23,
      models: { modelPool: { entries: [] } },
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
      schemaVersion: 23,
      models: {
        modelPool: { entries: [] },
        providers: [
          {
            model: 'deepseek-v4-pro',
            enabledModelIds: ['deepseek-v4-pro'],
          },
        ],
      },
    })
  })

  it('migrates v12 with subagent defaults and preserves concurrency', () => {
    const source = legacyV12Config()
    ;(source.limits as Record<string, unknown>).maxConcurrentRuns = 7
    const migrated = migrateConfig(source)

    expect(migrated).toMatchObject({
      schemaVersion: 23,
      models: { modelPool: { entries: [] } },
      limits: { maxConcurrentRuns: 7 },
      subagents: {
        enabled: false,
        workerTimeoutMs: 1_800_000,
        maxAgentsPerSwarm: 10,
      },
    })
  })

  it('migrates v13 and drops the retired run-wide Tool Result budget', () => {
    const source = legacyV13Config()
    const migrated = migrateConfig(source)

    expect(migrated.schemaVersion).toBe(23)
    expect(migrated.models.modelPool).toEqual({ entries: [] })
    expect(migrated.limits).not.toHaveProperty('maxToolTokensPerRun')
    expect((source.limits as Record<string, unknown>).maxToolTokensPerRun).toBe(
      128_000,
    )
  })

  it('migrates v14 model configuration selections into the enabled pool', () => {
    const migrated = migrateConfig(legacyV14Config())

    expect(migrated).toMatchObject({
      schemaVersion: 23,
      models: {
        modelPool: { entries: [] },
        providers: [
          {
            model: 'deepseek-v4-pro',
            enabledModelIds: ['deepseek-v4-pro'],
          },
        ],
      },
    })
  })

  it('maps the legacy approval route into auxiliary model roles when migrating v15', () => {
    const source = legacyV15Config()
    source.approval = {
      approverProviderId: 'deepseek',
      approverModel: 'deepseek-v4-lite',
    }

    const migrated = migrateConfig(source)
    expect(migrated.models).toMatchObject({
      defaultModelProvider: 'deepseek',
      auxiliaryModelProvider: 'deepseek',
      auxiliaryModel: 'deepseek-v4-lite',
    })
    expect(migrated).not.toHaveProperty('approval')
    expect(migrated).not.toHaveProperty('activeProviderId')
  })

  it('migrates and clones a valid frozen v15 config', () => {
    const source = legacyV15Config()
    const provider = (source.providers as Array<Record<string, unknown>>)[0]!
    provider.revision = 9
    provider.apiKeyRef = 'provider-key:preserved'
    ;(source.limits as Record<string, unknown>).maxConcurrentRuns = 7
    const migrated = migrateConfig(source)

    expect(migrated).toMatchObject({
      schemaVersion: 23,
      models: { modelPool: { entries: [] } },
      limits: { maxConcurrentRuns: 7 },
    })
    expect(migrated).not.toBe(source)
    expect(migrated.models.providers[0]).toMatchObject({
      providerType: 'deepseek.chat-completions',
      revision: 9,
      apiKeyRef: 'provider-key:preserved',
    })
  })

  it('migrates v18 by removing route concurrency and adding the Swarm bound', () => {
    const source = legacyV18Config()
    source.modelPool = {
      entries: [
        {
          id: ' worker ',
          enabled: false,
          providerId: 'deepseek',
          model: 'worker-model',
          reasoning: 'max',
          maxParallel: 7,
        },
      ],
    }

    const migrated = migrateConfig(source)

    expect(migrated).toMatchObject({
      schemaVersion: 23,
      subagents: { maxAgentsPerSwarm: 10 },
      models: {
        modelPool: {
          entries: [{ id: 'worker', reasoning: 'max' }],
        },
      },
    })
    expect(migrated.models.modelPool.entries[0]).not.toHaveProperty(
      'maxParallel',
    )
  })

  it('migrates v19 by adding the automatic command Shell selection', () => {
    const source = legacyV19Config()
    const migrated = migrateConfig(source)

    expect(migrated).toMatchObject({
      schemaVersion: 23,
      executionEnvironment: { commandShell: 'auto' },
    })
    expect(source).not.toHaveProperty('executionEnvironment')
  })

  it('migrates the frozen v20 model roles, pool, credential, and Shell', () => {
    const source = legacyV20Config()
    const migrated = migrateConfig(source)

    expect(migrated).toMatchObject({
      schemaVersion: 23,
      executionEnvironment: { commandShell: 'windows-powershell' },
      models: {
        defaultModelProvider: 'deepseek',
        defaultModel: 'fixture-main',
        defaultModelReasoning: 'high',
        auxiliaryModelProvider: 'deepseek',
        auxiliaryModel: 'fixture-aux',
        auxiliaryModelReasoning: 'high',
        providers: [
          {
            id: 'deepseek',
            apiKeyRef: 'provider-key:fixture',
          },
        ],
        modelPool: {
          entries: [
            {
              id: 'fixture-worker',
              providerId: 'deepseek',
              model: 'fixture-worker',
              reasoning: 'low',
            },
          ],
        },
      },
    })
    expect(migrated).not.toHaveProperty('activeProviderId')
    expect(migrated).not.toHaveProperty('approval')
    expect(migrated).not.toHaveProperty('providers')
    expect(migrated).not.toHaveProperty('modelPool')
    expect(source).toMatchObject({
      schemaVersion: 20,
      approval: { reasoning: 'xhigh' },
    })
  })

  it('moves each v21 Provider reasoning effort onto its exact model role', () => {
    const source = legacyV21Config()
    const migrated = migrateConfig(source)

    expect(migrated).toMatchObject({
      schemaVersion: 23,
      models: {
        defaultModelProvider: 'deepseek',
        defaultModel: 'fixture-main',
        defaultModelReasoning: 'max',
        auxiliaryModelProvider: 'auxiliary',
        auxiliaryModel: 'fixture-aux',
        auxiliaryModelReasoning: 'low',
        providers: [
          { id: 'deepseek', apiKeyRef: 'provider-key:main' },
          { id: 'auxiliary', apiKeyRef: 'provider-key:auxiliary' },
        ],
        modelPool: {
          entries: [{ id: 'fixture-worker', reasoning: 'high' }],
        },
      },
    })
    for (const provider of migrated.models.providers) {
      expect(provider).not.toHaveProperty('reasoning')
    }
    expect(source).toMatchObject({
      schemaVersion: 21,
      models: {
        providers: [{ reasoning: 'max' }, { reasoning: 'low' }],
      },
    })
  })

  it('rejects malformed v21 data instead of inventing role reasoning', () => {
    const malformed = legacyV21Config()
    const models = malformed.models as Record<string, unknown>
    const providers = models.providers as Array<Record<string, unknown>>
    delete providers[0]?.reasoning

    expect(() => migrateConfig(malformed)).toThrow(
      '/models/providers/0/reasoning is required',
    )
  })

  it('accepts the new Provider Types without a schema-version migration', () => {
    for (const providerType of [
      'generic.responses',
      'generic.anthropic',
    ] as const) {
      const source = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
      source.models.providers[0].providerType = providerType
      const migrated = migrateConfig(source)

      expect(migrated.schemaVersion).toBe(23)
      expect(migrated.models.providers[0].providerType).toBe(providerType)
    }
  })

  it('rejects malformed v20 data instead of filling missing fields', () => {
    const malformed = legacyV20Config()
    delete malformed.executionEnvironment
    expect(() => migrateConfig(malformed)).toThrow(
      '/executionEnvironment is required',
    )
  })

  it('rejects model pool IDs that collide after trim and NFC normalization', () => {
    const malformed = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
    malformed.models.modelPool.entries = [
      {
        id: ' é ',
        enabled: false,
        providerId: 'missing-one',
        model: 'preserved-one',
        reasoning: 'off',
      },
      {
        id: 'e\u0301',
        enabled: false,
        providerId: 'missing-two',
        model: 'preserved-two',
        reasoning: 'max',
      },
    ]

    expect(() => migrateConfig(malformed)).toThrow(
      'Duplicate model pool entry id',
    )
  })

  it('rejects model pool IDs containing control or format characters', () => {
    const malformed = structuredClone(DEFAULT_APP_CONFIG) as AppConfig
    malformed.models.modelPool.entries = [
      {
        id: 'hidden\u200bentry',
        enabled: false,
        providerId: 'missing',
        model: 'preserved',
        reasoning: 'high',
      },
    ]

    expect(() => migrateConfig(malformed)).toThrow(
      'control or format character',
    )
  })
})
