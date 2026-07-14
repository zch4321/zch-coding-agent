import { execFileSync } from 'node:child_process'

export function sourceCommitDefine(): Record<string, string> {
  const sourceCommit =
    process.env.ZCH_SOURCE_COMMIT?.trim() || readGitSourceCommit()
  const sourceTreeState =
    process.env.ZCH_SOURCE_TREE_STATE?.trim() || readGitTreeState()
  return {
    __ZCH_SOURCE_COMMIT__: JSON.stringify(sourceCommit),
    __ZCH_SOURCE_TREE_STATE__: JSON.stringify(sourceTreeState),
  }
}

function readGitTreeState(): 'clean' | 'dirty' | 'unknown' {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return status ? 'dirty' : 'clean'
  } catch {
    return 'unknown'
  }
}

function readGitSourceCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'development'
  }
}
