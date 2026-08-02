import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PROVIDER_NOTICE_VERSION,
  TRACE_NOTICE_VERSION,
  YOLO_NOTICE_VERSION,
} from '../../shared/notices'
import { compileSchema, formatSchemaErrors } from '../schema-validator'
import { ConfigStore } from '../config/store'
import { DEFAULT_APP_CONFIG, type AppConfig } from '../config/schema'
import { writeJsonAtomic } from '../config/atomic-file'
import { SecretStore, type SafeStorageAdapter } from '../config/secret-store'
import {
  HeadlessConfigSchema,
  LegacyHeadlessConfigV1Schema,
  LegacyHeadlessConfigV2Schema,
  LegacyHeadlessConfigV3Schema,
  type HeadlessConfig,
  type LegacyHeadlessConfigV1,
  type LegacyHeadlessConfigV2,
  type LegacyHeadlessConfigV3,
} from './contracts'

const MAX_HEADLESS_CONFIG_BYTES = 1_048_576
const validateHeadlessConfig = compileSchema(HeadlessConfigSchema)
const validateLegacyHeadlessConfig = compileSchema(LegacyHeadlessConfigV1Schema)
const validateLegacyHeadlessConfigV2 = compileSchema(
  LegacyHeadlessConfigV2Schema,
)
const validateLegacyHeadlessConfigV3 = compileSchema(
  LegacyHeadlessConfigV3Schema,
)

/** Provides a no-persistence SafeStorageAdapter for headless environment credentials. */
class HeadlessSecretStorageAdapter implements SafeStorageAdapter {
  readonly platform = process.platform

  /** Reports that headless mode never persists secrets through safe storage. */
  async isAsyncEncryptionAvailable(): Promise<boolean> {
    return false
  }

  /** Identifies the environment-backed headless credential source. */
  getSelectedStorageBackend(): string {
    return 'headless-environment'
  }

  /** Rejects encryption because headless mode does not persist credentials. */
  async encryptStringAsync(): Promise<Buffer> {
    throw new Error('Headless secret persistence is disabled')
  }

  /** Rejects decryption because headless mode does not persist credentials. */
  async decryptStringAsync(): Promise<{
    result: string
    shouldReEncrypt: boolean
  }> {
    throw new Error('Headless secret persistence is disabled')
  }
}

/** Reports malformed or unsupported headless configuration. */
export class HeadlessConfigError extends Error {
  readonly code = 'HEADLESS_CONFIG_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'HeadlessConfigError'
  }
}

export interface PreparedHeadlessConfig {
  config: HeadlessConfig
  configHash: string
  configStore: ConfigStore
  userDataDirectory: string
}

/** Reads and validates the headless configuration JSON from disk. */
export async function loadHeadlessConfig(
  filePath: string,
): Promise<HeadlessConfig> {
  let raw: Buffer
  try {
    raw = await readFile(filePath)
  } catch {
    throw new HeadlessConfigError('Unable to read headless config')
  }
  if (raw.byteLength > MAX_HEADLESS_CONFIG_BYTES) {
    throw new HeadlessConfigError('Headless config exceeds 1 MiB')
  }

  let candidate: unknown
  try {
    candidate = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new HeadlessConfigError('Headless config is not valid JSON')
  }
  return normalizeHeadlessConfig(candidate)
}

/** Combines headless config with artifact paths and environment-backed runtime settings. */
export async function prepareHeadlessConfig(input: {
  config: HeadlessConfig
  artifactsDirectory: string
  environment?: NodeJS.ProcessEnv
}): Promise<PreparedHeadlessConfig> {
  const config = normalizeHeadlessConfig(input.config)
  const environment = input.environment ?? process.env
  const credential = environment[config.provider.credentialEnv]?.trim()
  if (!credential) {
    throw new HeadlessConfigError(
      `Provider credential environment variable is missing: ${config.provider.credentialEnv}`,
    )
  }

  const userDataDirectory = path.join(input.artifactsDirectory, 'runtime')
  await mkdir(userDataDirectory, { recursive: true })
  const appConfig = buildAppConfig(config)
  const configHash = createHash('sha256')
    .update(JSON.stringify(canonicalize(config)))
    .digest('hex')
  const configPath = path.join(userDataDirectory, 'config.json')
  await writeJsonAtomic(configPath, appConfig)
  const secretStore = new SecretStore(
    path.join(userDataDirectory, 'secrets.json'),
    new HeadlessSecretStorageAdapter(),
  )
  const configStore = new ConfigStore(configPath, secretStore, {
    environmentApiKeys: { [appConfig.activeProviderId]: credential },
  })
  await configStore.initialize()

  return {
    config: structuredClone(config),
    configHash,
    configStore,
    userDataDirectory,
  }
}

function normalizeHeadlessConfig(candidate: unknown): HeadlessConfig {
  if (validateHeadlessConfig(candidate)) {
    return structuredClone(candidate) as HeadlessConfig
  }
  if (validateLegacyHeadlessConfigV3(candidate)) {
    const legacy = structuredClone(candidate) as LegacyHeadlessConfigV3
    return {
      ...legacy,
      schemaVersion: 4,
      ...(legacy.limits ? { limits: withoutRunToolBudget(legacy.limits) } : {}),
    }
  }
  if (validateLegacyHeadlessConfigV2(candidate)) {
    const legacy = structuredClone(candidate) as LegacyHeadlessConfigV2
    return {
      ...legacy,
      schemaVersion: 4,
      ...(legacy.limits ? { limits: withoutRunToolBudget(legacy.limits) } : {}),
    }
  }
  if (validateLegacyHeadlessConfig(candidate)) {
    const legacy = structuredClone(candidate) as LegacyHeadlessConfigV1
    return {
      ...legacy,
      schemaVersion: 4,
      ...(legacy.limits ? { limits: withoutRunToolBudget(legacy.limits) } : {}),
      provider: {
        id: legacy.provider.id,
        ...(legacy.provider.label ? { label: legacy.provider.label } : {}),
        providerType:
          legacy.provider.profile === 'deepseek'
            ? 'deepseek.chat-completions'
            : 'generic.chat-completions',
        baseURL: legacy.provider.baseURL,
        model: legacy.provider.model,
        ...(legacy.provider.reasoning
          ? { reasoning: legacy.provider.reasoning }
          : {}),
        credentialEnv: legacy.provider.credentialEnv,
      },
    }
  }
  throw new HeadlessConfigError(
    formatSchemaErrors(validateHeadlessConfig.errors),
  )
}

/** Removes the retired lifetime Tool Result budget from a legacy config. */
function withoutRunToolBudget<Limits extends Record<string, unknown>>(
  limits: Limits,
): Omit<Limits, 'maxToolTokensPerRun'> {
  const migrated = { ...limits }
  Reflect.deleteProperty(migrated, 'maxToolTokensPerRun')
  return migrated
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  )
}

function buildAppConfig(config: HeadlessConfig): AppConfig {
  const now = new Date().toISOString()
  const defaults = structuredClone(DEFAULT_APP_CONFIG)
  const providerId = config.provider.id
  return {
    ...defaults,
    activeProviderId: providerId,
    providers: [
      {
        id: providerId,
        label: config.provider.label ?? providerId,
        providerType: config.provider.providerType,
        revision: 1,
        baseURL: config.provider.baseURL,
        model: config.provider.model,
        reasoning: config.provider.reasoning ?? 'high',
        modelCatalog: [],
        modelOverrides: {},
        enabledModelIds: [config.provider.model],
      },
    ],
    approval: {
      approverProviderId: providerId,
      approverModel: config.provider.model,
    },
    permission: {
      ...defaults.permission,
      defaultMode: 'yolo',
      rememberedRules: [],
    },
    limits: { ...defaults.limits, ...config.limits },
    subagents: { ...defaults.subagents, ...config.subagents },
    logging: { ...defaults.logging, enabled: true },
    privacy: {
      ...defaults.privacy,
      providerNoticeAccepted: {
        version: PROVIDER_NOTICE_VERSION,
        acceptedAt: now,
      },
      traceNoticeAccepted: { version: TRACE_NOTICE_VERSION, acceptedAt: now },
      yoloNoticeAccepted: { version: YOLO_NOTICE_VERSION, acceptedAt: now },
    },
    skills: { ...defaults.skills, ...config.skills },
    assistant: { ...defaults.assistant, ...config.assistant },
    network: config.network ?? defaults.network,
    mcpServers: structuredClone(config.mcpServers ?? []),
  }
}
