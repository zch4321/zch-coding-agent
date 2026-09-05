import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import MarkdownIt from 'markdown-it'
import { getFileInfo } from 'prettier'

const markdown = new MarkdownIt({ html: false })
const ROOT_DOCUMENTS = ['README.md', 'AGENTS.md', 'electron/tooling/README.md']

/** Finds maintained Markdown documents without scanning generated or prompt files. */
export async function documentationFiles(root) {
  const files = [...ROOT_DOCUMENTS]
  const ignoreOptions = {
    ignorePath: [
      path.join(root, '.gitignore'),
      path.join(root, '.prettierignore'),
    ],
  }

  /** Walks the documentation tree in stable order. */
  async function walk(directory) {
    const entries = await readdir(path.join(root, directory), {
      withFileTypes: true,
    })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`
      if ((await getFileInfo(path.join(root, file), ignoreOptions)).ignored)
        continue
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && file.endsWith('.md')) files.push(file)
    }
  }

  await walk('docs')
  return files
}

/** Extracts rendered Markdown links and GitHub-style heading anchors, ignoring examples. */
export function parseDocumentation(source) {
  const tokens = markdown.parse(source, {})
  const references = []
  const anchors = new Set()

  /** Collects link/image destinations while inheriting their block source line. */
  function walk(items, inheritedLine = 1) {
    for (const token of items) {
      const line = token.map ? token.map[0] + 1 : inheritedLine
      const href =
        token.type === 'link_open'
          ? token.attrGet('href')
          : token.type === 'image'
            ? token.attrGet('src')
            : null
      if (href !== null) references.push({ href, line })
      if (token.children) walk(token.children, line)
    }
  }

  walk(tokens)
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'heading_open') continue
    const content = (tokens[index + 1]?.children ?? [])
      .filter((token) => ['text', 'code_inline', 'image'].includes(token.type))
      .map((token) => token.content)
      .join('')
    const base = content
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '')
      .replace(/\s/gu, '-')
    let anchor = base
    let duplicate = 0
    while (anchors.has(anchor)) anchor = `${base}-${++duplicate}`
    anchors.add(anchor)
  }
  return { references, anchors }
}

/** Checks local document targets and fragments without issuing network requests. */
export async function checkDocumentation(root, files) {
  const failures = []
  const sources = new Map()
  const directories = new Map()
  let referenceCount = 0

  /** Caches source reads for repeated links to the same document or code file. */
  function source(file) {
    if (!sources.has(file)) sources.set(file, readFile(file, 'utf8'))
    return sources.get(file)
  }

  /** Checks spelling on case-insensitive hosts so links remain portable. */
  async function exactPath(relative) {
    let directory = root
    for (const part of relative.split(path.sep).filter(Boolean)) {
      if (!directories.has(directory)) {
        directories.set(directory, readdir(directory))
      }
      if (!(await directories.get(directory)).includes(part)) return false
      directory = path.join(directory, part)
    }
    return true
  }

  for (const file of files) {
    const absolute = path.resolve(root, file)
    let parsed
    try {
      parsed = parseDocumentation(await source(absolute))
    } catch (error) {
      failures.push(
        `${file}: cannot read document (${error.code ?? error.message})`,
      )
      continue
    }
    for (const { href, line } of parsed.references) {
      if (/^(?:https?:|mailto:|\/\/)/iu.test(href)) continue
      referenceCount += 1
      try {
        const hashIndex = href.indexOf('#')
        const rawPath = hashIndex < 0 ? href : href.slice(0, hashIndex)
        const fragment =
          hashIndex < 0 ? '' : decodeURIComponent(href.slice(hashIndex + 1))
        const targetPath = decodeURIComponent(rawPath.split('?')[0])
        if (
          path.win32.isAbsolute(targetPath) ||
          /^[a-z][a-z\d+.-]*:/iu.test(targetPath)
        ) {
          throw new Error('use a repository-relative link')
        }
        if (targetPath.includes('\\'))
          throw new Error('use forward slashes in links')
        const target = targetPath
          ? path.resolve(path.dirname(absolute), targetPath)
          : absolute
        const relative = path.relative(root, target)
        if (
          relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw new Error('target leaves the repository')
        }
        const info = await stat(target)
        if (!(await exactPath(relative)))
          throw new Error('target spelling/case does not match')
        if (!fragment) continue
        if (!info.isFile())
          throw new Error('directory link cannot have a fragment')
        if (target.endsWith('.md')) {
          const document = parseDocumentation(await source(target))
          if (!document.anchors.has(fragment))
            throw new Error(`missing heading #${fragment}`)
        } else {
          const range = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(fragment)
          if (!range)
            throw new Error(
              'code links only support #L<number> or #L<start>-L<end>',
            )
          const start = Number(range[1])
          const end = Number(range[2] ?? range[1])
          const lines = (await source(target))
            .replace(/\r?\n$/u, '')
            .split('\n').length
          if (start > end || end > lines)
            throw new Error('code line anchor is out of range')
        }
      } catch (error) {
        failures.push(
          `${file}:${line}: ${href} — ${error.code ?? error.message}`,
        )
      }
    }
  }
  return { failures, referenceCount, documentCount: files.length }
}

/** Runs the repository documentation gate and reports every broken local reference. */
async function main() {
  const root = process.cwd()
  const result = await checkDocumentation(root, await documentationFiles(root))
  if (result.failures.length) {
    process.stderr.write(`${result.failures.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `Checked ${result.documentCount} documents and ${result.referenceCount} local references.\n`,
    )
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main()
}
