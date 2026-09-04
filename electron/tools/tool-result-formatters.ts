import type { JsonObject, JsonValue } from '../../shared/json'
import type { SuccessfulToolResult, ToolModelContentPart } from './types'

const NO_OUTPUT = '[no output]'

function objectContent(result: SuccessfulToolResult): JsonObject {
  return result.content &&
    typeof result.content === 'object' &&
    !Array.isArray(result.content)
    ? result.content
    : {}
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function booleanValue(value: JsonValue | undefined): boolean {
  return value === true
}

function textPart(text: string): ToolModelContentPart[] {
  return [{ type: 'text', text: text || NO_OUTPUT }]
}

function appendFooter(body: string, fields: readonly string[]): string {
  const footer = fields.filter(Boolean).join('; ')
  if (!footer) return body || NO_OUTPUT
  return `${body || NO_OUTPUT}\n\n[${footer}]`
}

function listedPaths(
  values: JsonValue | undefined,
  emptyMessage: string,
): string {
  if (!Array.isArray(values) || values.length === 0) return emptyMessage
  return values
    .map((value) => {
      if (typeof value === 'string') return value
      if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
      const path = stringValue(value.path)
      if (!path) return ''
      return value.type === 'directory' && !path.endsWith('/')
        ? `${path}/`
        : path
    })
    .filter(Boolean)
    .join('\n')
}

/** Projects read_file to its numbered body plus continuation metadata. */
export function projectReadFileResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const body = stringValue(content.content) || '[empty file]'
  const hasMore =
    booleanValue(content.hasMore) ||
    booleanValue(content.truncated) ||
    result.truncated === true
  const nextStartLine = numberValue(content.nextStartLine)
  const nextStartCharacter = numberValue(content.nextStartCharacter)
  const totalLines = numberValue(content.totalLines)
  if (!hasMore && nextStartLine === undefined) {
    return textPart(body)
  }
  const fields = [
    `hasMore=${String(hasMore)}`,
    ...(nextStartLine === undefined ? [] : [`nextStartLine=${nextStartLine}`]),
    ...(nextStartCharacter === undefined
      ? []
      : [`nextStartCharacter=${nextStartCharacter}`]),
    ...(totalLines === undefined ? [] : [`totalLines=${totalLines}`]),
    ...(booleanValue(content.lineTruncated) ? ['lineTruncated=true'] : []),
    ...(booleanValue(content.tailClipped) ? ['tailClipped=true'] : []),
  ]
  return textPart(appendFooter(body, fields))
}

/** Projects list_dir to one workspace-relative path per line. */
export function projectListDirResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const body = listedPaths(content.entries, '[empty directory]')
  return textPart(
    appendFooter(
      body,
      booleanValue(content.truncated) || result.truncated === true
        ? ['truncated=true']
        : [],
    ),
  )
}

/** Projects glob to one matching workspace-relative path per line. */
export function projectGlobResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const body = listedPaths(content.matches, '[no matches]')
  return textPart(
    appendFooter(
      body,
      booleanValue(content.truncated) || result.truncated === true
        ? ['truncated=true']
        : [],
    ),
  )
}

/** Projects grep matches in ripgrep-compatible path:line:text form. */
export function projectGrepResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const matches = Array.isArray(content.matches) ? content.matches : []
  const body =
    matches
      .map((match) => {
        if (!match || typeof match !== 'object' || Array.isArray(match)) {
          return ''
        }
        const path = stringValue(match.path)
        const line = numberValue(match.line)
        const text = stringValue(match.text)
        return path && line !== undefined ? `${path}:${line}:${text}` : ''
      })
      .filter(Boolean)
      .join('\n') || '[no matches]'
  return textPart(
    appendFooter(
      body,
      booleanValue(content.truncated) || result.truncated === true
        ? ['truncated=true']
        : [],
    ),
  )
}

/** Projects terminal_open to the process-local numeric target used by later calls. */
export function projectTerminalOpenResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const terminalId = numberValue(content.terminalId)
  const artifactPath = stringValue(content.artifactPath)
  return textPart(
    appendFooter(
      terminalId !== undefined
        ? `Opened terminal ${terminalId}`
        : 'Terminal opened',
      [
        ...(terminalId === undefined
          ? []
          : [`target={"type":"terminal","id":${terminalId}}`]),
        ...(artifactPath ? [`artifactPath=${artifactPath}`] : []),
        ...(content.artifactAvailable === false
          ? [
              'artifactAvailable=false',
              `captureError=${stringValue(content.captureError) || 'unknown'}`,
            ]
          : []),
      ],
    ),
  )
}

/** Projects terminal_send to a compact acknowledgement. */
export function projectTerminalSendResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const accepted = content.accepted === true
  const waitedMs = numberValue(content.waitedMs)
  const output = stringValue(content.content)
  const artifactPath = stringValue(content.artifactPath)
  return textPart(
    appendFooter(
      output || (accepted ? '[no new output]' : '[input rejected]'),
      [
        accepted ? 'accepted=true' : 'accepted=false',
        ...(waitedMs === undefined ? [] : [`waitedMs=${waitedMs}`]),
        `cursor=${numberValue(content.cursor) ?? 0}`,
        `delta=${String(booleanValue(content.delta))}`,
        ...(artifactPath ? [`artifactPath=${artifactPath}`] : []),
        ...(content.artifactAvailable === false
          ? [
              'artifactAvailable=false',
              `captureError=${stringValue(content.captureError) || 'unknown'}`,
            ]
          : []),
      ],
    ),
  )
}

/** Projects terminal_read to raw output and the cursor needed for pagination. */
export function projectTerminalReadResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const cursor = numberValue(content.cursor)
  const truncated = booleanValue(content.truncated) || result.truncated === true
  const totalBytes =
    numberValue(content.totalBytes) ?? result.totalBytes ?? undefined
  return textPart(
    appendFooter(stringValue(content.content), [
      `cursor=${cursor ?? 0}`,
      ...(truncated ? ['truncated=true'] : []),
      ...(truncated && totalBytes !== undefined
        ? [`totalBytes=${totalBytes}`]
        : []),
    ]),
  )
}

/** Projects terminal_close to a compact acknowledgement. */
export function projectTerminalCloseResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  return textPart(
    objectContent(result).closed === true
      ? 'Terminal closed'
      : 'Terminal was already closed',
  )
}

/** Projects run_command to stdout, optional stderr, and exceptional status. */
export function projectRunCommandResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const stdout = stringValue(content.stdout)
  const stderr = stringValue(content.stderr)
  const exitCode = numberValue(content.exitCode)
  const exitSignal = stringValue(content.exitSignal)
  const artifactPath = stringValue(content.artifactPath)
  const truncated = booleanValue(content.truncated) || result.truncated === true
  let body = stdout
  if (stderr) {
    body = `${body ? `${body}\n\n` : ''}[stderr]\n${stderr}`
  }
  return textPart(
    appendFooter(body || '[command completed with no output]', [
      ...(exitCode !== undefined && exitCode !== 0
        ? [`exitCode=${exitCode}`]
        : []),
      ...(exitSignal ? [`signal=${exitSignal}`] : []),
      ...(truncated ? ['truncated=true'] : []),
      ...(truncated && result.totalBytes !== undefined
        ? [`totalBytes=${result.totalBytes}`]
        : []),
      ...(artifactPath ? [`artifactPath=${artifactPath}`] : []),
      ...(content.artifactAvailable === false
        ? [
            'artifactAvailable=false',
            `captureError=${stringValue(content.captureError) || 'unknown'}`,
          ]
        : []),
    ]),
  )
}

/** Projects delay to a one-line acknowledgement. */
export function projectDelayResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const waitedMs = numberValue(objectContent(result).waitedMs)
  return textPart(
    waitedMs === undefined ? 'Delay completed' : `Waited ${waitedMs} ms`,
  )
}

/** Projects Git command output without repeating the internal process object. */
export function projectGitResult(
  result: SuccessfulToolResult,
  emptyMessage: string,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const stdout = stringValue(content.stdout)
  const stderr = stringValue(content.stderr)
  const truncated = booleanValue(content.truncated) || result.truncated === true
  let body = stdout
  if (stderr) {
    body = `${body ? `${body}\n\n` : ''}[stderr]\n${stderr}`
  }
  return textPart(
    appendFooter(body || emptyMessage, [
      ...(truncated ? ['truncated=true'] : []),
      ...(truncated && result.totalBytes !== undefined
        ? [`totalBytes=${result.totalBytes}`]
        : []),
    ]),
  )
}

/** Projects fetch to one response header line followed by its body. */
export function projectFetchResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const status = numberValue(content.status)
  const contentType = stringValue(content.contentType) || 'unknown'
  const url = stringValue(content.url)
  const header = `HTTP ${status ?? 'unknown'} ${contentType}${url ? ` ${url}` : ''}`
  const body = stringValue(content.body)
  const truncated = booleanValue(content.truncated) || result.truncated === true
  return textPart(
    appendFooter(`${header}${body ? `\n${body}` : ''}`, [
      ...(truncated ? ['truncated=true'] : []),
      ...(truncated && result.totalBytes !== undefined
        ? [`totalBytes=${result.totalBytes}`]
        : []),
      ...(stringValue(content.artifactPath)
        ? [`artifactPath=${stringValue(content.artifactPath)}`]
        : []),
      ...(content.artifactAvailable === false
        ? [
            'artifactAvailable=false',
            `captureError=${stringValue(content.captureError) || 'unknown'}`,
          ]
        : []),
    ]),
  )
}

/** Projects web_search to numbered title, URL, and snippet blocks. */
export function projectWebSearchResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const values = content.results
  const results = Array.isArray(values) ? values : []
  const body = results
    .map((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return ''
      }
      return [
        `${index + 1}. ${stringValue(value.title) || '[untitled]'}`,
        stringValue(value.url),
        stringValue(value.snippet),
      ]
        .filter(Boolean)
        .join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
  return textPart(
    appendFooter(body || '[no results]', [
      ...(stringValue(content.artifactPath)
        ? [`artifactPath=${stringValue(content.artifactPath)}`]
        : []),
      ...(content.artifactAvailable === false
        ? [
            'artifactAvailable=false',
            `captureError=${stringValue(content.captureError) || 'unknown'}`,
          ]
        : []),
    ]),
  )
}

/** Projects read_skill to the skill instruction body only. */
export function projectReadSkillResult(
  result: SuccessfulToolResult,
): ToolModelContentPart[] {
  return textPart(stringValue(objectContent(result).body))
}

/** Projects subagent_run to the named child's final answer only. */
export function projectSubagentResult(
  result: SuccessfulToolResult,
  name: string,
): ToolModelContentPart[] {
  const content = objectContent(result)
  const results =
    content.results &&
    typeof content.results === 'object' &&
    !Array.isArray(content.results)
      ? content.results
      : {}
  const meta =
    content.meta &&
    typeof content.meta === 'object' &&
    !Array.isArray(content.meta)
      ? content.meta
      : {}
  return textPart(
    appendFooter(stringValue(results[name]), [
      ...(meta.truncated === true ? ['truncated=true'] : []),
    ]),
  )
}

/** Projects a successful file mutation to one compact operation summary. */
export function projectFileMutationResult(
  result: SuccessfulToolResult,
  action: 'written' | 'patched' | 'deleted',
): ToolModelContentPart[] {
  const content = objectContent(result)
  const path = stringValue(content.path) || '[unknown path]'
  const verb =
    action === 'written'
      ? 'Wrote file'
      : action === 'patched'
        ? 'Patched file'
        : 'Deleted file'
  const deleted = action === 'deleted' ? content.deleted === true : undefined
  return textPart(
    action === 'deleted' && !deleted
      ? `File was already absent ${path}`
      : `${verb} ${path}`,
  )
}
