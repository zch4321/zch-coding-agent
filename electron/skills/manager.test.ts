import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  isPublicNetworkAddress,
  MAX_SKILL_BYTES,
  parseSkillDocument,
  SkillError,
  SkillsManager,
  validateSkillUrl,
} from './manager'

function document(
  name: string,
  description = 'A useful skill',
  body = 'Follow these instructions.',
): string {
  return `---\nname: ${name}\ndescription: ${description}\ntrigger: tests\n---\n${body}\n`
}

describe('SkillsManager', () => {
  it('parses only bounded safe YAML metadata', () => {
    expect(parseSkillDocument(document('testing'))).toMatchObject({
      name: 'testing',
      description: 'A useful skill',
    })
    expect(() => parseSkillDocument('not frontmatter')).toThrow(SkillError)
    expect(() =>
      parseSkillDocument(
        '---\nname: bad\ndescription: !!js/function >\n  function() {}\n---\nbody',
      ),
    ).toThrow('safe YAML')
    expect(() =>
      parseSkillDocument(
        '---\nname: alias\ndescription: &value repeated\ntrigger: *value\n---\nbody',
      ),
    ).toThrow('anchors or aliases')
    expect(() =>
      parseSkillDocument('---\nname: ../escape\ndescription: bad\n---\nbody'),
    ).toThrow('Skill name')
    expect(() =>
      parseSkillDocument(
        '---\nname: extra\ndescription: bad\nunknown: value\n---\nbody',
      ),
    ).toThrow('unsupported fields')
  })

  it('skips malformed, duplicate, oversized and symlinked files without aborting', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'skills-scan-'))
    await writeFile(path.join(directory, 'a.md'), document('same'))
    await writeFile(path.join(directory, 'b.md'), document('same'))
    await writeFile(
      path.join(directory, 'missing.md'),
      '---\nname: missing\n---\nbody',
    )
    await writeFile(
      path.join(directory, 'large.md'),
      Buffer.alloc(MAX_SKILL_BYTES + 1),
    )
    const outside = path.join(directory, 'outside')
    await mkdir(outside)
    await symlink(outside, path.join(directory, 'linked.md'), 'junction')

    const manager = new SkillsManager(directory)
    const result = await manager.initialize()

    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      name: 'same',
      enabled: false,
      source: 'manual',
    })
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'DUPLICATE_NAME',
        'INVALID_DESCRIPTION',
        'TOO_LARGE',
        'UNSAFE_FILE',
      ]),
    )
  })

  it('persists enablement and reads only enabled skills from memory', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'skills-index-'))
    await writeFile(path.join(directory, 'one.md'), document('one'))
    const manager = new SkillsManager(directory, {
      now: () => new Date('2026-06-20T00:00:00.000Z'),
    })
    await manager.initialize()

    expect(manager.read('one')).toBeUndefined()
    expect(await manager.setEnabled('one', true)).toBe(true)
    expect(manager.read('one')).toMatchObject({
      name: 'one',
      trustedAt: '2026-06-20T00:00:00.000Z',
    })
    expect(manager.read('../one')).toBeUndefined()

    const reloaded = new SkillsManager(directory)
    const list = await reloaded.initialize()
    expect(list.skills[0]?.enabled).toBe(true)
    expect(
      JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
    })
  })

  it('disables an enabled skill when its trusted content hash changes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'skills-trust-'))
    const filePath = path.join(directory, 'one.md')
    await writeFile(filePath, document('one', 'Original description'))
    const manager = new SkillsManager(directory)
    await manager.initialize()
    await manager.setEnabled('one', true)

    await writeFile(filePath, document('one', 'Replaced description'))
    const refreshed = await manager.refresh()

    expect(refreshed.skills[0]).toMatchObject({ name: 'one', enabled: false })
    expect(manager.read('one')).toBeUndefined()
  })

  it('keeps all enabled names when detailed summaries exceed the budget', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'skills-summary-'))
    await writeFile(
      path.join(directory, 'alpha.md'),
      document('alpha', 'a'.repeat(200)),
    )
    await writeFile(
      path.join(directory, 'beta.md'),
      document('beta', 'b'.repeat(200)),
    )
    const manager = new SkillsManager(directory)
    await manager.initialize()
    await manager.setEnabled('alpha', true)
    await manager.setEnabled('beta', true)

    const summary = manager.summaryPrompt(130)
    expect(summary.length).toBeLessThanOrEqual(130)
    expect(summary).toContain('alpha')
    expect(summary).toContain('beta')
  })

  it('installs uploads atomically without overwriting duplicate names', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'skills-upload-'))
    const sourceDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'skills-source-'),
    )
    const source = path.join(sourceDirectory, 'upload.md')
    await writeFile(source, document('upload'))
    const manager = new SkillsManager(directory)
    await manager.initialize()

    await expect(manager.installFromFile(source)).resolves.toMatchObject({
      name: 'upload',
      enabled: false,
      source: 'upload',
    })
    await expect(manager.installFromFile(source)).rejects.toMatchObject({
      code: 'DUPLICATE_NAME',
    })
  })

  it('pins a validated public address and revalidates redirects', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'skills-download-'))
    const resolveHost = vi
      .fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    const connectHttps = vi.fn().mockResolvedValue({
      status: 302,
      location: 'https://private.example/skill.md',
      body: Buffer.alloc(0),
    })
    const manager = new SkillsManager(directory, { resolveHost, connectHttps })
    await manager.initialize()

    await expect(
      manager.installFromUrl('https://public.example/skill.md'),
    ).rejects.toMatchObject({
      code: 'PRIVATE_ADDRESS',
    })
    expect(connectHttps).toHaveBeenCalledTimes(1)
    expect(connectHttps.mock.calls[0]?.[1]).toEqual({
      address: '93.184.216.34',
      family: 4,
    })
  })

  it('accepts a bounded successful HTTPS download', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'skills-download-ok-'),
    )
    const manager = new SkillsManager(directory, {
      resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
      connectHttps: async () => ({
        status: 200,
        body: Buffer.from(document('remote')),
      }),
    })
    await manager.initialize()

    await expect(
      manager.installFromUrl('https://example.com/skill.md'),
    ).resolves.toMatchObject({
      name: 'remote',
      source: 'download',
      enabled: false,
    })
  })
})

describe('skill network policy', () => {
  it.each([
    'http://example.com/skill.md',
    'https://user:pass@example.com/skill.md',
    'https://example.com:8443/skill.md',
  ])('rejects unsafe URL %s', (url) => {
    expect(() => validateSkillUrl(url)).toThrow(SkillError)
  })

  it.each([
    '0.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:0:0:1',
    'ff02::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false)
  })

  it('allows a public address', () => {
    expect(isPublicNetworkAddress('93.184.216.34')).toBe(true)
    expect(isPublicNetworkAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(
      true,
    )
  })
})
