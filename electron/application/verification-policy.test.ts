import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release verification policy', () => {
  it('separates the parallel developer gate from the complete gate', async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve('package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    const scripts = packageJson.scripts

    expect(scripts['test:runtime']).toBe(
      'npm run test:native && npm run test:ripgrep && npm run test:sqlite',
    )
    expect(scripts.check).toBe('node scripts/run-parallel-checks.mjs')
    expect(scripts.build).toContain('npm run test:runtime')
    expect(scripts.build).toContain('npm run verify:package')
    expect(scripts['verify:package']).toContain('npm run build:app')
    expect(scripts['verify:package']).toContain('npm run build:headless')
    expect(scripts['verify:package']).toContain('npm run test:sqlite:packaged')
    expect(scripts['test:e2e:built']).toBe('playwright test')
    expect(scripts.verify).toBe(
      'npm run check && npm run test:runtime && npm run verify:package && npm run test:e2e:built',
    )
    for (const forbidden of ['test:real']) {
      expect(scripts.check).not.toContain(forbidden)
      expect(scripts.verify).not.toContain(forbidden)
      expect(scripts.build).not.toContain(forbidden)
    }
  })

  it('fans out merge diagnostics without weakening the release gate', async () => {
    const ciWorkflow = await readFile(
      path.resolve('.github', 'workflows', 'ci.yml'),
      'utf8',
    )
    const releaseWorkflow = await readFile(
      path.resolve('.github', 'workflows', 'release.yml'),
      'utf8',
    )

    expect(ciWorkflow.match(/npm run check/gu)).toHaveLength(1)
    expect(ciWorkflow).toContain('fail-fast: false')
    expect(ciWorkflow).toContain('command: npm run test:runtime')
    expect(ciWorkflow).toContain('command: npm run test:e2e')
    expect(ciWorkflow).toContain('command: npm run verify:package')
    expect(ciWorkflow).toContain("github.ref == 'refs/heads/master'")
    expect(releaseWorkflow.match(/npm run verify/gu)).toHaveLength(1)
  })

  it('creates draft releases from checked-in notes without duplicating tag CI', async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve('package.json'), 'utf8'),
    ) as { version: string }
    const ciWorkflow = await readFile(
      path.resolve('.github', 'workflows', 'ci.yml'),
      'utf8',
    )
    const releaseWorkflow = await readFile(
      path.resolve('.github', 'workflows', 'release.yml'),
      'utf8',
    )

    expect(ciWorkflow).toContain("branches:\n      - '**'")
    expect(releaseWorkflow).toContain('Validate release inputs')
    expect(releaseWorkflow).toContain(
      'body_path: docs/releases/${{ github.ref_name }}.md',
    )
    expect(releaseWorkflow).toContain('append_body: false')
    expect(releaseWorkflow).toContain('draft: true')
    expect(releaseWorkflow).not.toContain('generate_release_notes')
    await expect(
      readFile(
        path.resolve('docs', 'releases', `v${packageJson.version}.md`),
        'utf8',
      ),
    ).resolves.toContain(`v${packageJson.version}`)
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
