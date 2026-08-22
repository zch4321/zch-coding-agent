// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { NSpin } from 'naive-ui'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CallId, RunId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import type {
  ConversationTurn as ConversationTurnView,
  ReasoningSegment,
  RunActivity,
  ToolActivity,
} from '../../stores/agent-types'
import ConversationTurn from './ConversationTurn.vue'
import ComposerTodo from './ComposerTodo.vue'
import ReasoningGroup from './ReasoningGroup.vue'
import ToolCallGroup from './ToolCallGroup.vue'

const runId = 'run:timeline-groups' as RunId
const PopoverStub = defineComponent({
  name: 'NPopover',
  props: { trigger: String },
  setup(props, { slots }) {
    return () =>
      h('div', { 'data-trigger': props.trigger }, [
        slots.trigger?.(),
        h('div', { class: 'popover-content' }, slots.default?.()),
      ])
  },
})

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
    expect(wrapper.text()).toContain('已完成')
    expect(wrapper.text()).toContain('待执行')
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

  it('keeps plaintext reasoning segments in one collapsed activity group', async () => {
    const wrapper = mount(ReasoningGroup, {
      props: { segments: reasoningSegments(), activity: 'reasoning' },
      global: { plugins: [i18n] },
    })

    expect(wrapper.get('.timeline-disclosure-header').text()).toContain(
      '思考过程',
    )
    expect(wrapper.get('.timeline-disclosure-header').text()).toContain(
      '思考中',
    )
    expect(wrapper.find('.run-activity-spinner').exists()).toBe(true)
    expect(wrapper.getComponent(NSpin).props('size')).toBe(12)
    expect(wrapper.getComponent(NSpin).props('strokeWidth')).toBe(16)
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

  it('shows every active phase in one stable status slot', async () => {
    const labels: Array<[RunActivity, string]> = [
      ['requesting_model', '请求模型'],
      ['reasoning', '思考中'],
      ['output', '输出中'],
      ['calling_tool', '调用工具'],
      ['executing_tool', '执行工具'],
      ['awaiting_approval', '等待审批'],
      ['cancelling', '取消中'],
    ]
    const wrapper = mount(ReasoningGroup, {
      props: { segments: [], activity: labels[0]![0] },
      global: { plugins: [i18n] },
    })

    expect(wrapper.get('.reasoning-group').text()).toContain('思考过程')
    expect(wrapper.get('.n-collapse-item').attributes('class')).toContain(
      'n-collapse-item--disabled',
    )
    expect(wrapper.find('.reasoning-content').exists()).toBe(false)

    for (const [activity, label] of labels) {
      await wrapper.setProps({ activity })
      const status = wrapper.get('.run-activity')
      expect(status.attributes('data-run-activity')).toBe(activity)
      expect(status.text()).toBe(label)
      expect(wrapper.findAll('.run-activity-spinner')).toHaveLength(1)
    }
    wrapper.unmount()
  })

  it('renders the current Todo as one hover preview with a full checklist', () => {
    const wrapper = mount(ComposerTodo, {
      props: {
        todo: {
          explanation: 'Keep the implementation visible',
          items: [
            { step: 'Inspect runtime', status: 'completed' },
            { step: 'Implement event', status: 'in_progress' },
            { step: 'Run checks', status: 'pending' },
          ],
        },
      },
      global: {
        plugins: [i18n],
        stubs: { Popover: PopoverStub },
      },
    })

    expect(
      wrapper.get('[data-trigger="hover"]').attributes('data-trigger'),
    ).toBe('hover')
    expect(wrapper.get('.composer-todo-preview').text()).toContain('进行中')
    expect(wrapper.get('.composer-todo-preview').text()).toContain(
      'Implement event',
    )
    expect(wrapper.get('.composer-todo-preview').text()).toContain('1/3')
    expect(wrapper.get('.composer-todo-popover').text()).toContain('待办')
    expect(wrapper.findAll('.n-checkbox')).toHaveLength(3)
    expect(wrapper.findAll('.n-checkbox')[0]?.classes()).toContain(
      'n-checkbox--checked',
    )
    expect(wrapper.findAll('.n-checkbox')[1]?.classes()).toContain(
      'n-checkbox--indeterminate',
    )
    expect(wrapper.text()).toContain('Keep the implementation visible')
    wrapper.unmount()
  })

  it('hides the composer Todo after every item completes', () => {
    const wrapper = mount(ComposerTodo, {
      props: {
        todo: {
          items: [{ step: 'Finished', status: 'completed' }],
        },
      },
      global: { plugins: [i18n] },
    })

    expect(wrapper.find('.composer-todo-anchor').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders each turn in user, reasoning, tools, and message order', () => {
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
      finalAssistantMessageId: 'message:assistant-2',
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
        actionsDisabled: false,
      },
      global: { plugins: [i18n] },
    })

    const childClasses = Array.from(
      wrapper.get('.conversation-turn').element.children,
    ).map((element) => element.className)
    expect(childClasses).toEqual([
      expect.stringContaining('chat-message user'),
      expect.stringContaining('reasoning-group'),
      expect.stringContaining('tool-call-group'),
      expect.stringContaining('chat-message assistant'),
      expect.stringContaining('chat-message assistant'),
    ])
    const assistantMessages = wrapper.findAll('.chat-message.assistant')
    expect(assistantMessages[0]?.find('.message-actions').exists()).toBe(false)
    expect(assistantMessages[1]?.findAll('.message-action')).toHaveLength(2)
    wrapper.unmount()
  })
})
