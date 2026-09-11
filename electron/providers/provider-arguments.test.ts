import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANONICAL_JSON_LIMITS } from '../../shared/json'
import {
  ProviderArgumentsAccumulator,
  normalizeProviderToolCall,
  parseProviderArguments,
} from './provider-shared'
import type { CallId } from '../../shared/ids'

afterEach(() => vi.restoreAllMocks())

describe('Provider arguments accumulation', () => {
  it.each([
    '{"text":"中文😀"}',
    'a\ud83d\ude00b',
    '\ud83d\ud83d\ude00',
    '\ud83d!\ude00',
    '',
  ])('counts exact UTF-8 bytes for every split of %j', (value) => {
    for (let split = 0; split <= value.length; split += 1) {
      const state = new ProviderArgumentsAccumulator(
        'test arguments',
        value.slice(0, split),
      )
      state.append('')
      state.append(value.slice(split))
      expect(state.text).toBe(value)
      expect(state.bytes).toBe(Buffer.byteLength(value, 'utf8'))
    }
  })

  it('examines only new bytes instead of rescanning all preceding arguments', () => {
    const byteLength = Buffer.byteLength
    let examined = 0
    vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) => {
      const bytes = byteLength(value, encoding)
      examined += bytes
      return bytes
    })
    const state = new ProviderArgumentsAccumulator('test arguments')
    for (let index = 0; index < 1000; index += 1) state.append('x'.repeat(1000))
    expect(state.bytes).toBe(1_000_000)
    expect(state.text).toHaveLength(1_000_000)
    expect(examined).toBe(1_000_000)
  })

  it('accepts a split surrogate at the byte limit and rejects overflow without altering state', () => {
    const prefix = 'x'.repeat(CANONICAL_JSON_LIMITS.maxBytes - 4)
    const state = new ProviderArgumentsAccumulator('test arguments', prefix)
    state.append('\ud83d')
    state.append('\ude00')
    expect(state.bytes).toBe(CANONICAL_JSON_LIMITS.maxBytes)
    expect(() => state.append('x')).toThrow('exceed maximum size')
    expect(state.text).toBe(prefix + '😀')
    expect(state.bytes).toBe(CANONICAL_JSON_LIMITS.maxBytes)
    expect(
      () =>
        new ProviderArgumentsAccumulator(
          'initial arguments',
          'x'.repeat(CANONICAL_JSON_LIMITS.maxBytes + 1),
        ),
    ).toThrow('initial arguments exceed maximum size')
  })

  it('retains common empty/malformed JSON and intent rules after helper consolidation', () => {
    expect(parseProviderArguments(' ')).toEqual({})
    expect(parseProviderArguments('{')).toEqual({ _rawArguments: '{' })
    const args = { path: '目录/😀.ts', intent: 'inspect' }
    expect(
      normalizeProviderToolCall({
        id: 'call:test' as CallId,
        name: 'read_file',
        arguments: args,
        intentFields: new Map([['read_file', 'intent']]),
      }),
    ).toMatchObject({ args: { path: '目录/😀.ts' }, reason: 'inspect' })
    expect(args.intent).toBe('inspect')
  })
})
