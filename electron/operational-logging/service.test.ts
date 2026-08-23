import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeOperationalLoggerFactory } from './node-logger'
import {
  OperationalLogService,
  type OperationalLoggerAdapter,
  type OperationalLoggerFactory,
} from './service'
import { cleanupRuntimeLogs } from './cleanup'

const defaultConfig = {
  level: 'info' as const,
  retentionDays: 14,
  maxTotalBytes: 50_000_000,
}

async function records(directory: string) {
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith('.jsonl'),
  )
  const lines: unknown[] = []
  for (const file of files) {
    const content = await readFile(path.join(directory, file), 'utf8')
    lines.push(
      ...content
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
  }
  return lines as Array<Record<string, unknown>>
}

describe('OperationalLogService', () => {
  it('writes strict JSONL, filters debug, and redacts secrets and paths', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'operational-log-'))
    const service = new OperationalLogService({
      directory,
      config: defaultConfig,
      loggerFactory: nodeOperationalLoggerFactory,
      sanitizer: {
        workspace: 'F:\\workspace\\secret-project',
        userData: 'C:\\Users\\alice\\AppData\\agent',
      },
      processInstanceId: 'process:test',
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    })

    service.log({
      level: 'debug',
      event: 'provider.started',
      providerId: 'provider',
      providerType: 'generic.responses',
      model: 'model',
    })
    const failed = service.log({
      level: 'error',
      event: 'provider.failed',
      code: 'PROVIDER_HTTP_ERROR',
      message:
        'Bearer top-secret at F:\\workspace\\secret-project\\src\\main.ts and /srv/private-workspace/main.ts',
      error: new Error(
        'api_key=secret-value C:\\Users\\alice\\AppData\\agent\\config.json',
      ),
      endpoint: 'https://user:password@example.test/v1?token=secret#fragment',
      attempt: 2,
      maxAttempts: 3,
      requestFields: ['max_tokens', 'messages', 'reasoning_effort'],
      outputTokenField: 'max_tokens',
      maxOutputTokens: 128_000,
      wireReasoningEffort: 'max',
      thinkingMode: 'enabled',
    })

    const output = await records(directory)
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({
      schemaVersion: 1,
      seq: 1,
      level: 'error',
      event: 'provider.failed',
      processInstanceId: 'process:test',
      diagnosticId: failed.diagnosticId,
      endpoint: 'https://example.test/v1',
      attempt: 2,
      maxAttempts: 3,
      requestFields: ['max_tokens', 'messages', 'reasoning_effort'],
      outputTokenField: 'max_tokens',
      maxOutputTokens: 128_000,
      wireReasoningEffort: 'max',
      thinkingMode: 'enabled',
    })
    const serialized = JSON.stringify(output)
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('alice')
    expect(serialized).not.toContain('secret-project')
    expect(serialized).not.toContain('private-workspace')
    expect(serialized).not.toContain('password')
  })

  it('returns diagnostic IDs while off and never lets write failures escape', () => {
    const throwingFactory: OperationalLoggerFactory = {
      create: () =>
        ({
          error: () => {
            throw new Error('disk full')
          },
          warn: () => undefined,
          info: () => undefined,
          debug: () => undefined,
          transports: {
            console: null,
            file: {
              level: 'info',
              sync: true,
              maxSize: 1,
              resolvePathFn: () => '',
              format: ({ data }) => data,
              archiveLogFn: () => undefined,
              getFile: () => ({ on: () => undefined }),
            },
          },
        }) as OperationalLoggerAdapter,
    }
    const service = new OperationalLogService({
      directory: path.join(os.tmpdir(), 'operational-log-failure'),
      config: defaultConfig,
      loggerFactory: throwingFactory,
    })
    expect(() =>
      service.log({
        level: 'error',
        event: 'run.failed',
        code: 'RUN_FAILED',
      }),
    ).not.toThrow()
    expect(service.status().degraded).toBe(true)

    service.reconfigure({ ...defaultConfig, level: 'off' })
    const result = service.log({
      level: 'error',
      event: 'run.failed',
      code: 'RUN_FAILED',
    })
    expect(result.written).toBe(false)
    expect(result.diagnosticId).toMatch(/^diagnostic:/u)
  })

  it('applies operational level changes without restarting the logger', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'operational-log-'))
    const service = new OperationalLogService({
      directory,
      config: defaultConfig,
      loggerFactory: nodeOperationalLoggerFactory,
    })

    service.log({ level: 'debug', event: 'provider.started' })
    service.reconfigure({ ...defaultConfig, level: 'debug' })
    service.log({ level: 'debug', event: 'provider.completed' })

    expect(await records(directory)).toMatchObject([
      { level: 'debug', event: 'provider.completed' },
    ])
  })

  it('rotates at five MB with unique archive names', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'operational-log-'))
    const service = new OperationalLogService({
      directory,
      config: { ...defaultConfig, level: 'debug' },
      loggerFactory: nodeOperationalLoggerFactory,
    })
    const message = 'x'.repeat(2_048)
    for (let index = 0; index < 2_700; index += 1) {
      service.log({ level: 'debug', event: 'provider.completed', message })
    }
    const files = await readdir(directory)
    const archives = files.filter(
      (name) => name.startsWith('runtime.') && name !== 'runtime.current.jsonl',
    )
    expect(archives.length).toBeGreaterThan(0)
    expect(new Set(archives).size).toBe(archives.length)
    expect(
      (await stat(path.join(directory, 'runtime.current.jsonl'))).size,
    ).toBeGreaterThanOrEqual(0)
  })
})

describe('runtime log cleanup', () => {
  it('protects the active file and applies age and total-size limits', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'operational-log-'))
    await mkdir(directory, { recursive: true })
    const active = path.join(directory, 'runtime.current.jsonl')
    const old = path.join(directory, 'runtime.old.jsonl')
    const recent = path.join(directory, 'runtime.recent.jsonl')
    await writeFile(active, 'active', 'utf8')
    await writeFile(old, 'old-data', 'utf8')
    await writeFile(recent, 'recent-data', 'utf8')
    await utimes(old, new Date('2026-07-01'), new Date('2026-07-01'))
    await utimes(recent, new Date('2026-08-21'), new Date('2026-08-21'))

    const result = await cleanupRuntimeLogs({
      directory,
      activeFile: active,
      retentionDays: 14,
      maxTotalBytes: 5,
      now: new Date('2026-08-22'),
    })
    expect(result.deletedFiles).toBe(2)
    expect(await readFile(active, 'utf8')).toBe('active')
    expect(await readdir(directory)).toEqual(['runtime.current.jsonl'])
  })
})
