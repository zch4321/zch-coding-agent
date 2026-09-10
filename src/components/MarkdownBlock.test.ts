// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarkdownBlock from './MarkdownBlock.vue'

afterEach(() => vi.useRealTimers())

describe('Markdown block rendering', () => {
  it('retains finished DOM nodes across coalesced updates and flushes completion without waiting', async () => {
    vi.useFakeTimers()
    const source = '# Heading\n\n```text\nfixed code\n```\n\nGrowing'
    const wrapper = mount(MarkdownBlock, {
      props: { content: source, streaming: true },
    })
    await flushPromises()
    const heading = wrapper.get('h1').element
    const pre = wrapper.get('pre').element
    for (let index = 0; index < 20; index++)
      await wrapper.setProps({ content: source + 'x'.repeat(index + 1) })
    expect(wrapper.text()).not.toContain('Growingx')
    await vi.advanceTimersByTimeAsync(50)
    expect(wrapper.get('h1').element).toBe(heading)
    expect(wrapper.get('pre').element).toBe(pre)
    expect(wrapper.text()).toContain('Growing' + 'x'.repeat(20))
    await wrapper.setProps({ content: source + ' finished', streaming: false })
    expect(wrapper.text()).toContain('Growing finished')
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
