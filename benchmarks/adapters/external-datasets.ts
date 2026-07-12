import type {
  ExternalBenchmarkCandidate,
  ExternalDatasetRelease,
  MonthlyPrivatePayload,
  SweRebenchPrivatePayload,
} from '../cohort/contracts'
import { asyncBufferFromUrl, parquetReadObjects } from 'hyparquet'

export const MONTHLY_SWEBENCH_ADAPTER_REVISION = 'monthly-swebench-v1'
export const SWE_REBENCH_ADAPTER_REVISION = 'swe-rebench-v1'

const MONTHLY_DATASET_PREFIX = 'UnipatAI/Monthly-SWEBench-'
const REBENCH_DATASET = 'nebius/SWE-rebench-leaderboard'
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const REBENCH_PAGE_SIZE = 100

export interface ExternalDatasetCatalog {
  release: ExternalDatasetRelease
  candidates: ExternalBenchmarkCandidate[]
  exclusions: Array<{ caseId: string; reason: 'invalid_fields' }>
}

export interface ExternalDatasetClientOptions {
  fetch?: typeof fetch
}

export async function loadLatestMonthlySwebenchCatalog(
  options: ExternalDatasetClientOptions = {},
): Promise<ExternalDatasetCatalog> {
  const request = options.fetch ?? fetch
  const repositories = await fetchJson<unknown[]>(
    request,
    'https://huggingface.co/api/datasets?author=UnipatAI&search=Monthly-SWEBench&limit=100&full=true',
  )
  const latest = repositories
    .map(parseMonthlyRepository)
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((left, right) => right.release.localeCompare(left.release))[0]
  if (!latest) throw new Error('No Monthly-SWEBench release is available')

  return loadMonthlySwebenchCatalog(latest, options)
}

export async function loadMonthlySwebenchCatalog(
  release: ExternalDatasetRelease,
  options: ExternalDatasetClientOptions = {},
): Promise<ExternalDatasetCatalog> {
  if (release.source !== 'monthly-swebench') {
    throw new Error('Expected a Monthly-SWEBench release')
  }
  const request = options.fetch ?? fetch
  const previewUrl = `https://huggingface.co/datasets/${release.dataset}/resolve/${release.commit}/preview.csv`
  const preview = await fetchText(request, previewUrl)
  const rows = parseCsv(preview)
  const candidates: ExternalBenchmarkCandidate[] = []
  const exclusions: ExternalDatasetCatalog['exclusions'] = []
  for (const row of rows) {
    const candidate = monthlyCandidate(release, row)
    if (candidate) candidates.push(candidate)
    else
      exclusions.push({
        caseId: row.task_id || 'unknown',
        reason: 'invalid_fields',
      })
  }
  return { release, candidates, exclusions }
}

export async function loadLatestSweRebenchCatalog(
  options: ExternalDatasetClientOptions = {},
): Promise<ExternalDatasetCatalog> {
  const request = options.fetch ?? fetch
  const metadataUrl = `https://huggingface.co/api/datasets/${REBENCH_DATASET}`
  const before = await fetchJson<RebenchMetadata>(request, metadataUrl)
  const release = latestRebenchSplit(before)
  const rows: unknown[] = []
  for (let offset = 0; ; offset += REBENCH_PAGE_SIZE) {
    const page = await fetchJson<RebenchRowsPage>(
      request,
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(REBENCH_DATASET)}&config=default&split=${encodeURIComponent(release)}&offset=${offset}&length=${REBENCH_PAGE_SIZE}`,
    )
    rows.push(...page.rows.map((entry) => entry.row))
    if (rows.length >= page.num_rows || page.rows.length === 0) break
  }
  const after = await fetchJson<RebenchMetadata>(request, metadataUrl)
  if (!before.sha || before.sha !== after.sha) {
    throw new Error('SWE-rebench changed while its latest split was loading')
  }

  const datasetRelease: ExternalDatasetRelease = {
    source: 'swe-rebench',
    dataset: REBENCH_DATASET,
    release,
    commit: before.sha,
    adapterRevision: SWE_REBENCH_ADAPTER_REVISION,
  }
  const candidates: ExternalBenchmarkCandidate[] = []
  const exclusions: ExternalDatasetCatalog['exclusions'] = []
  for (const raw of rows) {
    const candidate = rebenchCandidate(datasetRelease, raw)
    if (candidate) candidates.push(candidate)
    else
      exclusions.push({
        caseId: recordString(raw, 'instance_id') || 'unknown',
        reason: 'invalid_fields',
      })
  }
  return { release: datasetRelease, candidates, exclusions }
}

export async function loadSweRebenchCatalog(
  release: ExternalDatasetRelease,
): Promise<ExternalDatasetCatalog> {
  if (release.source !== 'swe-rebench') {
    throw new Error('Expected a SWE-rebench release')
  }
  const url = `https://huggingface.co/datasets/${release.dataset}/resolve/${release.commit}/data/${release.release}-00000-of-00001.parquet`
  const file = await asyncBufferFromUrl({ url })
  const rows = await parquetReadObjects({ file })
  const candidates: ExternalBenchmarkCandidate[] = []
  const exclusions: ExternalDatasetCatalog['exclusions'] = []
  for (const raw of rows) {
    const candidate = rebenchCandidate(release, raw)
    if (candidate) candidates.push(candidate)
    else {
      exclusions.push({
        caseId: recordString(raw, 'instance_id') || 'unknown',
        reason: 'invalid_fields',
      })
    }
  }
  return { release, candidates, exclusions }
}

function parseMonthlyRepository(
  raw: unknown,
): ExternalDatasetRelease | undefined {
  if (!isRecord(raw)) return undefined
  const dataset = stringValue(raw.id)
  const commit = stringValue(raw.sha)
  const match = dataset.match(/^UnipatAI\/Monthly-SWEBench-(\d{4}-\d{2})$/u)
  if (!match || !commit || !/^[a-f0-9]{40,64}$/u.test(commit)) return undefined
  return {
    source: 'monthly-swebench',
    dataset,
    release: match[1]!,
    commit,
    adapterRevision: MONTHLY_SWEBENCH_ADAPTER_REVISION,
  }
}

function monthlyCandidate(
  release: ExternalDatasetRelease,
  row: Record<string, string>,
): ExternalBenchmarkCandidate | undefined {
  const caseId = row.task_id
  const bucket = row.bucket
  const classification =
    bucket === 'bugfix'
      ? 'bug-fix'
      : bucket === 'non_bugfix'
        ? 'non-bug'
        : undefined
  const repository = caseId ? monthlyRepository(caseId) : undefined
  if (
    !caseId ||
    !classification ||
    !repository ||
    !safeDatasetPath(row.instruction_md) ||
    !safeDatasetPath(row.task_toml) ||
    !safeDatasetPath(row.environment_dir) ||
    !safeDatasetPath(row.solution_dir) ||
    !safeDatasetPath(row.tests_dir)
  ) {
    return undefined
  }
  const privatePayload: MonthlyPrivatePayload = {
    kind: 'monthly-swebench',
    archiveFile:
      classification === 'bug-fix' ? 'bugfix.tar.zst' : 'non_bugfix.tar.zst',
    instructionPath: row.instruction_md,
    taskPath: row.task_toml,
    environmentPath: row.environment_dir,
    solutionPath: row.solution_dir,
    testsPath: row.tests_dir,
  }
  return {
    ...release,
    caseId,
    repository,
    classification,
    language: 'unknown',
    problemStatement: `Monthly-SWEBench task ${caseId}`,
    baseCommit: caseId.split('_').at(-2) ?? release.commit,
    patchBytes: 0,
    officialImageReference: `${release.dataset}:${caseId}`,
    privatePayload,
  }
}

function rebenchCandidate(
  release: ExternalDatasetRelease,
  raw: unknown,
): ExternalBenchmarkCandidate | undefined {
  if (!isRecord(raw)) return undefined
  const caseId = stringValue(raw.instance_id)
  const repository = stringValue(raw.repo)
  const baseCommit = stringValue(raw.base_commit)
  const problemStatement = stringValue(raw.problem_statement)
  const solutionPatch = stringValue(raw.patch)
  const testPatch = stringValue(raw.test_patch)
  const officialImageReference = stringValue(raw.docker_image)
  const failToPass = stringArray(raw.FAIL_TO_PASS)
  const passToPass = stringArray(raw.PASS_TO_PASS)
  if (
    !caseId ||
    !repository ||
    !baseCommit ||
    !problemStatement ||
    !solutionPatch ||
    !testPatch ||
    !officialImageReference ||
    failToPass.length === 0
  ) {
    return undefined
  }
  const privatePayload: SweRebenchPrivatePayload = {
    kind: 'swe-rebench',
    solutionPatch,
    testPatch,
    failToPass,
    passToPass,
    verifier: {
      installConfig: raw.install_config,
      interface: raw.interface,
      verifierTimeoutSeconds: raw.harbor_verifier_timeout_sec,
    },
  }
  return {
    ...release,
    caseId,
    repository,
    classification: 'bug-fix',
    language: inferRebenchLanguage(raw),
    problemStatement,
    baseCommit,
    patchBytes: Buffer.byteLength(solutionPatch, 'utf8'),
    officialImageReference,
    privatePayload,
  }
}

function latestRebenchSplit(metadata: RebenchMetadata): string {
  const splits = metadata.cardData?.dataset_info?.splits ?? []
  const latest = splits
    .map((entry) => entry.name)
    .filter((name) => /^\d{4}_\d{2}$/u.test(name))
    .sort()
    .at(-1)
  if (!latest)
    throw new Error('No monthly SWE-rebench leaderboard split is available')
  return latest
}

function monthlyRepository(caseId: string): string | undefined {
  const match = caseId.match(/^(.+?)__(.+)_[a-f0-9]{8}_[a-f0-9]{8}$/u)
  return match ? `${match[1]}/${match[2]}` : undefined
}

function inferRebenchLanguage(raw: Record<string, unknown>): string {
  const details = JSON.stringify([
    raw.interface,
    raw.install_config,
  ]).toLowerCase()
  if (details.includes('pytest') || details.includes('python')) return 'python'
  if (details.includes('go test') || details.includes('golang')) return 'go'
  if (details.includes('cargo')) return 'rust'
  if (
    details.includes('npm') ||
    details.includes('jest') ||
    details.includes('pnpm')
  )
    return 'javascript'
  return 'unknown'
}

function parseCsv(value: string): Array<Record<string, string>> {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') {
      record.push(field)
      field = ''
    } else if (character === '\n') {
      record.push(field.replace(/\r$/u, ''))
      if (record.some(Boolean)) records.push(record)
      record = []
      field = ''
    } else field += character
  }
  if (field || record.length > 0) {
    record.push(field.replace(/\r$/u, ''))
    records.push(record)
  }
  const headers = records.shift() ?? []
  return records.map((fields) =>
    Object.fromEntries(
      headers.map((header, index) => [header, fields[index] ?? '']),
    ),
  )
}

async function fetchJson<T>(request: typeof fetch, url: string): Promise<T> {
  return JSON.parse(await fetchText(request, url)) as T
}

async function fetchText(request: typeof fetch, url: string): Promise<string> {
  const response = await request(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok)
    throw new Error(`Dataset request failed (${response.status}): ${url}`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_RESPONSE_BYTES)
    throw new Error('Dataset response exceeds byte limit')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_RESPONSE_BYTES)
    throw new Error('Dataset response exceeds byte limit')
  return buffer.toString('utf8')
}

function safeDatasetPath(value: string): boolean {
  return (
    Boolean(value) &&
    !value.startsWith('/') &&
    !value.includes('..') &&
    !value.includes('\\')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function recordString(value: unknown, key: string): string {
  return isRecord(value) ? stringValue(value[key]) : ''
}

interface RebenchMetadata {
  sha?: string
  cardData?: { dataset_info?: { splits?: Array<{ name: string }> } }
}

interface RebenchRowsPage {
  rows: Array<{ row: unknown }>
  num_rows: number
}
