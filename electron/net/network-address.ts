import { isIP } from 'node:net'

function ipv4Number(address: string): number | undefined {
  const parts = address.split('.').map(Number)

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined
  }

  return (
    (((parts[0]! << 24) >>> 0) +
      (parts[1]! << 16) +
      (parts[2]! << 8) +
      parts[3]!) >>>
    0
  )
}

function inV4Range(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4Number(base)!
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (value & mask) === (baseValue & mask)
}

function mappedIpv4Address(address: string): string | undefined {
  let normalized: string

  try {
    normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  } catch {
    return undefined
  }

  if (!normalized.startsWith('::ffff:')) {
    return undefined
  }

  const suffix = normalized.slice(7)

  if (isIP(suffix) === 4) {
    return suffix
  }

  const words = suffix.split(':')

  if (words.length !== 2) {
    return undefined
  }

  const high = Number.parseInt(words[0]!, 16)
  const low = Number.parseInt(words[1]!, 16)

  if (!Number.isInteger(high) || !Number.isInteger(low)) {
    return undefined
  }

  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.')
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address)

  if (family === 4) {
    const value = ipv4Number(address)!
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ]
    return !blocked.some(([base, bits]) => inV4Range(value, base, bits))
  }

  if (family === 6) {
    const value = address.toLowerCase().split('%')[0]!
    const mapped = mappedIpv4Address(value)

    if (mapped) {
      return isPublicNetworkAddress(mapped)
    }

    return !(
      value === '::' ||
      value === '::1' ||
      value === '0:0:0:0:0:0:0:0' ||
      value === '0:0:0:0:0:0:0:1' ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      /^fe[89ab]/u.test(value) ||
      /^fe[c-f]/u.test(value) ||
      value.startsWith('ff') ||
      value.startsWith('2001:db8:')
    )
  }

  return false
}
