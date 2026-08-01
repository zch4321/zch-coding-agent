// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CallId, RunId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import type {
  ConversationTurn as ConversationTurnView,
  ReasoningSegment,
  ToolActivity,
} from '../../stores/agent-types'
import ConversationTurn from './ConversationTurn.vue'
import ReasoningGroup from './ReasoningGroup.vue'
import ToolCallGroup from './ToolCallGroup.vue'

const runId = 'run:timeline-groups' as RunId

function tools(): ToolActivity[] {
  return [
    {
      callId: 'call:read' as CallId,
      runId,
      tool: 'read_file',
      args: { path: 'README.md' },
      reason: 'Read the file',
      status: 'completed',
      result: { status: 'ok' },
      order: 1,
    },
    {
      callId: 'call:shell' as CallId,
      runId,
      tool: 'shell_command',
      args: { command: 'npm test' },
      reason: 'Run tests',
      status: 'proposed',
      order: 2,
    },
  ]
}

function reasoningSegments(): ReasoningSegment[] {
  return [
    { id: 'reasoning:1', text: 'Inspect the implementation.', order: 1 },
    {
      id: 'reasoning:2',
      runId,
      text: 'Verify the test result.',
      order: 2,
      live: true,
    },
  ]
}

beforeEach(() => {
  setActivePinia(createPinia())
  setAppLocale('zh-CN')
})

describe('timeline disclosure groups', () => {
  it('previews the latest tool and expands the complete tool list', async () => {
    const wrapper = mount(ToolCallGroup, {
      props: { tools: tools() },
      global: { plugins: [i18n] },
    })

    const header = wrapper.get('.timeline-disclosure-header')
    expect(header.text()).toContain('工具调用')
    expect(header.text()).toContain('shell_command')
    expect(wrapper.get('.n-collapse-item').attributes('class')).not.toContain(
      'n-collapse-item--active',
    )

    await wrapper.get('.n-collapse-item__header-main').trigger('click')

    expect(wrapper.get('.n-collapse-item').attributes('class')).toContain(
      'n-collapse-item--active',
    )
    expect(wrapper.findAll('.tool-call-card')).toHaveLength(2)
    expect(wrapper.emitted('content-resized')).toHaveLength(1)

    const updatedTools = tools()
    updatedTools[1] = {
      ...updatedTools[1]!,
      status: 'completed',
      result: { status: 'ok' },
    }
    await wrapper.setProps({ tools: updatedTools })
    expect(wrapper.get('.n-collapse-item').attributes('class')).toContain(
      'n-collapse-item--active',
    )
    wrapper.unmount()
  })

  it('keeps plaintext reasoning segments in one collapsed streaming group', async () => {
    const wrapper = mount(ReasoningGroup, {
      props: { segments: reasoningSegments(), streaming: true },
      global: { plugins: [i18n] },
    })

    expect(wrapper.get('.timeline-disclosure-header').text()).toContain(
      '思考过程',
    )
    expect(wrapper.get('.timeline-disclosure-header').text()).toContain(
      '生成中',
    )
    expect(wrapper.get('.n-collapse-item').attributes('class')).not.toContain(
      'n-collapse-item--active',
    )

    await wrapper.get('.n-collapse-item__header-main').trigger('click')

    expect(wrapper.findAll('.reasoning-content')).toHaveLength(2)
    expect(wrapper.text()).toContain('Inspect the implementation.')
    expect(wrapper.text()).toContain('Verify the test result.')
    expect(wrapper.emitted('content-resized')).toHaveLength(1)

    await wrapper.setProps({
      segments: [
        ...reasoningSegments(),
        {
          id: 'reasoning:3',
          runId,
          text: 'Continue streaming.',
          order: 3,
          live: true,
        },
      ],
    })
    expect(wrapper.get('.n-collapse-item').attributes('class')).toContain(
      'n-collapse-item--active',
    )
    expect(wrapper.findAll('.reasoning-content')).toHaveLength(3)
    wrapper.unmount()
  })

  it('renders each turn in user, tools, reasoning, and message order', () => {
    const turn: ConversationTurnView = {
      id: 'turn:test',
      order: 1,
      userMessage: {
        id: 'message:user',
        role: 'user',
        durableKind: 'user_input',
        text: 'Please inspect it',
      },
      tools: tools(),
      reasoningSegments: reasoningSegments(),
      messages: [
        {
          id: 'message:assistant-1',
          role: 'assistant',
          durableKind: 'assistant_turn',
          text: 'First update',
        },
        {
          id: 'message:assistant-2',
          role: 'assistant',
          durableKind: 'assistant_turn',
          text: 'Final answer',
        },
      ],
    }
    const wrapper = mount(ConversationTurn, {
      props: {
        turn,
        activeRunId: runId,
        actionsDisabled: true,
      },
      global: { plugins: [i18n] },
    })

    const childClasses = Array.from(
      wrapper.get('.conversation-turn').element.children,
    ).map((element) => element.className)
    expect(childClasses).toEqual([
      expect.stringContaining('chat-message user'),
      expect.stringContaining('tool-call-group'),
      expect.stringContaining('reasoning-group'),
      expect.stringContaining('chat-message assistant'),
      expect.stringContaining('chat-message assistant'),
    ])
    wrapper.unmount()
  })
})
