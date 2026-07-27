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
    for (const forbidden of ['test:real']) {
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
