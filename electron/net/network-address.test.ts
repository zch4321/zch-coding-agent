import { describe, expect, it } from 'vitest'
import { isPublicNetworkAddress } from './network-address'

describe('network address policy', () => {
  it.each([
    '0.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:0:0:1',
    'ff02::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false)
  })

  it('allows public addresses', () => {
    expect(isPublicNetworkAddress('93.184.216.34')).toBe(true)
    expect(isPublicNetworkAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(
      true,
    )
  })
})
