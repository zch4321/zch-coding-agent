import type { PublicConfig } from '../../shared/config'
import type { PolicySignal } from '../../shared/agent-events'
import type { JsonValue } from '../../shared/json'
import type { ToolCall, ToolResult } from '../tools/types'
import { matchesGlob } from '../tools/glob'

export type IngressDecision =
  | { action: 'allow'; signals: PolicySignal[] }
  | { action: 'warn'; signals: PolicySignal[] }
  | {
      action: 'confirm'
      signals: PolicySignal[]
      summary: string
      sanitizedResult: ToolResult
    }

interface EvaluationInput {
  call: ToolCall
  result: ToolResult
}

export type IngressPathDecision =
  | { action: 'allow'; signals: PolicySignal[] }
  | { action: 'warn'; signals: PolicySignal[] }
  | { action: 'confirm'; signals: PolicySignal[]; summary: string }

function resultText(value: JsonValue): string {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function collectPathCandidates(call: ToolCall, result: ToolResult): string[] {
  const paths = new Set<string>()

  if (
    call.args &&
    typeof call.args === 'object' &&
    !Array.isArray(call.args) &&
    typeof call.args.path === 'string'
  ) {
    paths.add(call.args.path)
  }

  if (result.status !== 'ok') {
    return [...paths]
  }

  const stack: JsonValue[] = [result.content]

  while (stack.length > 0) {
    const current = stack.pop()

    if (!current || typeof current !== 'object') {
      continue
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        stack.push(item)
      }
      continue
    }

    if (typeof current.path === 'string') {
      paths.add(current.path)
    }

    for (const value of Object.values(current)) {
      stack.push(value)
    }
  }

  return [...paths]
}

function safePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'iu')
  } catch {
    return undefined
  }
}

function summarize(result: ToolResult): string {
  if (result.status !== 'ok') {
    return result.message
  }

  const text = resultText(result.content)
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text
}

export class ContextIngressFilter {
  evaluatePath(
    config: PublicConfig['permission']['sensitiveData'],
    call: ToolCall,
  ): IngressPathDecision {
    if (config.mode === 'off') {
      return { action: 'allow', signals: [] }
    }

    const paths = collectPathCandidates(call, {
      status: 'denied',
      message: 'Path preflight',
    })
    const signals: PolicySignal[] = []

    for (const pattern of config.pathGlobs) {
      const matches = paths.filter((candidate) =>
        matchesGlob(pattern, candidate),
      )

      if (matches.length > 0) {
        signals.push({
          code: 'sensitive_path',
          severity: config.mode === 'confirm' ? 'danger' : 'warning',
          detail: `Matched ${pattern}: ${matches.slice(0, 5).join(', ')}`,
        })
      }
    }

    if (signals.length === 0) {
      return { action: 'allow', signals }
    }

    return config.mode === 'confirm'
      ? {
          action: 'confirm',
          signals,
          summary: `The tool will read sensitive path(s): ${paths.join(', ')}`,
        }
      : { action: 'warn', signals }
  }

  evaluate(
    config: PublicConfig['permission']['sensitiveData'],
    input: EvaluationInput,
    options: { includePaths?: boolean } = {},
  ): IngressDecision {
    if (config.mode === 'off' || input.result.status !== 'ok') {
      return { action: 'allow', signals: [] }
    }

    const signals: PolicySignal[] = []
    if (options.includePaths !== false) {
      const pathDecision = this.evaluatePath(config, input.call)
      signals.push(...pathDecision.signals)
    }

    const text = resultText(input.result.content)

    for (const pattern of config.contentPatterns) {
      const regexp = safePattern(pattern)

      if (regexp?.test(text)) {
        signals.push({
          code: 'sensitive_content',
          severity: config.mode === 'confirm' ? 'danger' : 'warning',
          detail: `Matched content pattern: ${pattern}`,
        })
      }
    }

    if (signals.length === 0) {
      return { action: 'allow', signals: [] }
    }

    if (config.mode === 'warn') {
      return { action: 'warn', signals }
    }

    return {
      action: 'confirm',
      signals,
      summary: summarize(input.result),
      sanitizedResult: {
        status: 'denied',
        message:
          'Tool result was withheld from the provider by Context Ingress confirmation',
      },
    }
  }
}
