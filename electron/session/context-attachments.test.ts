import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { toPublicConfig, DEFAULT_APP_CONFIG } from '../config/schema'
import { prepareRunContext } from './context-attachments'

describe('R4 run context attachments', () => {
  it('injects bounded file context and layered AGENTS.md instructions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-context-'))
    const workspace = path.join(directory, 'workspace')
    await mkdir(path.join(workspace, 'docs'), { recursive: true })
    await writeFile(path.join(workspace, 'AGENTS.md'), 'root guidance\n')
    await writeFile(
      path.join(workspace, 'docs', 'AGENTS.md'),
      'docs guidance\n',
    )
    await writeFile(path.join(workspace, 'docs', 'note.md'), '# Note\nbody\n')

    const context = await prepareRunContext({
      workspace,
      attachments: [{ kind: 'file', path: 'docs/note.md', source: 'mention' }],
      config: toPublicConfig(DEFAULT_APP_CONFIG, true),
    })

    expect(context.chips).toMatchObject([
      { kind: 'file', path: 'docs/note.md', source: 'mention' },
    ])
    expect(context.providerContent).toContain('root guidance')
    expect(context.providerContent).toContain('docs guidance')
    expect(context.providerContent).toContain(
      '<context_file path="docs/note.md"',
    )
    expect(context.providerContent).toContain('# Note')
  })

  it('summarizes directory attachments without reading every file body', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'agent-context-dir-'),
    )
    const workspace = path.join(directory, 'workspace')
    await mkdir(path.join(workspace, 'src'), { recursive: true })
    await writeFile(path.join(workspace, 'src', 'index.ts'), 'secret body\n')

    const context = await prepareRunContext({
      workspace,
      attachments: [{ kind: 'directory', path: 'src', source: 'picker' }],
      config: toPublicConfig(DEFAULT_APP_CONFIG, true),
    })

    expect(context.chips).toMatchObject([
      { kind: 'directory', path: 'src', source: 'picker' },
    ])
    expect(context.providerContent).toContain('<context_directory path="src"')
    expect(context.providerContent).toContain('file src/index.ts')
    expect(context.providerContent).not.toContain('secret body')
  })
})
