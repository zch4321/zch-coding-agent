/**
 * Formats token counts for the compact conversation header.
 * Values below 1k stay exact; k and M suffixes keep the header short.
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '0'
  }
  if (value < 1_000) {
    return Math.max(0, Math.trunc(value)).toLocaleString()
  }
  if (value < 9_950) {
    return `${(Math.round(value / 100) / 10).toFixed(1)}k`
  }
  if (value < 999_500) {
    return `${Math.round(value / 1_000)}k`
  }
  return `${(Math.round(value / 100_000) / 10).toFixed(1)}M`
}

/**
 * Returns the integer cache hit rate percentage, or undefined when the
 * provider reported no cacheable input tokens at all.
 */
export function cacheHitRatePercent(
  cacheHitTokens: number,
  cacheMissTokens: number,
): number | undefined {
  const total = cacheHitTokens + cacheMissTokens
  if (total <= 0) return undefined
  return Math.round((cacheHitTokens / total) * 100)
}
