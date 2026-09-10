import type { TokenEstimationConfig } from '../../shared/config/runtime'
import type { RunId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { MessageRecord } from '../../shared/message'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import {
  CONTEXT_CATEGORIES,
  type ContextCategory,
  type ContextEntry,
  type SessionContextSnapshot,
} from '../../shared/session-usage'
import { projectContextUsage } from '../providers/context-usage-projection'
import type { CompiledProviderCall } from '../providers/provider'
import { estimateJsonTokens } from '../tooling/output-budget'
import { canonicalHash, MessageHistoryCompiler } from './canonical-history'

export interface ContextUsageRecipe {
  runId: RunId
  route: ModelRouteSnapshot
  contextWindowTokens: number
  estimation: TokenEstimationConfig
  tools: { tokens: number; count: number; entries: ContextEntry[] }
}

/** Measures the actual compiled tool schemas without retaining their contents. */
export function measureContextTools(
  compiled: CompiledProviderCall,
  estimation: TokenEstimationConfig,
): ContextUsageRecipe['tools'] {
  const tools = Array.isArray(compiled.request.tools)
    ? compiled.request.tools
    : []
  const entries = tools.map((tool, index) => ({
    id: compiled.tools[index]?.name ?? `tool:${index}`,
    kind: 'tool_definition',
    source: compiled.tools[index]?.name,
    tokens: estimateJsonTokens(tool, estimation),
  }))
  return {
    tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
    count: entries.length,
    entries: entries.slice(0, 100),
  }
}

/** Builds bounded source entries from valid active history using the same pure Provider projections. */
export function buildContextUsage(
  records: readonly MessageRecord[],
  recipe: ContextUsageRecipe,
): SessionContextSnapshot {
  const history = new MessageHistoryCompiler().compile(records)
  const categories: SessionContextSnapshot['categories'] =
    CONTEXT_CATEGORIES.map((category) => ({
      category,
      tokens: 0,
      count: 0,
      entries: [],
    }))
  const add = (
    category: ContextCategory,
    record: MessageRecord,
    value: JsonValue,
  ) => {
    const group = categories.find((group) => group.category === category)!
    const tokens = estimateJsonTokens(value, recipe.estimation)
    group.tokens += tokens
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
      tokens,
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
    contextWindowTokens: recipe.contextWindowTokens,
    sourceHash: canonicalHash({ history: history.messages, recipe }),
    estimatedTokens: categories.reduce((sum, group) => sum + group.tokens, 0),
    categories,
    updatedAt: new Date().toISOString(),
  }
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
