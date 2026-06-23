const MAX_PATCH_HUNKS = 100
const MAX_CHANGED_LINES = 10_000

export class TextPatchError extends Error {
  readonly code = 'INVALID_PATCH'

  constructor(message: string) {
    super(message)
    this.name = 'TextPatchError'
  }
}

interface ParsedHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
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
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
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

    if (
      hunk.oldLines.length !== hunk.oldCount ||
      hunk.newLines.length !== hunk.newCount
    ) {
      throw new TextPatchError('Patch hunk line counts do not match its header')
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
    const position = hunk.oldStart - 1 + offset
    const expectedNewPosition = hunk.newStart - 1

    if (position < 0 || position !== expectedNewPosition) {
      throw new TextPatchError('Patch hunk line numbers are inconsistent')
    }

    const actual = sourceLines.slice(position, position + hunk.oldLines.length)

    if (
      actual.length !== hunk.oldLines.length ||
      actual.some((line, lineIndex) => line !== hunk.oldLines[lineIndex])
    ) {
      throw new TextPatchError(
        `Patch context does not match at source line ${hunk.oldStart}`,
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
