import { spawn } from 'node:child_process'
import { accessPath as access } from '../common/filesystem'
import path from 'node:path'
import type {
  CommandShellCatalog,
  CommandShellProfile,
  CommandShellProfileId,
  CommandShellSelection,
} from '../../shared/command-shell'

const WINDOWS_AUTO_ORDER: readonly CommandShellProfileId[] = [
  'powershell-7',
  'windows-powershell',
  'cmd',
]
const DISCOVERY_TIMEOUT_MS = 2_000

export const POWERSHELL_PROCESS_EXECUTION_POLICY_ARGS = [
  '-ExecutionPolicy',
  'Bypass',
] as const

export interface ResolvedCommandShell {
  profile: CommandShellProfile
  requested: CommandShellSelection
  fallback: boolean
  fallbackEncoding: string
}

export interface CommandShellInvocation {
  executable: string
  args: string[]
  environment: Record<string, string | undefined>
}

interface DiscoveryDependencies {
  platform: NodeJS.Platform
  environment: Readonly<Record<string, string | undefined>>
  fileExists: (candidate: string) => Promise<boolean>
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const entry = Object.entries(environment).find(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
  )
  return entry?.[1]
}

async function defaultFileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

function pathEntries(dependencies: DiscoveryDependencies): string[] {
  const platformPath =
    dependencies.platform === 'win32' ? path.win32 : path.posix
  return (environmentValue(dependencies.environment, 'PATH') ?? '')
    .split(platformPath.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/gu, ''))
    .filter(Boolean)
}

async function firstExisting(
  candidates: readonly string[],
  dependencies: DiscoveryDependencies,
): Promise<
  { executable: string; source: CommandShellProfile['source'] } | undefined
> {
  const platformPath =
    dependencies.platform === 'win32' ? path.win32 : path.posix
  for (const candidate of candidates) {
    if (await dependencies.fileExists(candidate)) {
      return {
        executable: platformPath.resolve(candidate),
        source: 'well-known',
      }
    }
  }
  return undefined
}

async function findOnPath(
  executableName: string,
  dependencies: DiscoveryDependencies,
  accept: (candidate: string) => boolean = () => true,
): Promise<
  { executable: string; source: CommandShellProfile['source'] } | undefined
> {
  const platformPath =
    dependencies.platform === 'win32' ? path.win32 : path.posix
  for (const entry of pathEntries(dependencies)) {
    const candidate = platformPath.join(entry, executableName)
    if (accept(candidate) && (await dependencies.fileExists(candidate))) {
      return { executable: platformPath.resolve(candidate), source: 'path' }
    }
  }
  return undefined
}

function profile(
  id: CommandShellProfileId,
  kind: CommandShellProfile['kind'],
  label: string,
  located: { executable: string; source: CommandShellProfile['source'] },
): CommandShellProfile {
  return { id, kind, label, ...located }
}

async function discoverWindowsShells(
  dependencies: DiscoveryDependencies,
): Promise<CommandShellProfile[]> {
  const windowsPath = path.win32
  const entries: CommandShellProfile[] = []
  const programFiles = environmentValue(
    dependencies.environment,
    'ProgramFiles',
  )
  const localAppData = environmentValue(
    dependencies.environment,
    'LOCALAPPDATA',
  )
  const windowsDirectory = environmentValue(dependencies.environment, 'WINDIR')
  const [pwsh, windowsPowerShell, cmd, gitBash, nushell] = await Promise.all([
    firstExisting(
      programFiles
        ? [windowsPath.join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
        : [],
      dependencies,
    ).then((located) => located ?? findOnPath('pwsh.exe', dependencies)),
    firstExisting(
      windowsDirectory
        ? [
            windowsPath.join(
              windowsDirectory,
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe',
            ),
          ]
        : [],
      dependencies,
    ).then((located) => located ?? findOnPath('powershell.exe', dependencies)),
    firstExisting(
      windowsDirectory
        ? [windowsPath.join(windowsDirectory, 'System32', 'cmd.exe')]
        : [],
      dependencies,
    ).then((located) => located ?? findOnPath('cmd.exe', dependencies)),
    firstExisting(
      [
        ...(programFiles
          ? [
              windowsPath.join(programFiles, 'Git', 'bin', 'bash.exe'),
              windowsPath.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
            ]
          : []),
        ...(localAppData
          ? [
              windowsPath.join(
                localAppData,
                'Programs',
                'Git',
                'bin',
                'bash.exe',
              ),
            ]
          : []),
      ],
      dependencies,
    ).then(
      (located) =>
        located ??
        findOnPath(
          'bash.exe',
          dependencies,
          (candidate) =>
            !candidate
              .toLowerCase()
              .includes(`${windowsPath.sep}system32${windowsPath.sep}`),
        ),
    ),
    findOnPath('nu.exe', dependencies),
  ])

  if (pwsh)
    entries.push(profile('powershell-7', 'powershell', 'PowerShell 7', pwsh))
  if (windowsPowerShell) {
    entries.push(
      profile(
        'windows-powershell',
        'powershell',
        'Windows PowerShell',
        windowsPowerShell,
      ),
    )
  }
  if (cmd) entries.push(profile('cmd', 'cmd', 'Command Prompt', cmd))
  if (gitBash) entries.push(profile('git-bash', 'bash', 'Git Bash', gitBash))
  if (nushell) entries.push(profile('nushell', 'nushell', 'Nushell', nushell))
  return entries
}

async function discoverPosixShells(
  dependencies: DiscoveryDependencies,
): Promise<CommandShellProfile[]> {
  const configured = environmentValue(dependencies.environment, 'SHELL')
  const executable =
    configured && (await dependencies.fileExists(configured))
      ? configured
      : '/bin/sh'
  return [
    profile('system-shell', 'posix', path.posix.basename(executable), {
      executable: path.posix.resolve(executable),
      source: 'system',
    }),
  ]
}

function autoProfile(
  profiles: readonly CommandShellProfile[],
  platform: NodeJS.Platform,
): CommandShellProfile {
  if (platform !== 'win32') return profiles[0]!
  for (const id of WINDOWS_AUTO_ORDER) {
    const candidate = profiles.find((entry) => entry.id === id)
    if (candidate) return candidate
  }
  return profiles[0]!
}

function codePageEncoding(codePage: number | undefined): string {
  switch (codePage) {
    case 65001:
      return 'utf-8'
    case 936:
    case 54936:
      return 'gb18030'
    case 950:
      return 'big5'
    case 932:
      return 'shift_jis'
    case 949:
      return 'euc-kr'
    case 866:
      return 'ibm866'
    case 1250:
    case 1251:
    case 1252:
    case 1253:
    case 1254:
    case 1255:
    case 1256:
    case 1257:
    case 1258:
      return `windows-${codePage}`
    default:
      return 'windows-1252'
  }
}

function readCodePage(cmdExecutable: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const child = spawn(cmdExecutable, ['/d', '/c', 'chcp'], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (value?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish()
    }, DISCOVERY_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.concat(chunks).byteLength < 2_048) chunks.push(chunk)
    })
    child.once('error', () => finish())
    child.once('close', () => {
      const match = Buffer.concat(chunks)
        .toString('latin1')
        .match(/\d{3,5}/u)
      finish(match ? Number(match[0]) : undefined)
    })
  })
}

function powershellScript(command: string): string {
  return [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    '$global:LASTEXITCODE = 0',
    command,
    '$__zchCommandSucceeded = $?',
    '$__zchCommandExitCode = $LASTEXITCODE',
    'if ($__zchCommandSucceeded) { exit 0 }',
    'if ($__zchCommandExitCode -is [int] -and $__zchCommandExitCode -ne 0) { exit $__zchCommandExitCode }',
    'exit 1',
  ].join('\n')
}

/** Discovers and resolves supported command interpreters without shell parsing. */
export class CommandShellService {
  readonly #dependencies: DiscoveryDependencies
  #profiles?: Promise<CommandShellProfile[]>
  #fallbackEncoding?: Promise<string>

  constructor(dependencies: Partial<DiscoveryDependencies> = {}) {
    this.#dependencies = {
      platform: dependencies.platform ?? process.platform,
      environment: dependencies.environment ?? process.env,
      fileExists: dependencies.fileExists ?? defaultFileExists,
    }
  }

  /** Returns the available profiles, optionally invalidating cached discovery. */
  async list(refresh = false): Promise<CommandShellProfile[]> {
    if (refresh) {
      this.#profiles = undefined
      this.#fallbackEncoding = undefined
    }
    this.#profiles ??=
      this.#dependencies.platform === 'win32'
        ? discoverWindowsShells(this.#dependencies)
        : discoverPosixShells(this.#dependencies)
    const profiles = await this.#profiles
    if (profiles.length === 0) {
      throw new Error('No supported command shell is available')
    }
    return structuredClone(profiles)
  }

  /** Resolves a configured selection to one currently available profile. */
  async resolve(
    requested: CommandShellSelection,
    refresh = false,
  ): Promise<ResolvedCommandShell> {
    const profiles = await this.list(refresh)
    const automatic = autoProfile(profiles, this.#dependencies.platform)
    const selected =
      requested === 'auto'
        ? automatic
        : profiles.find((entry) => entry.id === requested)
    return {
      profile: structuredClone(selected ?? automatic),
      requested,
      fallback: requested !== 'auto' && selected === undefined,
      fallbackEncoding: await this.#resolveFallbackEncoding(profiles),
    }
  }

  /** Returns the fixed automatic profile for the current platform. */
  async automaticProfile(refresh = false): Promise<CommandShellProfile> {
    const profiles = await this.list(refresh)
    return structuredClone(autoProfile(profiles, this.#dependencies.platform))
  }

  /** Builds a renderer-safe catalog for the current configured selection. */
  async catalog(
    selected: CommandShellSelection,
    refresh = false,
  ): Promise<CommandShellCatalog> {
    const profiles = await this.list(refresh)
    const resolved = await this.resolve(selected)
    return {
      selected,
      resolved: resolved.profile,
      fallback: resolved.fallback,
      profiles,
    }
  }

  /** Builds the explicit executable, arguments, and UTF-8 environment. */
  invocation(
    resolved: ResolvedCommandShell,
    command: string,
  ): CommandShellInvocation {
    const environment: Record<string, string | undefined> = {}
    switch (resolved.profile.kind) {
      case 'powershell':
        return {
          executable: resolved.profile.executable,
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            ...POWERSHELL_PROCESS_EXECUTION_POLICY_ARGS,
            '-Command',
            powershellScript(command),
          ],
          environment,
        }
      case 'cmd':
        return {
          executable: resolved.profile.executable,
          args: ['/d', '/s', '/c', `chcp 65001>nul & ${command}`],
          environment,
        }
      case 'bash':
        environment.LANG = 'C.UTF-8'
        environment.LC_ALL = 'C.UTF-8'
        return {
          executable: resolved.profile.executable,
          args: ['--noprofile', '--norc', '-c', command],
          environment,
        }
      case 'nushell':
        environment.LANG = 'C.UTF-8'
        return {
          executable: resolved.profile.executable,
          args: ['--no-config-file', '-c', command],
          environment,
        }
      case 'posix':
        environment.LANG =
          environmentValue(this.#dependencies.environment, 'LANG') ?? 'C.UTF-8'
        return {
          executable: resolved.profile.executable,
          args: ['-c', command],
          environment,
        }
    }
  }

  async #resolveFallbackEncoding(
    profiles: readonly CommandShellProfile[],
  ): Promise<string> {
    if (this.#dependencies.platform !== 'win32') return 'utf-8'
    this.#fallbackEncoding ??= readCodePage(
      profiles.find((entry) => entry.id === 'cmd')?.executable ?? 'cmd.exe',
    ).then(codePageEncoding)
    return this.#fallbackEncoding
  }
}

export const commandShellService = new CommandShellService()
