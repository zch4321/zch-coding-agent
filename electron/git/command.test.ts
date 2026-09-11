import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { GitReviewService } from '../application/git-review-service'
import { runCommand, type RunCommandResult } from '../process/run'
import { registerGitReadOnlyTools } from '../tools/git-tools'
import { ToolRegistry } from '../tooling/registry'
import type { ToolExecutionContext } from '../tooling/contracts'
import * as git from './command'

vi.mock('../process/run', () => ({ runCommand: vi.fn() }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

const result: RunCommandResult = {
  stdout: 'partial',
  stderr: '',
  exitCode: 0,
  exitSignal: null,
  cancelled: false,
  timedOut: false,
  durationMs: 15,
  cwd: process.cwd(),
  terminationStrategy: 'none',
  artifactAvailable: false,
  truncated: false,
  totalBytes: 7,
  stdoutBytes: 7,
  stderrBytes: 0,
  discardedHash: '',
}

function tools() {
  const registry = new ToolRegistry()
  registerGitReadOnlyTools(registry, () =>
    toPublicConfig(DEFAULT_APP_CONFIG, false),
  )
  const context = {
    workspace: { canonicalPath: process.cwd() },
    signal: new AbortController().signal,
  } as ToolExecutionContext
  return { registry, context }
}

describe('shared Git command boundary', () => {
  it.each(['diff', 'show'])(
    'disables external output helpers for %s and preserves argument boundaries',
    (subcommand) => {
      const args = [subcommand, 'HEAD', '--', 'file with spaces.txt']
      const command = git.createGitCommand(args)
      expect(command).toMatchObject({ mode: 'process', executable: 'git' })
      expect(command.args).toEqual([
        '--no-pager',
        '--no-optional-locks',
        '-c',
        'core.pager=',
        '-c',
        'color.ui=never',
        subcommand,
        '--no-ext-diff',
        '--no-textconv',
        'HEAD',
        '--',
        'file with spaces.txt',
      ])
      command.args!.push('later')
      expect(git.createGitCommand(args).args).not.toContain('later')
    },
  )

  it('routes model tools and UI queries through the same builder', async () => {
    const build = vi.spyOn(git, 'createGitCommand')
    const { registry, context } = tools()
    vi.mocked(runCommand).mockResolvedValue(result)
    await registry
      .get('git_diff')!
      .execute({ paths: ['file with spaces.txt'] }, context)
    expect(build).toHaveBeenCalledWith(['diff', '--', 'file with spaces.txt'])
    vi.mocked(runCommand).mockResolvedValue({
      ...result,
      exitCode: 1,
      stderr: 'not a git repository',
    })
    await expect(
      new GitReviewService().getStatus(process.cwd()),
    ).resolves.toMatchObject({ repository: false })
    expect(build).toHaveBeenLastCalledWith(['rev-parse', '--show-toplevel'])
  })

  it.each([
    ['cancelled', 'CANCELLED', 'cancelled'],
    ['timedOut', 'PRECONDITION_FAILED', 'timeout'],
  ] as const)(
    'does not parse %s output as success in either consumer',
    async (flag, code, status) => {
      vi.mocked(runCommand).mockResolvedValue({ ...result, [flag]: true })
      await expect(
        new GitReviewService().getStatus(process.cwd()),
      ).rejects.toMatchObject({ code })
      const { registry, context } = tools()
      expect(
        await registry.get('git_status')!.execute({}, context),
      ).toMatchObject({ status })
    },
  )
})
