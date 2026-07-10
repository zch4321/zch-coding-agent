import type { CallId } from '../../shared/ids'
import type { JsonValue } from '../../shared/json'
import type { AutoApprover } from '../permission/auto-approver'
import type { LLMProvider, ProviderEvent } from '../providers/provider'

export class ScriptedEditProvider implements LLMProvider {
  calls = 0

  async *streamChat(): AsyncIterable<ProviderEvent> {
    this.calls += 1

    if (this.calls === 1) {
      const args = {
        path: 'note.txt',
        patch: [
          '--- a/note.txt',
          '+++ b/note.txt',
          '@@ -1,2 +1,2 @@',
          ' alpha',
          '-beta',
          '+gamma',
        ].join('\n'),
      }
      yield {
        type: 'completed',
        rawResponse: { id: 'edit-request' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-edit',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-edit' as CallId,
            toolId: 'apply_patch',
            args,
            reason: 'Update the requested line',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'text.delta',
      delta: 'Updated note.txt',
      raw: {},
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'edit-complete' },
      turn: { role: 'assistant', content: 'Updated note.txt' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

export class ScriptedCommandProvider implements LLMProvider {
  calls = 0

  async *streamChat(): AsyncIterable<ProviderEvent> {
    this.calls += 1

    if (this.calls === 1) {
      yield {
        type: 'completed',
        rawResponse: { id: 'command-request' },
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-command',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({
                  mode: 'process',
                  executable: process.execPath,
                  args: ['--version'],
                }),
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-command' as CallId,
            toolId: 'run_command',
            args: {
              mode: 'process',
              executable: process.execPath,
              args: ['--version'],
            },
            reason: 'Check Node version',
          },
        ],
        usage: {},
        providerState: {},
        timing: {},
      }
      return
    }

    yield {
      type: 'text.delta',
      delta: 'Checked Node version',
      raw: {},
    }
    yield {
      type: 'completed',
      rawResponse: { id: 'command-complete' },
      turn: { role: 'assistant', content: 'Checked Node version' },
      toolCalls: [],
      usage: {},
      providerState: {},
      timing: {},
    }
  }
}

export const safeAutoApprover: AutoApprover = {
  async evaluate() {
    return {
      decision: 'safe',
      note: 'Single bounded workspace edit',
      valid: true,
    }
  },
}

export function sseResponse(payloads: JsonValue[]): Response {
  const body = payloads
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}
