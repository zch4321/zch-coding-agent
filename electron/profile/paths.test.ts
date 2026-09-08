import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { profileDirectory } from './paths'

describe('shared host profile selection', () => {
  it('gives an explicit profile precedence over environment and Desktop defaults', () => {
    expect(
      profileDirectory({
        directory: './explicit',
        environment: { NODE_ENV: 'test', ZCH_PROFILE_DIR: './environment' },
        desktopDefault: './desktop',
      }),
    ).toBe(path.resolve('explicit'))
    expect(
      profileDirectory({
        environment: { NODE_ENV: 'test', ZCH_PROFILE_DIR: './environment' },
        desktopDefault: './desktop',
      }),
    ).toBe(path.resolve('environment'))
    expect(
      profileDirectory({
        environment: { NODE_ENV: 'test' },
        desktopDefault: './desktop',
      }),
    ).toBe(path.resolve('desktop'))
  })

  it('uses the Electron package name under the standard OS application data directory for CLI defaults', () => {
    const base =
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.platform === 'win32'
          ? path.join(os.homedir(), 'AppData', 'Roaming')
          : path.join(os.homedir(), '.config')
    expect(profileDirectory({ environment: { NODE_ENV: 'test' } })).toBe(
      path.join(base, 'zch-coding-agent'),
    )
  })
})
