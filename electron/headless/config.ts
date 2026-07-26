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
import { HeadlessConfigSchema, type HeadlessConfig } from './contracts'

const MAX_HEADLESS_CONFIG_BYTES = 1_048_576
const validateHeadlessConfig = compileSchema(HeadlessConfigSchema)

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
  if (!validateHeadlessConfig(candidate)) {
    throw new HeadlessConfigError(
      formatSchemaErrors(validateHeadlessConfig.errors),
    )
  }
  return structuredClone(candidate) as HeadlessConfig
}

/** Combines headless config with artifact paths and environment-backed runtime settings. */
export async function prepareHeadlessConfig(input: {
  config: HeadlessConfig
  artifactsDirectory: string
  environment?: NodeJS.ProcessEnv
}): Promise<PreparedHeadlessConfig> {
  if (!validateHeadlessConfig(input.config)) {
    throw new HeadlessConfigError(
      formatSchemaErrors(validateHeadlessConfig.errors),
    )
  }
  const environment = input.environment ?? process.env
  const credential = environment[input.config.provider.credentialEnv]?.trim()
  if (!credential) {
    throw new HeadlessConfigError(
      `Provider credential environment variable is missing: ${input.config.provider.credentialEnv}`,
    )
  }

  const userDataDirectory = path.join(input.artifactsDirectory, 'runtime')
  await mkdir(userDataDirectory, { recursive: true })
  const appConfig = buildAppConfig(input.config)
  const configHash = createHash('sha256')
    .update(JSON.stringify(canonicalize(input.config)))
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
    config: structuredClone(input.config),
    configHash,
    configStore,
    userDataDirectory,
  }
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
        protocol: config.provider.protocol ?? 'openai-compatible',
        profile: config.provider.profile ?? 'generic',
        adapterId:
          (config.provider.profile ?? 'generic') === 'deepseek'
            ? 'deepseek.chat-completions'
            : 'openai-compatible.chat-completions',
        revision: 1,
        baseURL: config.provider.baseURL,
        model: config.provider.model,
        reasoning: config.provider.reasoning ?? 'high',
        modelCatalog: [],
        modelOverrides: {},
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
