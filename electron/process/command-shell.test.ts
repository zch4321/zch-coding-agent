import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandShellService } from './command-shell'

function windowsService(files: readonly string[]): CommandShellService {
  const available = new Set(
    files.map((file) => path.win32.resolve(file).toLowerCase()),
  )
  return new CommandShellService({
    platform: 'win32',
    environment: {
      PATH: ['C:\\Shells\\PowerShell7', 'C:\\Windows\\System32'].join(
        path.win32.delimiter,
      ),
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      WINDIR: 'C:\\Windows',
    },
    fileExists: async (candidate) =>
      available.has(path.win32.resolve(candidate).toLowerCase()),
  })
}

describe('CommandShellService', () => {
  it('prefers PowerShell 7 and falls back when a saved profile is unavailable', async () => {
    const service = windowsService([
      'C:\\Shells\\PowerShell7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ])

    await expect(service.resolve('auto')).resolves.toMatchObject({
      profile: { id: 'powershell-7' },
      fallback: false,
    })
    await expect(service.resolve('git-bash')).resolves.toMatchObject({
      profile: { id: 'powershell-7' },
      requested: 'git-bash',
      fallback: true,
    })
  })

  it('discovers Git Bash only from Git installations, not the legacy WSL launcher', async () => {
    const service = windowsService([
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Windows\\System32\\bash.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
    ])

    await expect(service.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'git-bash',
          executable: path.win32.resolve(
            'C:\\Program Files\\Git\\bin\\bash.exe',
          ),
        }),
      ]),
    )
  })

  it('builds explicit UTF-8 PowerShell and CMD invocations', async () => {
    const service = windowsService([
      'C:\\Shells\\PowerShell7\\pwsh.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ])
    const powershell = await service.resolve('powershell-7')
    const powershellInvocation = service.invocation(
      powershell,
      'Write-Output "中文"',
    )

    expect(powershellInvocation.executable).toBe(
      path.win32.resolve('C:\\Shells\\PowerShell7\\pwsh.exe'),
    )
    expect(powershellInvocation.args).toEqual(
      expect.arrayContaining([
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
      ]),
    )
    expect(powershellInvocation.args.at(-1)).toContain(
      '[Console]::OutputEncoding',
    )
    expect(powershellInvocation.args.at(-1)).toContain('Write-Output "中文"')

    const cmd = await service.resolve('cmd')
    expect(service.invocation(cmd, 'echo 中文').args).toEqual([
      '/d',
      '/s',
      '/c',
      'chcp 65001>nul & echo 中文',
    ])
  })

  it('uses pwsh, Windows PowerShell, then CMD for Windows automatic selection', async () => {
    const all = windowsService([
      'C:\\Shells\\PowerShell7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ])
    const withoutPwsh = windowsService([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ])
    const cmdOnly = windowsService(['C:\\Windows\\System32\\cmd.exe'])

    await expect(all.automaticProfile()).resolves.toMatchObject({
      id: 'powershell-7',
    })
    await expect(withoutPwsh.automaticProfile()).resolves.toMatchObject({
      id: 'windows-powershell',
    })
    await expect(cmdOnly.automaticProfile()).resolves.toMatchObject({
      id: 'cmd',
    })
  })
})
