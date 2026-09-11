import type { RunId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { MessageRecord } from '../../shared/message'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  CONTEXT_CATEGORIES,
  type ContextCategory,
  type SessionContextSnapshot,
} from '../../shared/session-usage'
import { projectContextUsage } from '../providers/context-usage-projection'
import type { CompiledProviderCall } from '../providers/provider'
import type { ContextToolUsage } from '../usage/contracts'
import { canonicalHash, MessageHistoryCompiler } from './canonical-history'

export interface ContextUsageRecipe {
  runId: RunId
  route: ModelRouteSnapshot
  tools: ContextToolUsage
}

/** Measures the actual compiled tool schemas without retaining their contents. */
export function measureContextTools(
  compiled: CompiledProviderCall,
): ContextUsageRecipe['tools'] {
  const tools = Array.isArray(compiled.request.tools)
    ? compiled.request.tools
    : []
  const entries = tools.map((tool, index) => ({
    id: compiled.tools[index]?.name ?? `tool:${index}`,
    kind: 'tool_definition',
    source: compiled.tools[index]?.name,
    bytes: jsonBytes(tool),
  }))
  return {
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    count: entries.length,
    entries: entries.slice(0, 100),
  }
}

/** Measures serialized UTF-8 bytes of valid context contributions and keeps bounded source entries. */
export function buildContextUsage(
  records: readonly MessageRecord[],
  recipe: ContextUsageRecipe,
): SessionContextSnapshot {
  const history = new MessageHistoryCompiler().compile(records)
  const categories: SessionContextSnapshot['categories'] =
    CONTEXT_CATEGORIES.map((category) => ({
      category,
      bytes: 0,
      count: 0,
      entries: [],
    }))
  const add = (
    category: ContextCategory,
    record: MessageRecord,
    value: JsonValue,
  ) => {
    const group = categories.find((group) => group.category === category)!
    const bytes = jsonBytes(value)
    group.bytes += bytes
    group.count += 1
    const source =
      (category === 'toolCalls'
        ? record.parts
            .flatMap((part) => (part.type === 'tool_call' ? [part.name] : []))
            .join(', ')
        : undefined) ??
      (record.metadata && 'layer' in record.metadata
        ? record.metadata.layer?.source
        : undefined) ??
      (record.kind === 'tool_result' ? record.metadata?.tool.name : undefined)
    group.entries.push({
      id: record.id,
      kind: record.kind,
      seq: record.seq,
      bytes,
      ...(source ? { source: source.slice(0, 512) } : {}),
    })
    if (group.entries.length > 100) group.entries.shift()
  }
  for (const record of history.messages) {
    const projected = projectContextUsage(record, recipe.route)
    if (projected.content !== undefined)
      add(categoryFor(record), record, projected.content)
    if (projected.calls.length) add('toolCalls', record, projected.calls)
  }

  const tools = categories.find(
    (group) => group.category === 'toolDefinitions',
  )!
  Object.assign(tools, structuredClone(recipe.tools))
  return {
    runId: recipe.runId,
    providerId: recipe.route.providerId,
    model: recipe.route.model,
    sourceHash: canonicalHash({ history: history.messages, recipe }),
    totalBytes: categories.reduce((sum, group) => sum + group.bytes, 0),
    categories,
    updatedAt: new Date().toISOString(),
  }
}

function jsonBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function categoryFor(record: MessageRecord): ContextCategory {
  switch (record.kind) {
    case 'system_instruction':
    case 'assistant_preferences':
    case 'agents_context':
      return 'system'
    case 'user_input':
    case 'interjection':
    case 'selected_context':
      return 'user'
    case 'assistant_turn':
      return 'assistant'
    case 'tool_result':
      return 'toolResults'
    default:
      return 'orchestration'
  }
}
