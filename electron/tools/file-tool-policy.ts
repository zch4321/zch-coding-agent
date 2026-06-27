import type { PolicySignal } from '../../shared/agent-events'
import type { JsonValue } from '../../shared/json'
import type { ToolCall } from './types'
import type { FileOperation } from './file-tool-types'

export function argsObject(call: ToolCall): Record<string, JsonValue> {
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    throw new Error('Tool args must be an object')
  }

  return call.args
}

export function operationFor(toolId: string): FileOperation | undefined {
  if (toolId === 'create_file') {
    return 'write'
  }

  if (toolId === 'apply_patch') {
    return 'patch'
  }

  return toolId === 'delete_file' ? 'delete' : undefined
}

export function processPolicySignals(call: ToolCall): PolicySignal[] {
  if (call.toolId !== 'run_command') {
    return []
  }

  const args = argsObject(call)
  const shellMode = args.mode === 'shell'
  const command = shellMode
    ? String(args.command ?? '')
    : [
        String(args.executable ?? ''),
        ...(Array.isArray(args.args) ? args.args : []),
      ]
        .map(String)
        .join(' ')
  const signals: PolicySignal[] = [
    {
      code: shellMode ? 'shell_command' : 'process_spawn',
      severity: 'warning',
      detail: shellMode
        ? `Shell command delegated to the approval model: ${command.slice(0, 1_024)}`
        : `Spawn process: ${command.slice(0, 1_024)}`,
    },
  ]

  const dangerousPatterns: Array<[RegExp, string, string]> = [
    [
      /\brm\b(?=[^;&|\r\n]*(?:\s--recursive\b|\s-[a-z]*r[a-z]*\b))(?=[^;&|\r\n]*(?:\s--force\b|\s-[a-z]*f[a-z]*\b))/iu,
      'forced_recursive_delete',
      'Forced recursive rm deletion',
    ],
    [
      /\b(?:remove-item|ri|rm)\b(?=[^;&|\r\n]*\s-recurse\b)(?=[^;&|\r\n]*\s-force\b)/iu,
      'forced_recursive_delete',
      'Forced recursive PowerShell deletion',
    ],
    [
      /\b(?:del|erase|rmdir|rd)\b(?=[^&|\r\n]*\s\/s\b)(?=[^&|\r\n]*\s\/q\b)/iu,
      'forced_recursive_delete',
      'Quiet recursive Windows deletion',
    ],
    [
      /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*d|push\b)/iu,
      'destructive_git',
      'Destructive or remote Git operation',
    ],
    [
      /\b(?:npm|pnpm)\s+publish\b|\byarn\s+npm\s+publish\b|\bdocker\s+push\b/iu,
      'publish',
      'Package or image publication',
    ],
    [
      /\b(?:kubectl\s+(?:apply|delete)|terraform\s+(?:apply|destroy))\b/iu,
      'deployment',
      'Infrastructure mutation or deployment',
    ],
    [
      /\b(?:format|diskpart|wipefs|mkfs(?:\.\w+)?|clear-disk|initialize-disk)\b|\bdd\b[^\r\n]*\bof=\/dev\//iu,
      'disk_mutation',
      'Disk formatting or raw-device mutation',
    ],
  ]

  for (const [pattern, code, detail] of dangerousPatterns) {
    if (pattern.test(command)) {
      signals.push({
        code,
        severity: 'danger',
        detail,
      })
    }
  }

  return signals
}

export function filePolicySignals(
  operation: FileOperation,
  targetPath: string,
  before: string,
  after: string,
): PolicySignal[] {
  const signals: PolicySignal[] = []
  const changedBytes = Buffer.byteLength(before) + Buffer.byteLength(after)

  signals.push({
    code: `filesystem_${operation}`,
    severity: operation === 'delete' ? 'danger' : 'warning',
    detail: `${operation} ${targetPath}`,
  })

  if (changedBytes > 200_000) {
    signals.push({
      code: 'large_file_diff',
      severity: 'danger',
      detail: `The planned file diff covers ${changedBytes} bytes`,
    })
  }

  if (
    /(^|\/)(\.env(?:\.|$)|\.npmrc$|id_rsa$|[^/]+\.(?:pem|key)$)/iu.test(
      targetPath,
    )
  ) {
    signals.push({
      code: 'sensitive_file_path',
      severity: 'danger',
      detail: `The target path may contain credentials: ${targetPath}`,
    })
  }

  if (/(^|\/)\.git(?:\/|$)/iu.test(targetPath)) {
    signals.push({
      code: 'vcs_metadata_path',
      severity: 'danger',
      detail: `The target path mutates Git metadata: ${targetPath}`,
    })
  }

  return signals
}

/**
 * Deterministic policy signals for the dedicated git write tools. processPolicySignals
 * only inspects run_command strings, so git_add / git_commit / git_restore would
 * otherwise bypass the danger -> review gate even for amend / restore --hard.
 */
export function gitPolicySignals(call: ToolCall): PolicySignal[] {
  if (
    call.toolId !== 'git_add' &&
    call.toolId !== 'git_commit' &&
    call.toolId !== 'git_restore'
  ) {
    return []
  }

  const args = argsObject(call)
  const signals: PolicySignal[] = [
    {
      code: `vcs_${call.toolId.replace('git_', '')}`,
      severity: 'warning',
      detail: `${call.toolId} mutates git state`,
    },
  ]

  if (call.toolId === 'git_commit' && args.amend === true) {
    signals.push({
      code: 'git_amend',
      severity: 'danger',
      detail: 'git commit --amend rewrites history',
    })
  }

  if (call.toolId === 'git_restore' && args.staged !== true) {
    signals.push({
      code: 'git_restore_worktree',
      severity: 'danger',
      detail: 'git restore discards uncommitted working tree changes',
    })
  }

  if (call.toolId === 'git_add' && args.all === true) {
    signals.push({
      code: 'git_add_all',
      severity: 'warning',
      detail: 'git add -A stages every change in the workspace',
    })
  }

  return signals
}
