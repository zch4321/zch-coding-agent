// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { MessageId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import type { ConversationTurn } from '../../stores/agent-types'
import ConversationTurnItem from './ConversationTurn.vue'

function interruptedTurn(): ConversationTurn {
  return {
    id: 'turn:interrupted',
    sourceTurnId: 'message:user' as MessageId,
    order: 1,
    userMessage: {
      id: 'message:user',
      role: 'user',
      durableKind: 'user_input',
      text: 'Run tools',
      retryable: true,
      editable: true,
    },
    tools: [],
    reasoningSegments: [],
    messages: [
      {
        id: 'message:assistant-tool-call',
        role: 'assistant',
        durableKind: 'assistant_turn',
        text: 'I will inspect the workspace.',
      },
    ],
    finalAssistantMessageId: 'message:assistant-tool-call',
  }
}

describe('ConversationTurn continuation action', () => {
  it('places continuation beside the latest actionable message controls', async () => {
    setAppLocale('zh-CN')
    const wrapper = mount(ConversationTurnItem, {
      props: {
        turn: interruptedTurn(),
        actionsDisabled: false,
        continuable: true,
      },
      global: { plugins: [i18n] },
    })

    const buttons = wrapper.findAll('[aria-label="继续"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.element.closest('.chat-message')?.classList).toContain(
      'assistant',
    )
    await buttons[0]!.trigger('click')
    expect(wrapper.emitted('continue')).toHaveLength(1)
    wrapper.unmount()
  })
})
