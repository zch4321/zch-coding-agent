import { describe, expect, it } from 'vitest'
import type { CommandSessionSnapshot } from '../process/command-sessions'
import { formatExecCommandResult } from './exec-command-result'

/** Builds a command snapshot with a native Windows capture directory. */
function snapshot(
  overrides: Partial<CommandSessionSnapshot> = {},
): CommandSessionSnapshot {
  return {
    sessionId: 'exec:artifact',
    state: 'exited',
    stdout: '',
    stderr: '',
    exitCode: 0,
    exitSignal: null,
    stdinClosed: true,
    truncated: false,
    totalBytes: 0,
    artifactAvailable: true,
    artifactPath: String.raw`C:\Users\user name\AppData\Local\Temp\zch-test\2\tmp\artifacts\commands\11`,
    ...overrides,
  }
}

const limits = { maxToolOutputBytes: 1024, maxToolOutputLines: 10 }

describe('exec command artifact metadata', () => {
  it.each(['running', 'exited', 'failed'] as const)(
    'labels the %s capture directory while preserving its native path and output',
    (state) => {
      const value = snapshot({ state })
      value.stdout = `A literal path in output: ${value.artifactPath}`
      value.totalBytes = Buffer.byteLength(value.stdout)
      const result = formatExecCommandResult(value, limits)
      const [header, ...body] = result.text.split('\n')

      expect(JSON.parse(header!)).toMatchObject({
        state,
        artifactPath: value.artifactPath,
        artifactType: 'directory',
        artifactAvailable: true,
        truncated: false,
      })
      expect(body.join('\n')).toBe(value.stdout)
      expect(result.truncated).toBe(false)
    },
  )

  it('reports capture failure without inventing an artifact location', () => {
    const result = formatExecCommandResult(
      snapshot({
        artifactAvailable: false,
        artifactPath: undefined,
        captureError: 'Capture directory could not be created',
      }),
      limits,
    )
    const header = JSON.parse(result.text.split('\n')[0]!)

    expect(header).toMatchObject({
      artifactAvailable: false,
      captureError: 'Capture directory could not be created',
    })
    expect(header).not.toHaveProperty('artifactPath')
    expect(header).not.toHaveProperty('artifactType')
  })

  it('omits path and type together when metadata exceeds the output budget', () => {
    const result = formatExecCommandResult(
      snapshot({
        artifactPath: `C:\\${'long-directory\\'.repeat(100)}commands\\11`,
        stdout: 'Still keep useful output',
      }),
      { ...limits, maxToolOutputBytes: 512 },
    )
    const header = JSON.parse(result.text.split('\n')[0]!)

    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(512)
    expect(header).toMatchObject({
      sessionId: 'exec:artifact',
      truncated: true,
    })
    expect(header).not.toHaveProperty('artifactPath')
    expect(header).not.toHaveProperty('artifactType')
    expect(result.text).toContain('Still keep useful output')
  })
})
