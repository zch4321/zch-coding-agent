// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentApi } from '../../../shared/agent-api'
import type {
  BackgroundTerminal,
  BackgroundTerminalTail as Tail,
} from '../../../shared/background-tasks'
import type { SessionId, TerminalId } from '../../../shared/ids'
import { i18n, setAppLocale } from '../../i18n'
import BackgroundTerminalTail from './BackgroundTerminalTail.vue'

const terminal: BackgroundTerminal = {
  kind: 'terminal',
  terminalId: 1 as TerminalId,
  shell: 'pwsh',
  status: 'running',
  exitCode: null,
  createdAt: '2026-09-05T00:00:00.000Z',
  artifactAvailable: true,
}
const baseProps = {
  terminal,
  sessionId: 'session:tail' as SessionId,
  backendInstanceId: 'backend:tail',
  visible: true,
}
const originalScrollTo = HTMLElement.prototype.scrollTo
function response(content: string, overrides: Partial<Tail> = {}) {
  return {
    version: 1 as const,
    ok: true as const,
    value: {
      cursor: { backendInstanceId: baseProps.backendInstanceId, sequence: 0 },
      available: true,
      content,
      truncated: false,
      ...overrides,
    },
  }
}

describe('Background terminal log preview', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setAppLocale('zh-CN')
    HTMLElement.prototype.scrollTo = vi.fn()
  })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'agentApi')
    vi.restoreAllMocks()
    HTMLElement.prototype.scrollTo = originalScrollTo
  })

  it('polls only while visible, pauses on upward scrolling, and renders untrusted output as text', async () => {
    const getBackgroundTerminalTail = vi.fn(async () =>
      response('<script>window.bad = true</script>\nlatest'),
    )
    const openTerminal = vi.fn()
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: {
        getBackgroundTerminalTail,
        openTerminal,
      } as unknown as AgentApi,
    })
    const wrapper = mount(BackgroundTerminalTail, {
      props: { ...baseProps, visible: false },
      global: { plugins: [i18n] },
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect(getBackgroundTerminalTail).not.toHaveBeenCalled()
    await wrapper.setProps({ visible: true })
    await flushPromises()
    expect(getBackgroundTerminalTail).toHaveBeenCalledOnce()
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.get('pre').text()).toContain('<script>')
    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(getBackgroundTerminalTail).toHaveBeenCalledTimes(2)
    const container = wrapper.get('.n-scrollbar-container')
    Object.defineProperties(container.element, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    })
    container.element.scrollTop = 100
    await container.trigger('scroll')
    expect(wrapper.text()).toContain('已暂停跟随')
    await vi.advanceTimersByTimeAsync(3000)
    expect(getBackgroundTerminalTail).toHaveBeenCalledTimes(2)
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '恢复跟随')!
      .trigger('click')
    await flushPromises()
    expect(getBackgroundTerminalTail).toHaveBeenCalledTimes(3)
    await wrapper.setProps({ visible: false })
    await vi.advanceTimersByTimeAsync(3000)
    expect(getBackgroundTerminalTail).toHaveBeenCalledTimes(3)
    expect(openTerminal).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps prior output on capture failure and stops polling after a final read', async () => {
    const getBackgroundTerminalTail = vi
      .fn()
      .mockResolvedValueOnce(response('retained output'))
      .mockResolvedValueOnce(
        response('', { available: false, error: 'log missing' }),
      )
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { getBackgroundTerminalTail } as unknown as AgentApi,
    })
    const wrapper = mount(BackgroundTerminalTail, {
      props: baseProps,
      global: { plugins: [i18n] },
    })
    await flushPromises()
    await wrapper.setProps({
      terminal: { ...terminal, status: 'closed', exitCode: 0 },
    })
    await flushPromises()
    expect(wrapper.get('pre').text()).toBe('retained output')
    expect(wrapper.get('[role="alert"]').text()).toBe('log missing')
    await vi.advanceTimersByTimeAsync(5000)
    expect(getBackgroundTerminalTail).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('discards a late response after switching targets and keeps at most one request in flight', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void
    const pending = new Promise<ReturnType<typeof response>>((done) => {
      resolve = done
    })
    const getBackgroundTerminalTail = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(response('new session'))
    Object.defineProperty(window, 'agentApi', {
      configurable: true,
      value: { getBackgroundTerminalTail } as unknown as AgentApi,
    })
    const wrapper = mount(BackgroundTerminalTail, {
      props: baseProps,
      global: { plugins: [i18n] },
    })
    await vi.advanceTimersByTimeAsync(3000)
    expect(getBackgroundTerminalTail).toHaveBeenCalledOnce()
    await wrapper.setProps({ sessionId: 'session:new' as SessionId })
    resolve(response('old session'))
    await flushPromises()
    expect(wrapper.get('pre').text()).toBe('new session')
    expect(getBackgroundTerminalTail).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})
