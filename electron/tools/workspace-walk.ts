import { readDirectory as readdir } from '../common/filesystem'
import path from 'node:path'
import { normalizePortablePath } from './portable-path'
import { PathGuard } from '../safety/path-guard'

export const DEFAULT_MAX_ENTRIES = 200

export interface WalkedFile {
  path: string
}

/**
 * Depth-first workspace file walk. Skips symlinks and the large generated
 * folders (node_modules, .git, dist) so recursive directory listings stay
 * bounded without following ignore-file semantics.
 */
export async function walkFiles(
  guard: PathGuard,
  rootInput: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const root = await guard.resolveExisting(rootInput)
  const files: WalkedFile[] = []
  const directories = [root.realPath]
  let truncated = false

  while (directories.length > 0) {
    if (signal?.aborted) {
      throw signal.reason
    }

    const current = directories.pop()

    if (!current) {
      break
    }

    const entries = await readdir(current, { withFileTypes: true })

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name)
      const rootRelativePath = normalizePortablePath(
        path.relative(root.rootPath, absolutePath),
      )
      const relativePath =
        root.rootKind === 'workspace' ? rootRelativePath : absolutePath

      if (entry.isSymbolicLink()) {
        continue
      }

      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist'
        ) {
          continue
        }

        directories.push(absolutePath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      guard.assertInside(absolutePath)
      files.push({ path: relativePath })

      if (files.length >= maxResults) {
        truncated = true
        return { files, truncated }
      }
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path))
  return { files, truncated }
}
