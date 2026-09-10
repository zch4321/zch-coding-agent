import type { JsonObject, JsonValue } from '../../shared/json'
import type { MessageRecord } from '../../shared/message'
import type { ModelRouteSnapshot } from '../../shared/model-route'
import { compileChatMessages } from './chat-completions-shared'
import { compileAnthropicHistory } from './generic-anthropic-provider'
import { compileResponseInput } from './generic-responses-provider'

/** Separates model-visible content and tool calls while keeping native protocol fields inside Providers. */
export function projectContextUsage(
  record: MessageRecord,
  route: ModelRouteSnapshot,
): {
  content?: JsonValue
  calls: JsonValue[]
} {
  const single = {
    sessionId: record.sessionId,
    messages: [record],
    sourceHash: '',
  }
  let items: JsonObject[]
  if (route.providerType === 'generic.responses') {
    const projected = compileResponseInput(single, route)
    if (projected.instructions)
      return { content: projected.instructions, calls: [] }
    items = projected.items
  } else if (route.providerType === 'generic.anthropic') {
    const projected = compileAnthropicHistory(single, route)
    if (projected.system) return { content: projected.system, calls: [] }
    items = projected.messages
  } else if (
    route.providerType === 'deepseek.chat-completions' ||
    route.providerType === 'mimo.chat-completions' ||
    route.providerType === 'generic.chat-completions'
  ) {
    items = compileChatMessages(single, route.providerType, route)
  } else {
    throw new TypeError('Unsupported context Provider projection')
  }
  if (record.kind !== 'assistant_turn')
    return { content: items.length ? items : undefined, calls: [] }
  const calls: JsonValue[] = []
  const replies: JsonValue[] = []
  for (const item of items) {
    if (item.type === 'function_call') {
      calls.push(item)
      continue
    }
    const reply = structuredClone(item)
    if (Array.isArray(reply.tool_calls)) {
      calls.push(...reply.tool_calls)
      delete reply.tool_calls
    }
    if (Array.isArray(reply.content)) {
      calls.push(...reply.content.filter(isToolUse))
      reply.content = reply.content.filter((block) => !isToolUse(block))
    }
    if (
      reply.type === 'reasoning' ||
      reply.reasoning_content ||
      (Array.isArray(reply.content) ? reply.content.length : reply.content)
    )
      replies.push(reply)
  }
  return { content: replies.length ? replies : undefined, calls }
}

function isToolUse(value: JsonValue): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.type === 'tool_use',
  )
}
