import { afterEach, describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: execute,
}))
import { readWindowsClipboardFiles } from './windows-clipboard'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  execute.mockReset()
})

describe.skipIf(process.platform !== 'win32')(
  'Explorer file clipboard adapter',
  () => {
    it('uses a fixed hidden STA script, preserves Unicode and strips provider credentials from the child environment', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'must-not-inherit')
      const files = [
        'C:\\复制 文件\\图像.png',
        'C:\\files\\a$(Get-Process).txt',
      ]
      execute.mockImplementation((_file, _args, _options, callback) =>
        callback(null, JSON.stringify(files)),
      )
      expect(await readWindowsClipboardFiles()).toEqual(files)
      const [executable, args, options] = execute.mock.calls[0]
      expect(executable).toMatch(/WindowsPowerShell.*powershell.exe$/iu)
      expect(args).toContain('-STA')
      expect(args.at(-1)).toContain('Get-Clipboard -Format FileDropList')
      expect(args.join(' ')).not.toContain('Get-Process')
      expect(options).toMatchObject({
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 128 * 1024,
      })
      expect(options.env.OPENAI_API_KEY).toBeUndefined()
    })

    it('rejects relative paths and excessive file counts', async () => {
      execute.mockImplementation((_file, _args, _options, callback) =>
        callback(null, '["../outside"]'),
      )
      await expect(readWindowsClipboardFiles()).rejects.toThrow(
        'Invalid clipboard',
      )
      execute.mockImplementation((_file, _args, _options, callback) =>
        callback(
          null,
          JSON.stringify(Array.from({ length: 17 }, () => 'C:\\file.txt')),
        ),
      )
      await expect(readWindowsClipboardFiles()).rejects.toThrow(
        'Invalid clipboard',
      )
      execute.mockImplementation((_file, _args, _options, callback) =>
        callback(null, '[]'),
      )
      expect(await readWindowsClipboardFiles()).toEqual([])
    })
  },
)
