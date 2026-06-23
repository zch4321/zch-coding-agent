import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PathGuard } from './path-guard'
import { RipgrepSearcher } from './ripgrep-searcher'
import { __resetCachedSearcher } from './searcher'

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rg-search-'))
  await mkdir(path.join(root, 'src'))
  await writeFile(
    path.join(root, 'src', 'app.ts'),
    'const marker = 1\nexport const other = 2\n',
  )
  await writeFile(path.join(root, 'README.md'), 'marker in readme\n')
  await mkdir(path.join(root, 'node_modules'))
  await writeFile(
    path.join(root, 'node_modules', 'hidden.ts'),
    'marker hidden\n',
  )
  return root
}

function search(
  searcher: RipgrepSearcher,
  root: string,
  input: {
    pattern: string
    include?: string
    rootInput?: string
    caseSensitive?: boolean
    maxResults?: number
    signal?: AbortSignal
  },
) {
  const guard = PathGuard.fromCanonical(root)
  return searcher.search({
    pattern: input.pattern,
    caseSensitive: input.caseSensitive ?? false,
    guard,
    rootInput: input.rootInput ?? '.',
    include: input.include ?? '**/*',
    maxResults: input.maxResults ?? 100,
    signal: input.signal ?? new AbortController().signal,
  })
}

describe('RipgrepSearcher', () => {
  afterEach(() => {
    __resetCachedSearcher()
  })

  it('is available when the bundled binary resolves', async () => {
    const searcher = new RipgrepSearcher()
    expect(await searcher.isAvailable()).toBe(true)
    expect(searcher.backend).toBe('ripgrep')
  })

  it('returns relative matches with line numbers', async () => {
    const root = await makeWorkspace()
    const outcome = await search(new RipgrepSearcher(), root, {
      pattern: 'marker',
    })

    const paths = outcome.matches.map((match) => match.path)
    expect(paths).toContain('src/app.ts')
    expect(paths).toContain('README.md')
    expect(paths).not.toContain('node_modules/hidden.ts')

    const appMatch = outcome.matches.find(
      (match) => match.path === 'src/app.ts',
    )
    expect(appMatch?.line).toBe(1)
    expect(appMatch?.text).toContain('marker')
  })

  it('honours the include glob filter', async () => {
    const root = await makeWorkspace()
    const outcome = await search(new RipgrepSearcher(), root, {
      pattern: 'marker',
      include: '**/*.ts',
    })

    const paths = outcome.matches.map((match) => match.path)
    expect(paths).toEqual(['src/app.ts'])
  })

  it('honours case sensitivity', async () => {
    const root = await makeWorkspace()
    const lower = await search(new RipgrepSearcher(), root, {
      pattern: 'MARKER',
      caseSensitive: true,
    })
    expect(lower.matches).toHaveLength(0)

    const insensitive = await search(new RipgrepSearcher(), root, {
      pattern: 'MARKER',
      caseSensitive: false,
    })
    expect(insensitive.matches.length).toBeGreaterThan(0)
  })

  it('caps results at maxResults and marks truncated', async () => {
    const root = await makeWorkspace()
    const outcome = await search(new RipgrepSearcher(), root, {
      pattern: 'marker',
      maxResults: 1,
    })

    expect(outcome.matches).toHaveLength(1)
    expect(outcome.truncated).toBe(true)
  })

  it('scopes the search to rootInput', async () => {
    const root = await makeWorkspace()
    const outcome = await search(new RipgrepSearcher(), root, {
      pattern: 'marker',
      rootInput: 'src',
    })

    const paths = outcome.matches.map((match) => match.path)
    expect(paths.every((value) => value.startsWith('src/'))).toBe(true)
    expect(paths).not.toContain('README.md')
  })

  it('rejects when the abort signal fires', async () => {
    const root = await makeWorkspace()
    const controller = new AbortController()
    const promise = search(new RipgrepSearcher(), root, {
      pattern: 'marker',
      signal: controller.signal,
    })
    controller.abort()

    await expect(promise).rejects.toBeDefined()
  })

  it('rejects an invalid regex instead of returning empty results', async () => {
    const root = await makeWorkspace()
    const promise = search(new RipgrepSearcher(), root, {
      pattern: '[',
    })

    await expect(promise).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_REGEX|REGEX_FAILED/u),
    })
  })
})
