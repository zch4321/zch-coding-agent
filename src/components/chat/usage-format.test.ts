import { describe, expect, it } from 'vitest'
import { cacheHitRatePercent, formatTokenCount } from './usage-format'

describe('formatTokenCount', () => {
  it('keeps sub-thousand values exact', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(42)).toBe('42')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('uses one decimal below 10k', () => {
    expect(formatTokenCount(1_000)).toBe('1.0k')
    expect(formatTokenCount(1_500)).toBe('1.5k')
    expect(formatTokenCount(9_949)).toBe('9.9k')
  })

  it('uses integer k below one million', () => {
    expect(formatTokenCount(9_950)).toBe('10k')
    expect(formatTokenCount(10_000)).toBe('10k')
    expect(formatTokenCount(96_500)).toBe('97k')
    expect(formatTokenCount(128_000)).toBe('128k')
    expect(formatTokenCount(256_000)).toBe('256k')
    expect(formatTokenCount(999_499)).toBe('999k')
  })

  it('uses one decimal M at one million and above', () => {
    expect(formatTokenCount(999_500)).toBe('1.0M')
    expect(formatTokenCount(1_000_000)).toBe('1.0M')
    expect(formatTokenCount(1_249_000)).toBe('1.2M')
  })

  it('never emits a negative or non-finite count', () => {
    expect(formatTokenCount(-5)).toBe('0')
    expect(formatTokenCount(Number.NaN)).toBe('0')
  })
})

describe('cacheHitRatePercent', () => {
  it('rounds the hit share to an integer percent', () => {
    expect(cacheHitRatePercent(1, 3)).toBe(25)
    expect(cacheHitRatePercent(96_000, 32_000)).toBe(75)
    expect(cacheHitRatePercent(1, 2)).toBe(33)
  })

  it('is undefined when no cacheable input was reported', () => {
    expect(cacheHitRatePercent(0, 0)).toBeUndefined()
  })

  it('treats all-miss input as a zero rate', () => {
    expect(cacheHitRatePercent(0, 12_000)).toBe(0)
  })
})
