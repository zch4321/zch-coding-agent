import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTerminalArtifactTail } from './artifact-tail'
import { createTerminalHarness } from './terminal-test-support'

describe('Terminal artifact tails', () => {
  it('reads the last 200 lines of a large file and handles empty logs', async () => {
    const target = await createTerminalHarness()
    try {
      const artifact = {
        root: target.root,
        path: path.join(target.root, 'large.log'),
      }
      const lines = Array.from(
        { length: 100_000 },
        (_, index) => `第 ${index} 行 😀`,
      )
      await writeFile(artifact.path, lines.join('\n') + '\n')
      expect(await readTerminalArtifactTail(artifact)).toEqual({
        content: lines.slice(-200).join('\n') + '\n',
        truncated: true,
      })
      await writeFile(artifact.path, '')
      expect(await readTerminalArtifactTail(artifact)).toEqual({
        content: '',
        truncated: false,
      })
    } finally {
      await target.dispose()
    }
  })
  it('bounds very long UTF-8 lines without corrupting characters', async () => {
    const target = await createTerminalHarness()
    try {
      const artifact = {
        root: target.root,
        path: path.join(target.root, 'unicode.log'),
      }
      await writeFile(artifact.path, '中文😀'.repeat(60_000) + '\n')
      const tail = await readTerminalArtifactTail(artifact)
      expect(Buffer.byteLength(tail.content)).toBeLessThanOrEqual(64 * 1024)
      expect(tail.content).not.toContain('�')
      expect(tail.content.endsWith('中文😀\n')).toBe(true)
      expect(tail.truncated).toBe(true)
    } finally {
      await target.dispose()
    }
  })
  it('rejects files outside the registered root, missing logs, and directories', async () => {
    const target = await createTerminalHarness()
    try {
      await writeFile(path.join(target.root, 'outside.log'), 'private')
      await expect(
        readTerminalArtifactTail({
          root: target.sessionTemp.root,
          path: path.join(target.root, 'outside.log'),
        }),
      ).rejects.toThrow()
      await expect(
        readTerminalArtifactTail({
          root: target.root,
          path: path.join(target.root, 'gone.log'),
        }),
      ).rejects.toThrow()
      const directory = path.join(target.root, 'directory.log')
      await mkdir(directory)
      await expect(
        readTerminalArtifactTail({ root: target.root, path: directory }),
      ).rejects.toThrow()
    } finally {
      await target.dispose()
    }
  })
})
