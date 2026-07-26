import type { JsonValue } from '../../../shared/json'
import type { ReasoningEffort } from '../../../shared/config'

export interface DeepSeekWireGolden {
  id: string
  reasoning: ReasoningEffort
  messages: JsonValue[]
  tools: JsonValue[]
  stream: JsonValue[]
  expectedRequest: JsonValue
  expectedEvents: JsonValue[]
}

const intentTool = {
  type: 'function',
  function: {
    name: 'read_file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        _agent_intent: { type: 'string' },
      },
    },
    'x-agent-intent-property': '_agent_intent',
  },
}

const readFileWireTool = {
  type: 'function',
  function: {
    name: 'read_file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        _agent_intent: { type: 'string' },
      },
    },
  },
}

export const DEEPSEEK_WIRE_GOLDENS: DeepSeekWireGolden[] = [
  {
    id: 'text',
    reasoning: 'off',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    stream: [
      { choices: [{ delta: { content: 'Hello' } }] },
      {
        choices: [{ delta: { content: ' world' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ],
    expectedRequest: {
      model: 'golden-model',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
    },
    expectedEvents: [
      { type: 'text.delta', delta: 'Hello' },
      {
        type: 'usage',
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
      { type: 'text.delta', delta: ' world' },
      {
        type: 'completed',
        turn: { role: 'assistant', content: 'Hello world' },
        toolCalls: [],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ],
  },
  {
    id: 'reasoning-and-text',
    reasoning: 'high',
    messages: [{ role: 'user', content: 'Solve it' }],
    tools: [],
    stream: [
      {
        choices: [{ delta: { reasoning_content: 'Check constraints. ' } }],
      },
      {
        choices: [
          { delta: { reasoning_content: 'Then answer.', content: 'Done.' } },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
      },
    ],
    expectedRequest: {
      model: 'golden-model',
      messages: [{ role: 'user', content: 'Solve it' }],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    },
    expectedEvents: [
      { type: 'reasoning.delta', delta: 'Check constraints. ' },
      {
        type: 'usage',
        usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
      },
      { type: 'reasoning.delta', delta: 'Then answer.' },
      { type: 'text.delta', delta: 'Done.' },
      {
        type: 'completed',
        turn: {
          role: 'assistant',
          content: 'Done.',
          reasoning_content: 'Check constraints. Then answer.',
        },
        toolCalls: [],
        usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
      },
    ],
  },
  {
    id: 'single-tool-call',
    reasoning: 'high',
    messages: [{ role: 'user', content: 'Read README.md' }],
    tools: [intentTool],
    stream: [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-readme',
                  function: {
                    name: 'read_file',
                    arguments: '{"path":"README.md",',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: '"_agent_intent":"Read documentation"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
      },
    ],
    expectedRequest: {
      model: 'golden-model',
      messages: [{ role: 'user', content: 'Read README.md' }],
      tools: [readFileWireTool],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    },
    expectedEvents: [
      {
        type: 'tool.delta',
        index: 0,
        id: 'call-readme',
        name: 'read_file',
        argumentsDelta: '{"path":"README.md",',
      },
      {
        type: 'usage',
        usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
      },
      {
        type: 'tool.delta',
        index: 0,
        id: 'call-readme',
        name: 'read_file',
        argumentsDelta: '"_agent_intent":"Read documentation"}',
      },
      {
        type: 'completed',
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-readme',
              type: 'function',
              function: {
                name: 'read_file',
                arguments:
                  '{"path":"README.md","_agent_intent":"Read documentation"}',
              },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-readme',
            toolId: 'read_file',
            args: { path: 'README.md' },
            reason: 'Read documentation',
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
      },
    ],
  },
  {
    id: 'multiple-tool-calls',
    reasoning: 'off',
    messages: [{ role: 'user', content: 'Read both files' }],
    tools: [intentTool],
    stream: [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: 'call-second',
                  function: {
                    name: 'read_file',
                    arguments: '{"path":"b.txt"}',
                  },
                },
                {
                  index: 0,
                  id: 'call-first',
                  function: {
                    name: 'read_file',
                    arguments: '{"path":"a.txt"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 6, completion_tokens: 6, total_tokens: 12 },
      },
    ],
    expectedRequest: {
      model: 'golden-model',
      messages: [{ role: 'user', content: 'Read both files' }],
      tools: [readFileWireTool],
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
    },
    expectedEvents: [
      {
        type: 'usage',
        usage: { prompt_tokens: 6, completion_tokens: 6, total_tokens: 12 },
      },
      {
        type: 'tool.delta',
        index: 1,
        id: 'call-second',
        name: 'read_file',
        argumentsDelta: '{"path":"b.txt"}',
      },
      {
        type: 'tool.delta',
        index: 0,
        id: 'call-first',
        name: 'read_file',
        argumentsDelta: '{"path":"a.txt"}',
      },
      {
        type: 'completed',
        turn: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-first',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            },
            {
              id: 'call-second',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"b.txt"}' },
            },
          ],
        },
        toolCalls: [
          {
            id: 'call-first',
            toolId: 'read_file',
            args: { path: 'a.txt' },
            reason: '',
          },
          {
            id: 'call-second',
            toolId: 'read_file',
            args: { path: 'b.txt' },
            reason: '',
          },
        ],
        usage: { prompt_tokens: 6, completion_tokens: 6, total_tokens: 12 },
      },
    ],
  },
]
