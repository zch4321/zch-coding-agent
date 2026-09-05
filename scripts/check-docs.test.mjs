import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  checkDocumentation,
  documentationFiles,
  parseDocumentation,
} from './check-docs.mjs'

/** Creates a bounded temporary documentation fixture and registers its cleanup. */
async function fixture(context, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-docs-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  for (const [file, body] of Object.entries(files)) {
    const absolute = path.join(root, file)
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, body, 'utf8')
  }
  return root
}

test('parses reference links and images, excluding fenced and inline examples', () => {
  const parsed = parseDocumentation(
    [
      '# 状态与 IPC',
      '## `Run` / **状态**',
      '## 状态与 IPC',
      '[document][target] ![preview](images/view.png)',
      '',
      '[target]: guide.md#run--状态',
      '`[example](missing.md)`',
      '```markdown',
      '[example](missing-too.md)',
      '```',
    ].join('\n'),
  )
  assert.deepEqual(
    parsed.references.map(({ href }) => href),
    ['guide.md#run--%E7%8A%B6%E6%80%81', 'images/view.png'],
  )
  assert.deepEqual(
    [...parsed.anchors],
    ['状态与-ipc', 'run--状态', '状态与-ipc-1'],
  )
})

test('accepts portable paths, encoded spaces, headings and code ranges', async (context) => {
  const root = await fixture(context, {
    'docs/README.md':
      '[页](guide%20one.md#中文标题)\n[code](../src/a.ts#L1-L2)\n[dir](../src/)\n![image](view.png)\n[web](https://example.invalid/page)',
    'docs/guide one.md': '# 中文标题\n',
    'docs/view.png': 'fixture',
    'src/a.ts': 'one\ntwo\n',
  })
  const result = await checkDocumentation(root, ['docs/README.md'])
  assert.deepEqual(result.failures, [])
  assert.equal(result.referenceCount, 4)
})

test('reports all missing targets, stale anchors, case mismatches and escapes', async (context) => {
  const root = await fixture(context, {
    'docs/README.md': [
      '[gone](missing.md)',
      '[anchor](guide.md#deleted)',
      '[case](Guide.md)',
      '[absolute](/machine/file.md)',
      '[escape](../../outside.md)',
      '[code](../src/a.ts#L9)',
      '[reverse](../src/a.ts#L2-L1)',
      '![image](missing.png)',
    ].join('\n'),
    'docs/guide.md': '# Present\n',
    'src/a.ts': 'one\ntwo\n',
  })
  const result = await checkDocumentation(root, ['docs/README.md'])
  assert.equal(result.failures.length, 8)
  assert.ok(
    result.failures.some((failure) =>
      failure.includes('missing heading #deleted'),
    ),
  )
  assert.ok(
    result.failures.some((failure) =>
      failure.includes('target leaves the repository'),
    ),
  )
  assert.ok(result.failures.some((failure) => failure.includes('out of range')))
})

test('collects maintained docs, including archives, without scanning prompts or build output', async (context) => {
  const root = await fixture(context, {
    'README.md': '# Root',
    '.gitignore': 'docs/code-review-report/\n',
    'AGENTS.md': '# Rules',
    'electron/tooling/README.md': '# Tooling',
    'docs/README.md': '# Docs',
    'docs/archive/history.md': '# History',
    'docs/code-review-report/private.md': '# Local report',
    'resources/prompts/base.md': '# Product input',
    'dist/README.md': '# Generated',
  })
  assert.deepEqual((await documentationFiles(root)).sort(), [
    'AGENTS.md',
    'README.md',
    'docs/README.md',
    'docs/archive/history.md',
    'electron/tooling/README.md',
  ])
})
