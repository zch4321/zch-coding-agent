// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import type { ChatMessage } from '../../stores/agent-types'
import ChatMessageItem from './ChatMessageItem.vue'

const runId = 'run:streaming-status' as RunId

function activeAssistant(): ChatMessage {
  return {
    id: 'message:streaming-status',
    role: 'assistant',
    durableKind: 'stream',
    runId,
    text: 'Streaming answer',
  }
}

function durableAssistant(): ChatMessage {
  return {
    id: 'message:durable-status',
    role: 'assistant',
    durableKind: 'assistant_turn',
    text: 'Completed answer',
  }
}

function actionableUser(): ChatMessage {
  return {
    id: 'message:actionable-user',
    role: 'user',
    durableKind: 'user_input',
    text: 'Actionable request',
    retryable: true,
    editable: true,
  }
}

function mountMessage() {
  setAppLocale('zh-CN')
  return mount(ChatMessageItem, {
    props: {
      message: activeAssistant(),
      actionsDisabled: true,
    },
    global: { plugins: [i18n] },
  })
}

describe('ChatMessageItem metadata', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders streamed assistant text without a duplicate status row', async () => {
    const wrapper = mountMessage()

    await flushPromises()

    expect(wrapper.find('.message-meta').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('生成中')
    expect(wrapper.text()).toContain('Streaming answer')
    wrapper.unmount()
  })

  it('does not mark a completed assistant message as active when both run IDs are absent', async () => {
    setAppLocale('zh-CN')
    const wrapper = mount(ChatMessageItem, {
      props: {
        message: durableAssistant(),
        actionsDisabled: true,
      },
      global: { plugins: [i18n] },
    })

    await flushPromises()

    expect(wrapper.find('.message-status').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('生成中')
    expect(wrapper.text()).toContain('Completed answer')
    wrapper.unmount()
  })

  it('shows user message actions when showActions is omitted', async () => {
    setAppLocale('zh-CN')
    const wrapper = mount(ChatMessageItem, {
      props: {
        message: actionableUser(),
        actionsDisabled: false,
      },
      global: { plugins: [i18n] },
    })

    await flushPromises()

    expect(wrapper.findAll('.message-action')).toHaveLength(4)
    expect(wrapper.find('[aria-label="重试"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="编辑"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
