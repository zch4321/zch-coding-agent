import { describe, expect, it } from 'vitest'
import { reconcileVisibleRouteSelection } from './model-pool-transfer'

describe('model pool transfer selection', () => {
  it('preserves surviving route order when a filtered target route is removed', () => {
    const selectedKeys = ['visible-a', 'hidden-b', 'visible-c', 'hidden-d']
    const visibleKeys = new Set(['visible-a', 'visible-c'])

    expect(
      reconcileVisibleRouteSelection(selectedKeys, visibleKeys, [
        'provider:structural-node',
        'visible-a',
      ]),
    ).toEqual(['visible-a', 'hidden-b', 'hidden-d'])
  })
})
