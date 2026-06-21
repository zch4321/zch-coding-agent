import { MAX_DIFF_CHARS } from './file-tool-limits'

function truncateDiff(value: string): string {
  if (value.length <= MAX_DIFF_CHARS) {
    return value
  }

  return `${value.slice(0, MAX_DIFF_CHARS)}\n... diff truncated ...\n`
}

export function createFileDiff(
  filePath: string,
  before: string,
  after: string,
): string {
  const oldLines = before.split(/\r?\n/)
  const newLines = after.split(/\r?\n/)
  const body = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n')

  return truncateDiff(`${body}\n`)
}
