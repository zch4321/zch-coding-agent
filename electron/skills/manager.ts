import { createHash, randomUUID } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import path from 'node:path'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'
import type {
  SkillDiagnostic,
  SkillList,
  SkillSource,
  SkillSummary,
} from '../../shared/skills'
import { writeJsonAtomic } from '../config/atomic-file'
import { isPublicNetworkAddress } from '../net/network-address'

export const MAX_SKILL_BYTES = 64 * 1_024
const MAX_SKILLS = 128
const MAX_REDIRECTS = 5
const DOWNLOAD_TIMEOUT_MS = 15_000
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

interface SkillIndexEntry {
  source: SkillSource
  enabled: boolean
  trustedAt?: string
  sha256?: string
}

interface SkillIndexFile {
  version: 1
  files: Record<string, SkillIndexEntry>
}

export interface SkillRecord extends SkillSummary {
  fileName: string
  body: string
}

export class SkillError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SkillError'
  }
}

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

interface DownloadResponse {
  status: number
  location?: string
  body: Buffer
}

export interface SkillsManagerOptions {
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>
  connectHttps?: (
    url: URL,
    address: ResolvedAddress,
    signal: AbortSignal,
  ) => Promise<DownloadResponse>
  now?: () => Date
}

function hash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function diagnostic(
  file: string,
  code: string,
  message: string,
): SkillDiagnostic {
  return { file: file.slice(0, 512), code, message: message.slice(0, 1_024) }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  )
}

function isSkillIndexEntry(value: unknown): value is SkillIndexEntry {
  if (!isPlainObject(value)) {
    return false
  }

  const source = value.source
  const trustedAt = value.trustedAt
  const sha256 = value.sha256
  return (
    (source === 'manual' || source === 'download' || source === 'upload') &&
    typeof value.enabled === 'boolean' &&
    (sha256 === undefined ||
      (typeof sha256 === 'string' && /^[a-f0-9]{64}$/u.test(sha256))) &&
    (trustedAt === undefined ||
      (typeof trustedAt === 'string' && Number.isFinite(Date.parse(trustedAt))))
  )
}

export function parseSkillDocument(
  content: string,
  fileName = 'skill.md',
): Pick<SkillRecord, 'name' | 'description' | 'trigger' | 'body'> {
  const normalized = content.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')

  if (!normalized.startsWith('---\n')) {
    throw new SkillError(
      'INVALID_FRONTMATTER',
      'Skill must start with YAML frontmatter',
    )
  }

  const end = normalized.indexOf('\n---\n', 4)

  if (end < 0) {
    throw new SkillError(
      'INVALID_FRONTMATTER',
      'Skill frontmatter is not closed',
    )
  }

  if (end > 8 * 1_024) {
    throw new SkillError(
      'INVALID_FRONTMATTER',
      'Skill frontmatter exceeds the size limit',
    )
  }

  const frontmatter = normalized.slice(4, end)

  if (/(^|[\s,[{])[*&][A-Za-z0-9_-]+/mu.test(frontmatter)) {
    throw new SkillError(
      'INVALID_YAML',
      'Skill frontmatter must not contain YAML anchors or aliases',
    )
  }

  let metadata: unknown

  try {
    metadata = loadYaml(frontmatter, {
      schema: JSON_SCHEMA,
      json: false,
      filename: fileName,
    })
  } catch {
    throw new SkillError(
      'INVALID_YAML',
      'Skill frontmatter is not valid safe YAML',
    )
  }

  if (!isPlainObject(metadata)) {
    throw new SkillError(
      'INVALID_METADATA',
      'Skill frontmatter must be an object',
    )
  }

  const allowed = new Set(['name', 'description', 'trigger'])

  if (Object.keys(metadata).some((key) => !allowed.has(key))) {
    throw new SkillError(
      'INVALID_METADATA',
      'Skill frontmatter contains unsupported fields',
    )
  }

  const { name, description, trigger } = metadata

  if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
    throw new SkillError(
      'INVALID_NAME',
      'Skill name must use letters, numbers, _ or -',
    )
  }

  if (
    typeof description !== 'string' ||
    description.trim().length === 0 ||
    description.length > 2_048
  ) {
    throw new SkillError(
      'INVALID_DESCRIPTION',
      'Skill description is required and bounded',
    )
  }

  if (
    trigger !== undefined &&
    (typeof trigger !== 'string' || trigger.length > 2_048)
  ) {
    throw new SkillError(
      'INVALID_TRIGGER',
      'Skill trigger must be a bounded string',
    )
  }

  return {
    name,
    description: description.trim(),
    ...(typeof trigger === 'string' && trigger.trim()
      ? { trigger: trigger.trim() }
      : {}),
    body: normalized.slice(end + 5),
  }
}

export function validateSkillUrl(input: string): URL {
  let url: URL

  try {
    url = new URL(input)
  } catch {
    throw new SkillError('INVALID_URL', 'Skill URL is invalid')
  }

  if (url.protocol !== 'https:') {
    throw new SkillError('INVALID_URL', 'Skill URL must use HTTPS')
  }

  if (url.username || url.password) {
    throw new SkillError(
      'INVALID_URL',
      'Skill URL must not contain credentials',
    )
  }

  if (url.port && url.port !== '443') {
    throw new SkillError(
      'INVALID_URL',
      'Skill URL must use the standard HTTPS port',
    )
  }

  return url
}

async function defaultResolveHost(
  hostname: string,
): Promise<ResolvedAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }))
}

function defaultConnectHttps(
  url: URL,
  pinned: ResolvedAddress,
  signal: AbortSignal,
): Promise<DownloadResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: 'GET',
        signal,
        headers: { accept: 'text/markdown,text/plain;q=0.9' },
        lookup: (_hostname, _options, callback) =>
          callback(null, pinned.address, pinned.family),
      },
      (response) => {
        const chunks: Buffer[] = []
        let total = 0

        response.on('data', (chunk: Buffer) => {
          total += chunk.length

          if (total > MAX_SKILL_BYTES) {
            request.destroy(
              new SkillError('TOO_LARGE', 'Downloaded skill is too large'),
            )
            return
          }

          chunks.push(chunk)
        })
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            body: Buffer.concat(chunks),
          }),
        )
      },
    )

    request.on('error', reject)
    request.end()
  })
}

export class SkillsManager {
  readonly #directory: string
  readonly #indexPath: string
  readonly #resolveHost: NonNullable<SkillsManagerOptions['resolveHost']>
  readonly #connectHttps: NonNullable<SkillsManagerOptions['connectHttps']>
  readonly #now: () => Date
  #records = new Map<string, SkillRecord>()
  #diagnostics: SkillDiagnostic[] = []
  #index: SkillIndexFile = { version: 1, files: {} }

  constructor(directory: string, options: SkillsManagerOptions = {}) {
    this.#directory = directory
    this.#indexPath = path.join(directory, 'index.json')
    this.#resolveHost = options.resolveHost ?? defaultResolveHost
    this.#connectHttps = options.connectHttps ?? defaultConnectHttps
    this.#now = options.now ?? (() => new Date())
  }

  async initialize(): Promise<SkillList> {
    await mkdir(this.#directory, { recursive: true })
    await this.#loadIndex()
    return this.refresh()
  }

  list(): SkillList {
    return {
      skills: [...this.#records.values()]
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          ...(skill.trigger ? { trigger: skill.trigger } : {}),
          enabled: skill.enabled,
          source: skill.source,
          sha256: skill.sha256,
          ...(skill.trustedAt ? { trustedAt: skill.trustedAt } : {}),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      diagnostics: structuredClone(this.#diagnostics.slice(0, 256)),
    }
  }

  read(name: string): SkillRecord | undefined {
    if (!SKILL_NAME.test(name)) {
      return undefined
    }

    const skill = this.#records.get(name)
    return skill?.enabled ? structuredClone(skill) : undefined
  }

  summaryPrompt(maxChars = 12_000): string {
    const enabled = [...this.#records.values()]
      .filter((skill) => skill.enabled)
      .sort((left, right) => left.name.localeCompare(right.name))

    if (enabled.length === 0) {
      return ''
    }

    const heading =
      'Available skills (call read_skill with the exact name before following one):\n'
    const namesOnly = enabled.map((skill) => `- ${skill.name}`).join('\n')
    const minimum = `${heading}${namesOnly}`

    if (minimum.length > maxChars) {
      throw new SkillError(
        'SUMMARY_LIMIT',
        'Enabled skill names exceed the summary budget',
      )
    }

    let result = heading

    for (const [index, skill] of enabled.entries()) {
      const suffix = enabled
        .slice(index + 1)
        .map((candidate) => `- ${candidate.name}\n`)
        .join('')
      const detail = `- ${skill.name}: ${skill.description}${skill.trigger ? ` Trigger: ${skill.trigger}` : ''}\n`
      result +=
        result.length + detail.length + suffix.length <= maxChars
          ? detail
          : `- ${skill.name}\n`
    }

    return result.trimEnd()
  }

  async refresh(): Promise<SkillList> {
    const diagnostics = this.#diagnostics.filter(
      (item) => item.file === 'index.json',
    )
    const next = new Map<string, SkillRecord>()
    const entries = await readdir(this.#directory, { withFileTypes: true })

    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.name.toLowerCase().endsWith('.md')) {
        continue
      }

      if (next.size >= MAX_SKILLS) {
        diagnostics.push(
          diagnostic(entry.name, 'TOO_MANY_SKILLS', 'Skill limit reached'),
        )
        continue
      }

      const filePath = path.join(this.#directory, entry.name)

      try {
        const fileStat = await lstat(filePath)

        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          throw new SkillError(
            'UNSAFE_FILE',
            'Skill must be a regular non-symlink file',
          )
        }

        if (fileStat.size > MAX_SKILL_BYTES) {
          throw new SkillError('TOO_LARGE', 'Skill file exceeds the size limit')
        }

        const bytes = await this.#readBoundedRegularFile(filePath)
        const parsed = parseSkillDocument(bytes.toString('utf8'), entry.name)

        if (next.has(parsed.name)) {
          throw new SkillError(
            'DUPLICATE_NAME',
            `Duplicate skill name: ${parsed.name}`,
          )
        }

        const saved = this.#index.files[entry.name]
        const currentHash = hash(bytes)
        const contentTrusted = saved?.sha256 === currentHash
        next.set(parsed.name, {
          ...parsed,
          fileName: entry.name,
          source: saved?.source ?? 'manual',
          enabled: Boolean(saved?.enabled && contentTrusted),
          trustedAt: contentTrusted ? saved?.trustedAt : undefined,
          sha256: currentHash,
        })
        this.#index.files[entry.name] = {
          source: saved?.source ?? 'manual',
          enabled: Boolean(saved?.enabled && contentTrusted),
          ...(contentTrusted && saved?.trustedAt
            ? { trustedAt: saved.trustedAt }
            : {}),
          sha256: currentHash,
        }
      } catch (error) {
        diagnostics.push(
          diagnostic(
            entry.name,
            error instanceof SkillError ? error.code : 'READ_FAILED',
            error instanceof Error ? error.message : 'Unable to read skill',
          ),
        )
      }
    }

    const present = new Set([...next.values()].map((skill) => skill.fileName))
    this.#index.files = Object.fromEntries(
      Object.entries(this.#index.files).filter(([fileName]) =>
        present.has(fileName),
      ),
    )
    this.#records = next
    this.#diagnostics = diagnostics
    await writeJsonAtomic(this.#indexPath, this.#index)
    return this.list()
  }

  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    const skill = this.#records.get(name)

    if (!skill) {
      return false
    }

    skill.enabled = enabled
    skill.trustedAt = enabled
      ? (skill.trustedAt ?? this.#now().toISOString())
      : skill.trustedAt
    this.#index.files[skill.fileName] = {
      source: skill.source,
      enabled,
      trustedAt: skill.trustedAt,
      sha256: skill.sha256,
    }
    await writeJsonAtomic(this.#indexPath, this.#index)
    return true
  }

  async installFromFile(filePath: string): Promise<SkillSummary> {
    const fileStat = await lstat(filePath)

    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new SkillError(
        'UNSAFE_FILE',
        'Selected skill must be a regular non-symlink file',
      )
    }

    if (fileStat.size > MAX_SKILL_BYTES) {
      throw new SkillError('TOO_LARGE', 'Selected skill exceeds the size limit')
    }

    return this.#installBytes(
      await this.#readBoundedRegularFile(filePath),
      'upload',
    )
  }

  async installFromUrl(input: string): Promise<SkillSummary> {
    let url = validateSkillUrl(input)
    const controller = new AbortController()
    const timeout = setTimeout(
      () =>
        controller.abort(new SkillError('TIMEOUT', 'Skill download timed out')),
      DOWNLOAD_TIMEOUT_MS,
    )

    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const addresses = await this.#resolveHost(url.hostname)

        if (
          addresses.length === 0 ||
          addresses.some((item) => !isPublicNetworkAddress(item.address))
        ) {
          throw new SkillError(
            'PRIVATE_ADDRESS',
            'Skill URL resolved to a blocked network address',
          )
        }

        const response = await this.#connectHttps(
          url,
          addresses[0]!,
          controller.signal,
        )

        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.location
        ) {
          url = validateSkillUrl(new URL(response.location, url).toString())
          continue
        }

        if (response.status < 200 || response.status >= 300) {
          throw new SkillError(
            'DOWNLOAD_FAILED',
            `Skill download failed with status ${response.status}`,
          )
        }

        if (response.body.length > MAX_SKILL_BYTES) {
          throw new SkillError(
            'TOO_LARGE',
            'Downloaded skill exceeds the size limit',
          )
        }

        return await this.#installBytes(response.body, 'download')
      }

      throw new SkillError(
        'TOO_MANY_REDIRECTS',
        'Skill download redirected too many times',
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  async #installBytes(
    bytes: Buffer,
    source: SkillSource,
  ): Promise<SkillSummary> {
    const parsed = parseSkillDocument(bytes.toString('utf8'))

    if (this.#records.has(parsed.name)) {
      throw new SkillError(
        'DUPLICATE_NAME',
        `Skill already exists: ${parsed.name}`,
      )
    }

    const fileName = `${parsed.name}.md`
    const target = path.join(this.#directory, fileName)
    const temporary = path.join(
      this.#directory,
      `.${fileName}.${randomUUID()}.tmp`,
    )
    const file = await open(temporary, 'wx', 0o600)

    try {
      await file.writeFile(bytes)
      await file.sync()
      await file.close()
      await link(temporary, target)
      await unlink(temporary)
    } catch (error) {
      await file.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)

      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        throw new SkillError(
          'DUPLICATE_NAME',
          `Skill file already exists: ${fileName}`,
        )
      }

      throw error
    }

    this.#index.files[fileName] = {
      source,
      enabled: false,
      sha256: hash(bytes),
    }
    await writeJsonAtomic(this.#indexPath, this.#index)
    await this.refresh()
    return this.list().skills.find((skill) => skill.name === parsed.name)!
  }

  async #loadIndex(): Promise<void> {
    try {
      const raw = await readFile(this.#indexPath, 'utf8')
      const candidate = JSON.parse(raw) as unknown

      if (
        !isPlainObject(candidate) ||
        candidate.version !== 1 ||
        !isPlainObject(candidate.files)
      ) {
        throw new Error('Invalid skill index')
      }

      const files: Record<string, SkillIndexEntry> = {}

      for (const [fileName, value] of Object.entries(candidate.files)) {
        if (!isSkillIndexEntry(value)) {
          throw new Error('Invalid skill index entry')
        }

        files[fileName] = value
      }

      this.#index = { version: 1, files }
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        this.#diagnostics = [
          diagnostic('index.json', 'INVALID_INDEX', 'Skill index was reset'),
        ]
      }

      this.#index = { version: 1, files: {} }
    }
  }

  async #readBoundedRegularFile(filePath: string): Promise<Buffer> {
    const before = await lstat(filePath)

    if (before.isSymbolicLink() || !before.isFile()) {
      throw new SkillError(
        'UNSAFE_FILE',
        'Skill must be a regular non-symlink file',
      )
    }

    if (before.size > MAX_SKILL_BYTES) {
      throw new SkillError('TOO_LARGE', 'Skill file exceeds the size limit')
    }

    const handle = await open(filePath, 'r')

    try {
      const opened = await handle.stat()

      if (!opened.isFile()) {
        throw new SkillError('UNSAFE_FILE', 'Skill must be a regular file')
      }

      const buffer = Buffer.alloc(Math.min(opened.size, MAX_SKILL_BYTES) + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)

      if (bytesRead > MAX_SKILL_BYTES || opened.size > MAX_SKILL_BYTES) {
        throw new SkillError('TOO_LARGE', 'Skill file exceeds the size limit')
      }

      const after = await lstat(filePath)

      if (
        after.isSymbolicLink() ||
        !after.isFile() ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino
      ) {
        throw new SkillError(
          'UNSAFE_FILE',
          'Skill file changed while it was being read',
        )
      }

      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }
}
