import { spawn, type ChildProcess } from 'node:child_process'

/** Requests termination of an owned process tree and surfaces host failures for retry. */
export async function terminateProcessTree(
  child: ChildProcess,
  force: boolean,
): Promise<void> {
  if (!child.pid) throw new Error('Process has no operating-system pid')
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        'taskkill.exe',
        // Windows pipes have no console Ctrl+C channel. Kill the whole tree in
        // one operation so the root cannot disappear before its descendants.
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      )
      killer.once('error', reject)
      killer.once('close', (code) => {
        if (code === 0 || child.exitCode !== null || child.signalCode !== null)
          resolve()
        else reject(new Error(`taskkill failed with exit code ${code}`))
      })
    })
    return
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) return
    throw error
  }
}
