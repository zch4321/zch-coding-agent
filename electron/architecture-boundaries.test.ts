import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_FILE = /\.(?:ts|tsx|vue)$/u
const IMPORT_SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu
const DYNAMIC_OR_REQUIRE_SPECIFIER =
  /(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/gu
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((specifier) => [
    specifier,
    specifier.replace(/^node:/u, ''),
  ]),
)
const WIRE_FREE_ROOTS = [
  'electron/session',
  'electron/runtime',
  'electron/persistence',
  'src',
  'shared',
]
const CONFIG_DOMAIN_FILES = [
  'application.ts',
  'assistant.ts',
  'integrations.ts',
  'models.ts',
  'network.ts',
  'providers.ts',
  'runtime.ts',
  'security.ts',
]
const IPC_DOMAIN_FILES = [
  'agents.ts',
  'application.ts',
  'configuration.ts',
  'diagnostics.ts',
  'integrations.ts',
  'projects.ts',
  'runs.ts',
  'sessions.ts',
  'terminals.ts',
]
const PROVIDER_IMPORT = /(?:^|\/)providers?(?:\/|$)|provider(?:\.ts)?$/u
const CHAT_WIRE_IDENTIFIER =
  /\b(?:ProviderMessage|ProviderAssistantTurn|reasoning_content|tool_call_id|tool_calls)\b/u
const EXPORTED_CHAT_WIRE_TYPE =
  /\bexport\s+(?:interface|type|class)\s+(?:ProviderMessage|ProviderAssistantTurn|ProviderChatRequest)\b/u
const NATIVE_RENDERER_DIALOG = /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/u
const LITERAL_PRELOAD_INVOKE = /\binvoke\(\s*(['"])([^'"]+)\1/gu

async function sourceFiles(root: string): Promise<string[]> {
  const entries: Dirent<string>[] = await readdir(root, {
    withFileTypes: true,
  })

  const files = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(root, entry.name)
      if (entry.isDirectory()) return sourceFiles(candidate)
      return entry.isFile() && SOURCE_FILE.test(entry.name) ? [candidate] : []
    }),
  )
  return files.flat()
}

async function imports(filePath: string): Promise<string[]> {
  const source = await readFile(filePath, 'utf8')
  return [
    ...source.matchAll(IMPORT_SPECIFIER),
    ...source.matchAll(DYNAMIC_OR_REQUIRE_SPECIFIER),
  ].map((match) => match[1]!)
}

function relative(filePath: string): string {
  return path.relative(process.cwd(), filePath).replaceAll(path.sep, '/')
}

function isForbiddenSharedImport(specifier: string): boolean {
  const normalized = specifier.replace(/^node:/u, '')
  return (
    NODE_BUILTINS.has(normalized) ||
    /^(?:electron|vue|pinia)(?:\/|$)/u.test(specifier) ||
    /^\.\.\/(?:electron|src)(?:\/|$)/u.test(specifier)
  )
}

function isProductionFile(filePath: string): boolean {
  const normalized = relative(filePath)
  return (
    !normalized.endsWith('.test.ts') &&
    !normalized.endsWith('-fixtures.ts') &&
    !normalized.endsWith('-test-support.ts') &&
    !normalized.includes('/fixtures/') &&
    !normalized.includes('/__snapshots__/')
  )
}

describe('architecture import boundaries', () => {
  it('keeps shared contracts free of host and renderer imports', async () => {
    const violations = (
      await Promise.all(
        (await sourceFiles(path.resolve('shared')))
          .filter(isProductionFile)
          .map(async (filePath) => ({
            filePath,
            imports: await imports(filePath),
          })),
      )
    ).flatMap(({ filePath, imports: specifiers }) =>
      specifiers
        .filter(isForbiddenSharedImport)
        .map((specifier) => `${relative(filePath)} -> ${specifier}`),
    )

    expect(violations).toEqual([])
  })

  it('keeps config domains independent from root and compatibility composers', async () => {
    const violations = (
      await Promise.all(
        CONFIG_DOMAIN_FILES.map(async (fileName) => {
          const filePath = path.resolve('shared/config', fileName)
          return {
            filePath,
            imports: await imports(filePath),
          }
        }),
      )
    ).flatMap(({ filePath, imports: specifiers }) =>
      specifiers
        .filter(
          (specifier) =>
            specifier === '../config' ||
            specifier === './public-config' ||
            specifier.startsWith('../ipc/'),
        )
        .map((specifier) => `${relative(filePath)} -> ${specifier}`),
    )

    expect(violations).toEqual([])
  })

  it('keeps IPC domains independent from registry and compatibility composers', async () => {
    const violations = (
      await Promise.all(
        IPC_DOMAIN_FILES.map(async (fileName) => {
          const filePath = path.resolve('shared/ipc', fileName)
          return {
            filePath,
            imports: await imports(filePath),
          }
        }),
      )
    ).flatMap(({ filePath, imports: specifiers }) =>
      specifiers
        .filter(
          (specifier) =>
            specifier === '../ipc-contract' ||
            specifier === './registry' ||
            specifier === './events',
        )
        .map((specifier) => `${relative(filePath)} -> ${specifier}`),
    )

    expect(violations).toEqual([])
  })

  it('keeps shared production contracts off the IPC compatibility facade', async () => {
    const facadePath = path.resolve('shared/ipc-contract')
    const facadeFilePath = path.resolve('shared/ipc-contract.ts')
    const violations = (
      await Promise.all(
        (await sourceFiles(path.resolve('shared')))
          .filter(
            (filePath) =>
              isProductionFile(filePath) && filePath !== facadeFilePath,
          )
          .map(async (filePath) => ({
            filePath,
            imports: await imports(filePath),
          })),
      )
    ).flatMap(({ filePath, imports: specifiers }) =>
      specifiers
        .filter(
          (specifier) =>
            specifier.startsWith('.') &&
            path.resolve(path.dirname(filePath), specifier) === facadePath,
        )
        .map((specifier) => `${relative(filePath)} -> ${specifier}`),
    )

    expect(violations).toEqual([])
  })

  it('keeps shared production contracts off the config compatibility facade', async () => {
    const facadePath = path.resolve('shared/config')
    const facadeFilePath = path.resolve('shared/config.ts')
    const violations = (
      await Promise.all(
        (await sourceFiles(path.resolve('shared')))
          .filter(
            (filePath) =>
              isProductionFile(filePath) && filePath !== facadeFilePath,
          )
          .map(async (filePath) => ({
            filePath,
            imports: await imports(filePath),
          })),
      )
    ).flatMap(({ filePath, imports: specifiers }) =>
      specifiers
        .filter(
          (specifier) =>
            specifier.startsWith('.') &&
            path.resolve(path.dirname(filePath), specifier) === facadePath,
        )
        .map((specifier) => `${relative(filePath)} -> ${specifier}`),
    )

    expect(violations).toEqual([])
  })

  it('keeps core, persistence and renderer production code provider-wire free', async () => {
    const files = (
      await Promise.all(
        WIRE_FREE_ROOTS.map((root) => sourceFiles(path.resolve(root))),
      )
    )
      .flat()
      .filter(isProductionFile)
    const violations = await Promise.all(
      files.map(async (filePath) => {
        const source = await readFile(filePath, 'utf8')
        const specifiers = await imports(filePath)
        return [
          ...specifiers
            .filter(
              (specifier) =>
                relative(filePath).startsWith('electron/persistence/') &&
                PROVIDER_IMPORT.test(specifier),
            )
            .map((specifier) => `${relative(filePath)} -> ${specifier}`),
          ...(CHAT_WIRE_IDENTIFIER.test(source)
            ? [`${relative(filePath)} -> Chat Completions wire identifier`]
            : []),
        ]
      }),
    )

    expect(violations.flat()).toEqual([])
  })

  it('keeps Chat Completions DTOs private to their adapter boundary', async () => {
    const providerFiles = (
      await sourceFiles(path.resolve('electron/providers'))
    ).filter(isProductionFile)
    const exportedWireTypes = await Promise.all(
      providerFiles.map(async (filePath) => {
        const source = await readFile(filePath, 'utf8')
        return EXPORTED_CHAT_WIRE_TYPE.test(source) ? relative(filePath) : ''
      }),
    )
    const providerBoundary = await readFile(
      path.resolve('electron/providers/provider.ts'),
      'utf8',
    )

    expect(exportedWireTypes.filter(Boolean)).toEqual([])
    expect(CHAT_WIRE_IDENTIFIER.test(providerBoundary)).toBe(false)
  })

  it('keeps renderer confirmations inside the application UI', async () => {
    const violations = await Promise.all(
      (await sourceFiles(path.resolve('src')))
        .filter(isProductionFile)
        .map(async (filePath) => {
          const source = await readFile(filePath, 'utf8')
          return NATIVE_RENDERER_DIALOG.test(source) ? relative(filePath) : ''
        }),
    )

    expect(violations.filter(Boolean)).toEqual([])
  })

  it('keeps preload request methods assembled from the Agent API manifest', async () => {
    const source = await readFile(path.resolve('electron/preload.ts'), 'utf8')
    const literalChannels = [...source.matchAll(LITERAL_PRELOAD_INVOKE)].map(
      (match) => match[2],
    )

    expect(literalChannels).toEqual([])
  })
})
