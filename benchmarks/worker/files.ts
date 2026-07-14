import { createReadStream, createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

export async function ensureSafeRunDirectories(input: {
  workspace: string
  artifacts: string
}): Promise<{ workspace: string; artifacts: string }> {
  await mkdir(input.artifacts, { recursive: true })
  const [workspace, artifacts] = await Promise.all([
    realpath(input.workspace),
    realpath(input.artifacts),
  ])
  if (
    workspace === artifacts ||
    isInside(workspace, artifacts) ||
    isInside(artifacts, workspace)
  ) {
    throw new Error('Workspace and artifacts directories must not overlap')
  }
  rejectDockerMountDelimiter(workspace)
  rejectDockerMountDelimiter(artifacts)
  return { workspace, artifacts }
}

export async function directoryBytes(root: string): Promise<number> {
  let total = 0
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile()) total += (await lstat(entryPath)).size
    }
  }
  return total
}

export async function writePrivateFile(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFile(filePath, content, { encoding: 'utf8', mode: 0o444 })
}

export async function copyBoundedFile(input: {
  source: string
  destination: string
  maxBytes: number
}): Promise<void> {
  const sourceStat = await lstat(input.source)
  if (!sourceStat.isFile()) throw new Error('Expected a regular file')
  if (sourceStat.size > input.maxBytes) {
    throw new Error('File exceeds configured byte limit')
  }
  await pipeline(
    createReadStream(input.source),
    createWriteStream(input.destination, { mode: 0o600 }),
  )
}

export async function removePrivateDirectory(
  directory: string,
): Promise<boolean> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
    return true
  } catch {
    return false
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  )
}

function rejectDockerMountDelimiter(value: string): void {
  if (value.includes(',') || /[\r\n\0]/u.test(value)) {
    throw new Error('Docker bind mount path contains an unsupported character')
  }
}
