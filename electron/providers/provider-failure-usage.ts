import type { ProviderUsage } from './provider'

const receivedUsage = new WeakMap<object, ProviderUsage>()

/** Preserves already received usage without wrapping or reclassifying a transport failure. */
export async function* withProviderFailureUsage<Event>(
  events: AsyncIterable<Event>,
  usage: () => ProviderUsage,
): AsyncIterable<Event> {
  try {
    yield* events
  } catch (error) {
    if (error && typeof error === 'object') receivedUsage.set(error, usage())
    throw error
  }
}

/** Finds usage carried by a transport error through a bounded diagnostic cause chain. */
export function providerFailureUsage(
  error: unknown,
): ProviderUsage | undefined {
  let current = error
  for (
    let depth = 0;
    depth < 8 && current && typeof current === 'object';
    depth += 1
  ) {
    const usage = receivedUsage.get(current)
    if (usage) return usage
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}
