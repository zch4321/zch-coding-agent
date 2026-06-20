import { describe, expect, it } from 'vitest'
import { ByteRingBuffer } from './byte-ring-buffer'

describe('ByteRingBuffer', () => {
  it('drops only the oldest bytes when capacity is exceeded', () => {
    const buffer = new ByteRingBuffer(5)
    buffer.append('abc')
    buffer.append('defg')

    expect(buffer.snapshot()).toEqual({
      data: 'cdefg',
      startCursor: 2,
      cursor: 7,
      totalBytes: 7,
      retainedBytes: 5,
      truncated: false,
    })
    expect(buffer.snapshot(0)).toMatchObject({
      data: 'cdefg',
      truncated: true,
    })
    expect(buffer.snapshot(5)).toMatchObject({
      data: 'fg',
      truncated: false,
    })
  })
})
