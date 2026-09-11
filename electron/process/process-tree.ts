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
        // A root exit does not prove that its descendants have exited.
        if (code === 0) resolve()
        else reject(new Error(`taskkill failed with exit code ${code}`))
      })
    })
    return
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch (error) {
    // ESRCH refers to the whole process group, unlike the root's exit status.
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return
    throw error
  }
}
