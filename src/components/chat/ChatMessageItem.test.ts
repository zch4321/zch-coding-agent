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

function mountMessage() {
  setAppLocale('zh-CN')
  return mount(ChatMessageItem, {
    props: {
      message: activeAssistant(),
      activeRunId: runId,
      actionsDisabled: true,
    },
    global: { plugins: [i18n] },
  })
}

describe('ChatMessageItem streaming status', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('places the active status above the streamed assistant text', async () => {
    const wrapper = mountMessage()

    await flushPromises()

    expect(wrapper.get('.message-meta .n-tag').text()).toBe('生成中')
    expect(wrapper.text()).toContain('Streaming answer')
    wrapper.unmount()
  })
})
