import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('shared architecture boundary', () => {
  it('does not import Electron, Node, or Vue from shared modules', async () => {
    const files = (await readdir('shared', { recursive: true })).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    )
    const violations: string[] = []

    for (const file of files) {
      const content = await readFile(path.join('shared', file), 'utf8')

      if (
        /from\s+['"](?:electron|node:|vue)/.test(content) ||
        /require\(\s*['"](?:electron|node:|vue)/.test(content)
      ) {
        violations.push(file)
      }
    }

    expect(violations).toEqual([])
  })
})
