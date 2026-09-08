import os from 'node:os'
import path from 'node:path'

/** Resolves the shared Desktop/CLI profile, with explicit profiles taking precedence. */
export function profileDirectory(
  input: {
    directory?: string
    environment?: NodeJS.ProcessEnv
    desktopDefault?: string
  } = {},
): string {
  const environment = input.environment ?? process.env
  const explicit = input.directory ?? environment.ZCH_PROFILE_DIR
  if (explicit) return path.resolve(explicit)
  if (input.desktopDefault) return path.resolve(input.desktopDefault)
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (environment.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
        : (environment.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'))
  return path.join(base, 'zch-coding-agent')
}
