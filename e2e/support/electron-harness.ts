import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface ElectronHarness {
  electronApp: ElectronApplication
  electronProcess: ChildProcess
  page: Page
  temporaryRoot: string
  userDataPath: string
  workspace: string
}

export function cleanEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  delete env.VITE_DEV_SERVER_URL
  return env
}

export async function launchElectronHarness(
  temporaryDirectoryPrefix: string,
): Promise<ElectronHarness> {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), temporaryDirectoryPrefix),
  )
  const workspace = path.join(temporaryRoot, 'workspace')
  await mkdir(workspace)
  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${path.join(temporaryRoot, 'user-data')}`],
    env: cleanEnvironment(),
  })

  return {
    electronApp,
    electronProcess: electronApp.process(),
    page: await electronApp.firstWindow(),
    temporaryRoot,
    userDataPath: await electronApp.evaluate(({ app }) =>
      app.getPath('userData'),
    ),
    workspace,
  }
}

export async function closeElectronApplication(
  harness: ElectronHarness,
): Promise<void> {
  if (
    harness.electronProcess.exitCode === null &&
    harness.electronProcess.signalCode === null
  ) {
    await harness.electronApp.close()
  }
}

export async function disposeElectronHarness(
  harness: ElectronHarness,
): Promise<void> {
  await closeElectronApplication(harness)
  await rm(harness.temporaryRoot, { recursive: true, force: true })
}
