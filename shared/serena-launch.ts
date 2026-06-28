import type { SerenaBackendConfig } from './project-model'

const DEFAULT_CONTEXT = 'ide-assistant'

function boolArg(value: boolean): string {
  return value ? 'true' : 'false'
}

function replaceWorkspace(value: string, workspace: string): string {
  return value.replace(/\$\{workspace\}/gu, workspace)
}

function quoteArg(value: string): string {
  return /\s/u.test(value) ? JSON.stringify(value) : value
}

export function buildSerenaLaunchArgs(
  config: SerenaBackendConfig,
  workspace: string,
): string[] {
  const args = [
    'start-mcp-server',
    '--context',
    config.context?.trim() || DEFAULT_CONTEXT,
  ]

  switch (config.projectMode ?? 'workspacePath') {
    case 'workspacePath':
      args.push('--project', workspace)
      break
    case 'projectFromCwd':
      args.push('--project-from-cwd')
      break
    case 'none':
      break
  }

  if (config.languageBackend) {
    args.push('--language-backend', config.languageBackend)
  }

  if (config.enableWebDashboard !== undefined) {
    args.push('--enable-web-dashboard', boolArg(config.enableWebDashboard))
  }

  args.push('--open-web-dashboard', boolArg(config.openWebDashboard ?? false))

  if (config.logLevel) {
    args.push('--log-level', config.logLevel)
  }

  for (const arg of config.extraArgs ?? []) {
    const trimmed = arg.trim()
    if (trimmed) args.push(replaceWorkspace(trimmed, workspace))
  }

  return args
}

export function buildSerenaLaunchPreview(
  config: SerenaBackendConfig,
  workspace: string,
): string {
  const command = config.command.trim() || 'serena'
  return [command, ...buildSerenaLaunchArgs(config, workspace)]
    .map(quoteArg)
    .join(' ')
}
