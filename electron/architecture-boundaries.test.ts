import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_FILE = /\.(?:ts|tsx|vue)$/u
const IMPORT_SPECIFIER =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gu
const SHARED_FORBIDDEN_IMPORT =
  /^(?:node:|electron$|electron\/|vue$|vue\/|pinia$|pinia\/|\.\.\/(?:electron|src)\/)/u
const TARGET_ROOTS = ['electron/application', 'electron/persistence']
const PROVIDER_IMPORT = /(?:^|\/)providers?(?:\/|$)|provider(?:\.ts)?$/u
const CHAT_WIRE_IDENTIFIER =
  /\b(?:ProviderMessage|ProviderAssistantTurn|reasoning_content|tool_call_id|tool_calls)\b/u

async function sourceFiles(root: string): Promise<string[]> {
  let entries: Dirent<string>[]

  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return []
    }
    throw error
  }

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
  return [...source.matchAll(IMPORT_SPECIFIER)].map((match) => match[1]!)
}

function relative(filePath: string): string {
  return path.relative(process.cwd(), filePath).replaceAll(path.sep, '/')
}

describe('architecture import boundaries', () => {
  it('keeps shared contracts free of host and renderer imports', async () => {
    const violations = (
      await Promise.all(
        (await sourceFiles(path.resolve('shared'))).map(async (filePath) => ({
          filePath,
          imports: await imports(filePath),
        })),
      )
    ).flatMap(({ filePath, imports: specifiers }) =>
      specifiers
        .filter((specifier) => SHARED_FORBIDDEN_IMPORT.test(specifier))
        .map((specifier) => `${relative(filePath)} -> ${specifier}`),
    )

    expect(violations).toEqual([])
  })

  it('keeps target application and persistence code provider-wire free', async () => {
    const files = (
      await Promise.all(
        TARGET_ROOTS.map((root) => sourceFiles(path.resolve(root))),
      )
    ).flat()
    const violations = await Promise.all(
      files.map(async (filePath) => {
        const source = await readFile(filePath, 'utf8')
        const specifiers = await imports(filePath)
        return [
          ...specifiers
            .filter((specifier) => PROVIDER_IMPORT.test(specifier))
            .map((specifier) => `${relative(filePath)} -> ${specifier}`),
          ...(CHAT_WIRE_IDENTIFIER.test(source)
            ? [`${relative(filePath)} -> Chat Completions wire identifier`]
            : []),
        ]
      }),
    )

    expect(violations.flat()).toEqual([])
  })
})
