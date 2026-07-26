import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release verification policy', () => {
  it('uses one deterministic verify entry without opt-in workloads', async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve('package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const scripts = packageJson.scripts

    expect(scripts['test:runtime']).toBe(
      'npm run test:native && npm run test:ripgrep && npm run test:sqlite',
    )
    expect(scripts.build).toContain('npm run test:runtime')
    expect(scripts.build).toContain('npm run test:sqlite:packaged')
    expect(scripts['test:e2e:built']).toBe('playwright test')
    expect(scripts.verify).toBe(
      'npm run lint && npm run format:check && npm test && npm run build && npm run test:e2e:built',
    )
    expect(scripts['test:benchmark-cases']).toBeUndefined()
    for (const forbidden of [
      'benchmark:',
      'test:docker-worker',
      'build:worker-image',
      'test:real',
    ]) {
      expect(scripts.verify).not.toContain(forbidden)
      expect(scripts.build).not.toContain(forbidden)
    }
  })

  it('keeps CI and release jobs on the same verify command', async () => {
    for (const workflow of ['ci.yml', 'release.yml']) {
      const contents = await readFile(
        path.resolve('.github', 'workflows', workflow),
        'utf8',
      )
      expect(contents.match(/npm run verify/gu)).toHaveLength(1)
      expect(contents).not.toMatch(
        /npm run (?:lint|format:check|typecheck|test:e2e|build)\b/gu,
      )
    }
  })

  it('does not repeat the host Node probe in packaged SQLite mode', async () => {
    const script = await readFile(
      path.resolve('scripts', 'sqlite-smoke.cjs'),
      'utf8',
    )
    expect(script).toContain(
      "if (!process.argv.includes('--packaged')) runSqliteSmoke()",
    )
    expect(
      script.indexOf("if (packaged && process.platform !== 'win32')"),
    ).toBeLessThan(script.indexOf('? packagedElectronPath()'))
  })
})
