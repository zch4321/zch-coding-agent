import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectModule } from '../../shared/project-model'
import { PathGuard } from '../safety/path-guard'

const MAX_DEPTH = 3
const MAX_MODULES = 64
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.zch',
  'node_modules',
  'dist',
  'dist-electron',
  'build',
  'coverage',
  'target',
  '.venv',
  '.cache',
  '.vite',
  '.turbo',
])

const MANIFEST_LANGUAGES: Record<string, string[]> = {
  'package.json': ['typescript', 'javascript'],
  'pnpm-workspace.yaml': ['typescript', 'javascript'],
  'tsconfig.json': ['typescript'],
  'vite.config.ts': ['typescript'],
  'pyproject.toml': ['python'],
  'requirements.txt': ['python'],
  'go.mod': ['go'],
  'Cargo.toml': ['rust'],
  'pom.xml': ['java'],
  'build.gradle': ['java'],
  'build.gradle.kts': ['java', 'kotlin'],
  'CMakeLists.txt': ['cpp'],
}

function toPortable(relativePath: string): string {
  return relativePath.split(path.sep).join('/') || '.'
}

function moduleId(root: string): string {
  const normalized =
    root === '.' ? 'root' : root.replace(/[^a-zA-Z0-9]+/gu, '-')
  return normalized.replace(/^-|-$/gu, '').toLowerCase() || 'root'
}

function moduleName(root: string): string {
  if (root === '.') return 'workspace'
  return root.split('/').filter(Boolean).at(-1) ?? root
}

function fingerprint(input: {
  root: string
  manifests: readonly string[]
  languages: readonly string[]
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16)
}

async function pathExists(workspace: string, relativePath: string) {
  try {
    await stat(path.join(workspace, relativePath))
    return true
  } catch {
    return false
  }
}

async function childDirectories(workspace: string, root: string) {
  const absolute = path.join(workspace, root)
  const entries = await readdir(absolute, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !EXCLUDED_DIRECTORIES.has(entry.name))
    .map((entry) => toPortable(path.join(root, entry.name)))
}

async function discoverRoots(workspace: string): Promise<string[]> {
  const roots = new Set<string>(['.'])
  const queue: Array<{ root: string; depth: number }> = [
    { root: '.', depth: 0 },
  ]

  while (queue.length > 0 && roots.size < MAX_MODULES * 4) {
    const current = queue.shift()!
    if (current.depth >= MAX_DEPTH) continue

    let children: string[]
    try {
      children = await childDirectories(workspace, current.root)
    } catch {
      continue
    }

    for (const child of children) {
      roots.add(child)
      queue.push({ root: child, depth: current.depth + 1 })
    }
  }

  return [...roots]
}

async function manifestsForRoot(
  workspace: string,
  root: string,
): Promise<string[]> {
  const manifests: string[] = []

  for (const manifest of Object.keys(MANIFEST_LANGUAGES)) {
    const relative = toPortable(path.join(root, manifest))
    if (await pathExists(workspace, relative)) {
      manifests.push(relative)
    }
  }

  return manifests
}

function languagesForManifests(manifests: readonly string[]): string[] {
  const languages = new Set<string>()

  for (const manifest of manifests) {
    const basename = path.posix.basename(manifest)
    for (const language of MANIFEST_LANGUAGES[basename] ?? []) {
      languages.add(language)
    }
  }

  return [...languages].sort()
}

async function existingRoots(
  workspace: string,
  root: string,
  candidates: readonly string[],
): Promise<string[]> {
  const found: string[] = []

  for (const candidate of candidates) {
    const relative = toPortable(path.join(root, candidate))
    if (await pathExists(workspace, relative)) {
      found.push(relative)
    }
  }

  return found
}

export class ProjectModuleDetector {
  async detect(workspace: string): Promise<ProjectModule[]> {
    const guard = await PathGuard.create(workspace)
    const roots = await discoverRoots(guard.workspacePath)
    const modules: ProjectModule[] = []
    const updatedAt = new Date().toISOString()

    for (const root of roots) {
      const manifests = await manifestsForRoot(guard.workspacePath, root)
      if (manifests.length === 0) continue

      const languages = languagesForManifests(manifests)
      const sourceRoots = await existingRoots(guard.workspacePath, root, [
        'src',
        'app',
        'lib',
        'packages',
      ])
      const testRoots = await existingRoots(guard.workspacePath, root, [
        'test',
        'tests',
        '__tests__',
        'spec',
        'e2e',
      ])
      const excludedRoots = ['node_modules', 'dist', 'build', 'target', '.venv']
        .map((entry) => toPortable(path.join(root, entry)))
        .filter((entry) => entry !== '.')

      modules.push({
        id: moduleId(root),
        root,
        name: moduleName(root),
        languages,
        manifests,
        sourceRoots,
        testRoots,
        excludedRoots,
        backendHints: languages.length > 0 ? ['serena'] : [],
        source: 'detected',
        confidence: root === '.' ? 0.7 : 0.82,
        fingerprint: fingerprint({ root, manifests, languages }),
        updatedAt,
      })

      if (modules.length >= MAX_MODULES) break
    }

    return modules
  }
}
