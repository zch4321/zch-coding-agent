// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import type { ChatMessage } from '../../stores/agent-types'
import ChatMessageItem from './ChatMessageItem.vue'

const runId = 'run:reasoning-status' as RunId

function activeAssistant(reasoning: string): ChatMessage {
  return {
    id: 'message:reasoning-status',
    role: 'assistant',
    durableKind: 'stream',
    runId,
    text: '',
    reasoning,
  }
}

function mountMessage(reasoning: string) {
  setAppLocale('zh-CN')
  return mount(ChatMessageItem, {
    props: {
      message: activeAssistant(reasoning),
      activeRunId: runId,
      actionsDisabled: true,
    },
    global: { plugins: [i18n] },
  })
}

describe('ChatMessageItem reasoning status', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('places the active status in the reasoning header', () => {
    const wrapper = mountMessage('Inspecting the workspace')
    const summary = wrapper.get('.reasoning-card .tool-call-summary')

    expect(wrapper.find('.message-meta').exists()).toBe(false)
    expect(summary.text()).toContain('思考过程')
    expect(summary.get('.n-tag').text()).toBe('生成中')
    wrapper.unmount()
  })

  it('keeps a standalone status before reasoning content exists', () => {
    const wrapper = mountMessage('')

    expect(wrapper.find('.reasoning-card').exists()).toBe(false)
    expect(wrapper.get('.message-meta .n-tag').text()).toBe('生成中')
    wrapper.unmount()
  })
})
