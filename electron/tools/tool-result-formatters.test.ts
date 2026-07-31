import { describe, expect, it } from 'vitest'
import { renderToolResultContent } from '../../shared/message'
import {
  projectDelayResult,
  projectFetchResult,
  projectFileMutationResult,
  projectGitResult,
  projectGlobResult,
  projectGrepResult,
  projectListDirResult,
  projectReadFileResult,
  projectReadSkillResult,
  projectRunCommandResult,
  projectSubagentResult,
  projectTerminalCloseResult,
  projectTerminalOpenResult,
  projectTerminalReadResult,
  projectTerminalResizeResult,
  projectTerminalSendResult,
  projectWebSearchResult,
} from './tool-result-formatters'
import type { SuccessfulToolResult, ToolModelContentPart } from './types'

function result(
  content: SuccessfulToolResult['content'],
  options: Pick<SuccessfulToolResult, 'truncated' | 'totalBytes'> = {},
): SuccessfulToolResult {
  return { status: 'ok', content, ...options }
}

function rendered(parts: ToolModelContentPart[]): string {
  return renderToolResultContent(parts)
}

describe('text Tool Result formatters', () => {
  it('formats read_file, grep, glob, and list_dir as compact text', () => {
    expect(
      rendered(
        projectReadFileResult(
          result(
            {
              content: '7\talpha\n8\tbeta',
              totalLines: 10,
              truncated: true,
              lineTruncated: false,
              nextStartLine: 9,
            },
            { truncated: true },
          ),
        ),
      ),
    ).toBe(
      '7\talpha\n8\tbeta\n\n[truncated=true; nextStartLine=9; totalLines=10; lineTruncated=false]',
    )
    expect(
      rendered(
        projectReadFileResult(result({ content: '', truncated: false })),
      ),
    ).toBe('[empty file]')
    expect(
      rendered(
        projectGrepResult(
          result({
            matches: [{ path: 'src/a.ts', line: 4, text: 'const value = 1' }],
            truncated: false,
          }),
        ),
      ),
    ).toBe('src/a.ts:4:const value = 1')
    expect(
      rendered(projectGrepResult(result({ matches: [], truncated: false }))),
    ).toBe('[no matches]')
    expect(
      rendered(
        projectGlobResult(
          result({ matches: ['src/a.ts', 'src/b.ts'], truncated: true }),
        ),
      ),
    ).toBe('src/a.ts\nsrc/b.ts\n\n[truncated=true]')
    expect(
      rendered(
        projectListDirResult(
          result({
            entries: [
              { path: 'src', type: 'directory' },
              { path: 'README.md', type: 'file' },
            ],
            truncated: false,
          }),
        ),
      ),
    ).toBe('src/\nREADME.md')
  })

  it('formats terminal output without repeating terminal IDs', () => {
    expect(
      rendered(
        projectTerminalOpenResult(
          result({ terminalId: 'terminal:opaque', cwd: '/tmp' }),
        ),
      ),
    ).toBe('Opened terminal terminal:opaque')
    expect(
      rendered(
        projectTerminalReadResult(
          result(
            {
              terminalId: 'terminal:opaque',
              content: 'test output',
              cursor: 42,
              truncated: true,
              totalBytes: 1_024,
            },
            { truncated: true, totalBytes: 1_024 },
          ),
        ),
      ),
    ).toBe('test output\n\n[cursor=42; truncated=true; totalBytes=1024]')
    expect(
      rendered(
        projectTerminalSendResult(result({ accepted: true, waitedMs: 250 })),
      ),
    ).toBe('Terminal input accepted after 250 ms')
    expect(rendered(projectTerminalCloseResult(result({ closed: true })))).toBe(
      'Terminal closed',
    )
    expect(
      rendered(projectTerminalResizeResult(result({ resized: true }))),
    ).toBe('Terminal resized')
  })

  it('formats process and Git streams with only necessary status metadata', () => {
    expect(
      rendered(
        projectRunCommandResult(
          result(
            {
              stdout: 'stdout body',
              stderr: 'warning',
              exitCode: 2,
              exitSignal: null,
              truncated: true,
            },
            { truncated: true, totalBytes: 2_048 },
          ),
        ),
      ),
    ).toBe(
      'stdout body\n\n[stderr]\nwarning\n\n[exitCode=2; truncated=true; totalBytes=2048]',
    )
    expect(
      rendered(
        projectGitResult(
          result({ stdout: '', stderr: '', exitCode: 0, truncated: false }),
          '[working tree clean]',
        ),
      ),
    ).toBe('[working tree clean]')
    expect(rendered(projectDelayResult(result({ waitedMs: 125 })))).toBe(
      'Waited 125 ms',
    )
  })

  it('formats fetch, search, skill, and subagent results', () => {
    expect(
      rendered(
        projectFetchResult(
          result({
            status: 200,
            contentType: 'text/plain',
            url: 'https://example.test/final',
            body: 'hello',
            truncated: false,
          }),
        ),
      ),
    ).toBe('HTTP 200 text/plain https://example.test/final\nhello')
    expect(
      rendered(
        projectWebSearchResult(
          result({
            query: 'ignored',
            results: [
              {
                title: 'Example',
                url: 'https://example.test',
                snippet: 'A result.',
              },
            ],
          }),
        ),
      ),
    ).toBe('1. Example\nhttps://example.test\nA result.')
    expect(
      rendered(
        projectReadSkillResult(
          result({ name: 'fixture', body: 'Skill body', source: 'ignored' }),
        ),
      ),
    ).toBe('Skill body')
    expect(
      rendered(
        projectSubagentResult(
          result({
            results: { review: 'Final finding' },
            meta: { provider: 'hidden', truncated: true },
          }),
          'review',
        ),
      ),
    ).toBe('Final finding\n\n[truncated=true]')
  })

  it('preserves durable file-change warnings in one-line mutation summaries', () => {
    expect(
      rendered(
        projectFileMutationResult(
          result({
            path: 'src/app.ts',
            operation: 'patch',
            mutationSucceeded: true,
            warningCode: 'CHANGE_HISTORY_PERSIST_FAILED',
            revertAvailable: false,
          }),
          'patched',
        ),
      ),
    ).toBe(
      'Patched file src/app.ts\n\n[mutationSucceeded=true; warningCode=CHANGE_HISTORY_PERSIST_FAILED; revertAvailable=false]',
    )
  })
})
