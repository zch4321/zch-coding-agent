import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandSessionManager } from './command-sessions'
import { commandOwner } from './command-session-test-support'

const roots: string[] = []
const managers: CommandSessionManager[] = []
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'exec-native-'))
  roots.push(root)
  const temp = {
    root,
    artifacts: path.join(root, 'artifacts'),
    scratch: path.join(root, 'scratch'),
  }
  await Promise.all([mkdir(temp.artifacts), mkdir(temp.scratch)])
  const manager = new CommandSessionManager()
  managers.push(manager)
  const owner = commandOwner(String(managers.length))
  const controller = new AbortController()
  manager.beginRun(owner, controller.signal)
  return { root, temp, manager, owner, controller }
}
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()))
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith('exec-native-')
    )
      throw Error('Unexpected native-test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

describe('native pipe command sessions', () => {
  it('identifies the artifact directory when process startup fails', async () => {
    const { root, temp, manager, owner } = await fixture()
    const executable = path.join(root, 'missing-program.exe')
    const directory = path.join(temp.artifacts, 'commands', 'failed-start')
    await expect(
      manager.start(owner, {
        workspace: root,
        command: { mode: 'process', executable },
        sessionTemp: temp,
        artifactKey: 'failed-start',
        maxOutputBytes: 4096,
        launch: { executable },
      }),
    ).rejects.toMatchObject({
      code: 'EXEC_START_FAILED',
      message: expect.stringContaining(
        `artifactPath=${directory}; artifactType=directory`,
      ),
    })
    await manager.finishRun(owner)
    expect(
      JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')),
    ).toMatchObject({
      state: 'failed',
    })
  })

  it('keeps stdin open across calls and flushes stdout/stderr artifacts after EOF', async () => {
    const { root, temp, manager, owner } = await fixture()
    const code =
      "process.stdout.write('READY'); process.stdin.on('data', x => process.stdout.write(x)); process.stdin.on('end', () => process.stderr.write('EOF-final'))"
    const id = await manager.start(owner, {
      workspace: root,
      command: {
        mode: 'process',
        executable: process.execPath,
        args: ['-e', code],
      },
      sessionTemp: temp,
      artifactKey: 'echo',
      maxOutputBytes: 4096,
      launch: { executable: process.execPath },
    })
    expect(
      await manager.read(owner, id, 500, new AbortController().signal),
    ).toMatchObject({ state: 'running', stdout: 'READY' })
    manager.write(owner, id, '中文\n')
    expect(
      await manager.read(owner, id, 50, new AbortController().signal),
    ).toMatchObject({ state: 'running', stdout: '中文\n' })
    manager.write(owner, id, '最后', true)
    const result = await manager.read(
      owner,
      id,
      5000,
      new AbortController().signal,
    )
    expect(result).toMatchObject({
      state: 'exited',
      exitCode: 0,
      stdout: '最后',
      stderr: 'EOF-final',
      stdinClosed: true,
      artifactAvailable: true,
    })
    expect(
      await readFile(path.join(result.artifactPath!, 'stdout.log'), 'utf8'),
    ).toBe('READY中文\n最后')
    expect(
      await readFile(path.join(result.artifactPath!, 'stderr.log'), 'utf8'),
    ).toBe('EOF-final')
    expect(
      JSON.parse(
        await readFile(path.join(result.artifactPath!, 'result.json'), 'utf8'),
      ),
    ).toMatchObject({ state: 'exited', exitCode: 0 })
  })

  it('stops the real descendant tree at Run cleanup while another Run remains alive', async () => {
    const { root, manager, owner } = await fixture()
    const pidFile = path.join(root, 'pids.json')
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`
    const id = await manager.start(owner, {
      workspace: root,
      command: {
        mode: 'process',
        executable: process.execPath,
        args: ['-e', code],
      },
      artifactKey: 'tree',
      maxOutputBytes: 4096,
      launch: { executable: process.execPath },
    })
    const other = commandOwner('independent')
    manager.beginRun(other, new AbortController().signal)
    const sibling = await manager.start(other, {
      workspace: root,
      command: {
        mode: 'process',
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
      },
      artifactKey: 'sibling',
      maxOutputBytes: 4096,
      launch: { executable: process.execPath },
    })
    let pids: number[] = []
    await vi.waitFor(async () => {
      pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[]
      expect(pids.every(exists)).toBe(true)
    })
    await manager.finishRun(owner)
    await vi.waitFor(() => expect(pids.some(exists)).toBe(false), {
      timeout: 10000,
    })
    expect(() => manager.describe(owner, id)).toThrow(/not found/u)
    expect(
      await manager.read(other, sibling, 0, new AbortController().signal),
    ).toMatchObject({ state: 'running' })
  }, 30000)

  it('reports spawn and capture failures without stranding live processes or slots', async () => {
    const { root, temp, manager, owner } = await fixture()
    await expect(
      manager.start(owner, {
        workspace: root,
        command: {
          mode: 'process',
          executable: path.join(root, 'missing-executable'),
        },
        artifactKey: 'missing',
        maxOutputBytes: 4096,
        launch: {},
      }),
    ).rejects.toMatchObject({ code: 'EXEC_START_FAILED' })
    const invalidArtifacts = path.join(root, 'not-a-directory')
    await writeFile(invalidArtifacts, 'file')
    const id = await manager.start(owner, {
      workspace: root,
      command: {
        mode: 'process',
        executable: process.execPath,
        args: ['-e', "process.stdout.write('still executed')"],
      },
      sessionTemp: { ...temp, artifacts: invalidArtifacts },
      artifactKey: 'capture-failed',
      maxOutputBytes: 4096,
      launch: {},
    })
    expect(
      await manager.read(owner, id, 5000, new AbortController().signal),
    ).toMatchObject({
      state: 'exited',
      stdout: 'still executed',
      artifactAvailable: false,
      captureError: expect.any(String),
    })
  })
})
