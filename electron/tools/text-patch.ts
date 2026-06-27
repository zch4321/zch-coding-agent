const MAX_PATCH_HUNKS = 100
const MAX_CHANGED_LINES = 10_000
const PATCH_ERROR_CONTEXT_LINES = 8

export class TextPatchError extends Error {
  readonly code = 'INVALID_PATCH'

  constructor(message: string) {
    super(message)
    this.name = 'TextPatchError'
  }
}

interface ParsedHunk {
  oldStart: number
  oldLines: string[]
  newLines: string[]
  addedLines: number
  removedLines: number
}

export interface AppliedTextPatch {
  content: string
  hunks: number
  addedLines: number
  removedLines: number
}

function normalizedHeaderPath(value: string): string {
  const withoutTimestamp = value.split(/\t/u, 1)[0].trim()

  if (withoutTimestamp === '/dev/null') {
    throw new TextPatchError('File creation and deletion are not supported')
  }

  const portable = withoutTimestamp.replaceAll('\\', '/')
  return portable.startsWith('a/') || portable.startsWith('b/')
    ? portable.slice(2)
    : portable
}

function assertHeaderPath(header: string, expectedPath: string): void {
  if (normalizedHeaderPath(header.slice(4)) !== expectedPath) {
    throw new TextPatchError('Patch header path does not match the tool path')
  }
}

function parsePatch(patch: string, expectedPath: string): ParsedHunk[] {
  const lines = patch.replaceAll('\r\n', '\n').split('\n')

  if (lines.at(-1) === '') {
    lines.pop()
  }

  let index = 0

  if (lines[index]?.startsWith('diff --git ')) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(lines[index])

    if (!match || match[1] !== expectedPath || match[2] !== expectedPath) {
      throw new TextPatchError('Patch contains a different file path')
    }
    index += 1
  }

  while (lines[index]?.startsWith('index ')) {
    index += 1
  }

  if (lines[index]?.startsWith('--- ')) {
    assertHeaderPath(lines[index], expectedPath)
    index += 1

    if (!lines[index]?.startsWith('+++ ')) {
      throw new TextPatchError('Patch is missing the new-file header')
    }

    assertHeaderPath(lines[index], expectedPath)
    index += 1
  }

  const hunks: ParsedHunk[] = []
  let changedLines = 0

  while (index < lines.length) {
    const header = lines[index]

    if (
      header.startsWith('Binary files ') ||
      header.startsWith('rename ') ||
      header.includes(' file mode ')
    ) {
      throw new TextPatchError(
        'Binary, rename and mode changes are not supported',
      )
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(
      header,
    )

    if (!match) {
      throw new TextPatchError(`Invalid patch hunk header: ${header}`)
    }

    const hunk: ParsedHunk = {
      oldStart: Number(match[1]),
      oldLines: [],
      newLines: [],
      addedLines: 0,
      removedLines: 0,
    }
    index += 1

    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index]
      const marker = line[0]
      const content = line.slice(1)

      if (marker === ' ') {
        hunk.oldLines.push(content)
        hunk.newLines.push(content)
      } else if (marker === '-') {
        hunk.oldLines.push(content)
        hunk.removedLines += 1
      } else if (marker === '+') {
        hunk.newLines.push(content)
        hunk.addedLines += 1
      } else if (line === '\\ No newline at end of file') {
        throw new TextPatchError('Changing the final newline is not supported')
      } else {
        throw new TextPatchError(`Invalid patch line: ${line}`)
      }
      index += 1
    }

    changedLines += hunk.addedLines + hunk.removedLines
    hunks.push(hunk)

    if (hunks.length > MAX_PATCH_HUNKS || changedLines > MAX_CHANGED_LINES) {
      throw new TextPatchError('Patch exceeds the hunk or changed-line limit')
    }
  }

  if (hunks.length === 0) {
    throw new TextPatchError('Patch must contain at least one hunk')
  }

  return hunks
}

function matchingSequenceAt(
  sourceLines: string[],
  start: number,
  expected: string[],
): boolean {
  return (
    start >= 0 &&
    sourceLines.length - start >= expected.length &&
    expected.every((line, index) => sourceLines[start + index] === line)
  )
}

function findUniqueSequence(
  sourceLines: string[],
  expected: string[],
):
  | { kind: 'none' }
  | { kind: 'unique'; position: number }
  | { kind: 'multiple' } {
  if (expected.length === 0) {
    return { kind: 'none' }
  }

  let found: number | undefined

  for (
    let index = 0;
    index <= sourceLines.length - expected.length;
    index += 1
  ) {
    if (!matchingSequenceAt(sourceLines, index, expected)) {
      continue
    }

    if (found !== undefined) {
      return { kind: 'multiple' }
    }

    found = index
  }

  return found === undefined
    ? { kind: 'none' }
    : { kind: 'unique', position: found }
}

function formatPatchPreview(lines: string[], startLine: number): string {
  const preview = lines.slice(0, PATCH_ERROR_CONTEXT_LINES)
  const suffix =
    lines.length > preview.length
      ? [`... ${lines.length - preview.length} more line(s)`]
      : []

  return [...preview, ...suffix]
    .map((line, index) => `${startLine + index}\t${line}`)
    .join('\n')
}

export function applyTextPatch(
  source: string,
  patch: string,
  expectedPath: string,
): AppliedTextPatch {
  const hunks = parsePatch(patch, expectedPath)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const normalized = source.replaceAll('\r\n', '\n')
  const finalNewline = normalized.endsWith('\n')
  const sourceLines = normalized.split('\n')

  if (finalNewline) {
    sourceLines.pop()
  }

  let offset = 0
  let addedLines = 0
  let removedLines = 0

  for (const hunk of hunks) {
    let position = hunk.oldStart - 1 + offset

    if (position < 0) {
      throw new TextPatchError('Patch hunk line numbers are inconsistent')
    }

    if (!matchingSequenceAt(sourceLines, position, hunk.oldLines)) {
      const match = findUniqueSequence(sourceLines, hunk.oldLines)

      if (match.kind === 'unique') {
        position = match.position
      } else if (match.kind === 'multiple') {
        throw new TextPatchError(
          [
            'Patch context matches multiple locations; provide more unchanged context lines.',
            'Expected context:',
            formatPatchPreview(hunk.oldLines, hunk.oldStart),
          ].join('\n'),
        )
      }
    }

    if (!matchingSequenceAt(sourceLines, position, hunk.oldLines)) {
      const actualStart = Math.max(0, position)
      const actual = sourceLines.slice(
        actualStart,
        actualStart + Math.max(hunk.oldLines.length, 1),
      )
      throw new TextPatchError(
        [
          `Patch context does not match at source line ${hunk.oldStart}.`,
          'Expected context:',
          formatPatchPreview(hunk.oldLines, hunk.oldStart),
          'Actual content near requested line:',
          formatPatchPreview(actual, actualStart + 1),
          'If the target text moved, include more unchanged context lines around the edit.',
        ].join('\n'),
      )
    }

    sourceLines.splice(position, hunk.oldLines.length, ...hunk.newLines)
    offset += hunk.newLines.length - hunk.oldLines.length
    addedLines += hunk.addedLines
    removedLines += hunk.removedLines
  }

  const content = `${sourceLines.join(newline)}${finalNewline ? newline : ''}`

  return {
    content,
    hunks: hunks.length,
    addedLines,
    removedLines,
  }
}
