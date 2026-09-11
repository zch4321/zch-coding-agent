import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateProcessTree } from './process-tree'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

describe('owned process tree termination', () => {
  it.each([null, 0])(
    'does not infer descendant exit from root exitCode=%s',
    async (exitCode) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      const killer = new EventEmitter()
      vi.mocked(spawn).mockReturnValue(killer as ChildProcess)
      const stopped = terminateProcessTree(
        { pid: 42, exitCode, signalCode: null } as ChildProcess,
        false,
      )
      const rejected = expect(stopped).rejects.toThrow(
        'taskkill failed with exit code 1',
      )
      killer.emit('close', 1)
      await rejected
      expect(spawn).toHaveBeenLastCalledWith(
        'taskkill.exe',
        ['/pid', '42', '/T', '/F'],
        {
          windowsHide: true,
          stdio: 'ignore',
        },
      )
    },
  )

  it('reports taskkill spawn failures and accepts a successful whole-tree request', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    for (const success of [false, true]) {
      const killer = new EventEmitter()
      vi.mocked(spawn).mockReturnValue(killer as ChildProcess)
      const stopped = terminateProcessTree({ pid: 42 } as ChildProcess, true)
      const checked = success
        ? expect(stopped).resolves.toBeUndefined()
        : expect(stopped).rejects.toThrow('denied')
      if (success) killer.emit('close', 0)
      else {
        killer.emit('error', new Error('denied'))
        killer.emit('close', -1)
      }
      await checked
    }
  })

  it('accepts a missing POSIX group but preserves access failures even after root exit', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const kill = vi.spyOn(process, 'kill')
    const child = { pid: 42, exitCode: 0, signalCode: null } as ChildProcess
    kill.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' })
    })
    await expect(terminateProcessTree(child, false)).resolves.toBeUndefined()
    expect(kill).toHaveBeenLastCalledWith(-42, 'SIGTERM')
    kill.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    await expect(terminateProcessTree(child, true)).rejects.toThrow('denied')
    expect(kill).toHaveBeenLastCalledWith(-42, 'SIGKILL')
  })
})
