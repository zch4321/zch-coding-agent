import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  compileSchema,
  formatSchemaErrors,
} from '../../electron/schema-validator'
import {
  BenchmarkArchiveSchema,
  BENCHMARK_CASE_INTERNAL,
  BenchmarkCaseSchema,
  BenchmarkSuiteSchema,
  PrivateCaseSpecSchema,
  type BenchmarkArchive,
  type BenchmarkCase,
  type BenchmarkSuite,
  type LoadedBenchmarkCase,
  type LoadedBenchmarkSuite,
  type PrivateCaseSpec,
} from './contracts'
import { archiveTreeSha256, sha256Bytes } from './hash'

const MAX_SUITE_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_PRIVATE_SPEC_BYTES = 8 * 1024 * 1024
const validateSuite = compileSchema(BenchmarkSuiteSchema)
const validateCase = compileSchema(BenchmarkCaseSchema)
const validateArchive = compileSchema(BenchmarkArchiveSchema)
const validatePrivateSpec = compileSchema(PrivateCaseSpecSchema)

/** Reports malformed or inconsistent benchmark case metadata. */
export class BenchmarkCaseValidationError extends Error {
  readonly code = 'BENCHMARK_CASE_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'BenchmarkCaseValidationError'
  }
}

/** Loads and validates a benchmark suite manifest and its cases under the trusted benchmark root. */
export async function loadBenchmarkSuite(input: {
  benchmarkRoot: string
  suiteFile: string
}): Promise<LoadedBenchmarkSuite> {
  const benchmarkRoot = await realpath(input.benchmarkRoot)
  const suitePath = await resolveContainedFile(
    benchmarkRoot,
    input.suiteFile,
    'suite file',
  )
  const suiteRaw = await readBounded(suitePath, MAX_SUITE_BYTES, 'suite')
  const suite = parseAndValidate<BenchmarkSuite>(
    suiteRaw,
    validateSuite,
    'suite',
  )
  assertUnique(
    suite.cases.map((entry) => entry.id),
    'suite case id',
  )

  const cases: LoadedBenchmarkCase[] = []
  for (const entry of suite.cases) {
    const manifestPath = await resolveContainedFile(
      benchmarkRoot,
      entry.manifest,
      'case manifest',
    )
    const manifestRaw = await readBounded(
      manifestPath,
      MAX_MANIFEST_BYTES,
      'case manifest',
    )
    const manifestSha256 = sha256Bytes(manifestRaw)
    if (manifestSha256 !== entry.manifestSha256) {
      throw new BenchmarkCaseValidationError(
        `Manifest checksum mismatch for ${entry.id}`,
      )
    }
    const manifest = parseAndValidate<BenchmarkCase>(
      manifestRaw,
      validateCase,
      `case ${entry.id}`,
    )
    validateManifestRelationships(manifest, suite, entry.id)
    const archivePath = await resolveContainedFile(
      benchmarkRoot,
      manifest.repository.archive,
      'case archive',
    )
    const archiveRaw = await readBounded(
      archivePath,
      MAX_ARCHIVE_BYTES,
      'case archive',
    )
    if (sha256Bytes(archiveRaw) !== manifest.repository.archiveSha256) {
      throw new BenchmarkCaseValidationError(
        `Archive checksum mismatch for ${entry.id}`,
      )
    }
    const archive = parseAndValidate<BenchmarkArchive>(
      archiveRaw,
      validateArchive,
      `archive ${entry.id}`,
    )
    validateArchiveRelationships(archive, manifest)

    const privateSpecPath = await resolveContainedFile(
      benchmarkRoot,
      path.posix.join('private', suite.id, `${entry.id}.json`),
      'private case spec',
    )
    const privateRaw = await readBounded(
      privateSpecPath,
      MAX_PRIVATE_SPEC_BYTES,
      'private case spec',
    )
    if (sha256Bytes(privateRaw) !== manifest.grader.privateSpecSha256) {
      throw new BenchmarkCaseValidationError(
        `Private spec checksum mismatch for ${entry.id}`,
      )
    }
    const privateSpec = parseAndValidate<PrivateCaseSpec>(
      privateRaw,
      validatePrivateSpec,
      `private spec ${entry.id}`,
    )
    validatePrivateRelationships(privateSpec, manifest)
    cases.push({
      manifest,
      identity: {
        manifestSha256,
        archiveSha256: manifest.repository.archiveSha256,
        treeSha256: manifest.repository.treeSha256,
        privateSpecSha256: manifest.grader.privateSpecSha256,
      },
      [BENCHMARK_CASE_INTERNAL]: { archivePath, privateSpecPath },
    })
  }
  return {
    suite,
    suiteSha256: sha256Bytes(suiteRaw),
    cases,
  }
}

/** Reads and validates the private evaluator specification for a loaded case. */
export async function loadPrivateCaseSpec(
  loaded: LoadedBenchmarkCase,
): Promise<PrivateCaseSpec> {
  const raw = await readBounded(
    loaded[BENCHMARK_CASE_INTERNAL].privateSpecPath,
    MAX_PRIVATE_SPEC_BYTES,
    'private case spec',
  )
  if (sha256Bytes(raw) !== loaded.identity.privateSpecSha256) {
    throw new BenchmarkCaseValidationError('Private spec changed after load')
  }
  const spec = parseAndValidate<PrivateCaseSpec>(
    raw,
    validatePrivateSpec,
    'private case spec',
  )
  validatePrivateRelationships(spec, loaded.manifest)
  return spec
}

/** Reads and validates the archived workspace files for a loaded case. */
export async function loadCaseArchive(
  loaded: LoadedBenchmarkCase,
): Promise<BenchmarkArchive> {
  const raw = await readBounded(
    loaded[BENCHMARK_CASE_INTERNAL].archivePath,
    MAX_ARCHIVE_BYTES,
    'case archive',
  )
  if (sha256Bytes(raw) !== loaded.identity.archiveSha256) {
    throw new BenchmarkCaseValidationError('Case archive changed after load')
  }
  const archive = parseAndValidate<BenchmarkArchive>(
    raw,
    validateArchive,
    'case archive',
  )
  validateArchiveRelationships(archive, loaded.manifest)
  return archive
}

function validateManifestRelationships(
  manifest: BenchmarkCase,
  suite: BenchmarkSuite,
  expectedId: string,
): void {
  if (
    manifest.id !== expectedId ||
    manifest.suite.id !== suite.id ||
    manifest.suite.revision !== suite.revision
  ) {
    throw new BenchmarkCaseValidationError(
      `Case identity does not match suite entry: ${expectedId}`,
    )
  }
  const imageDigest = manifest.caseImage.reference.split('@').at(-1)
  if (imageDigest !== manifest.caseImage.digest) {
    throw new BenchmarkCaseValidationError(
      `Case image reference is not pinned to its digest: ${expectedId}`,
    )
  }
  assertUnique(
    manifest.acceptanceGroups.map((group) => group.id),
    'acceptance group id',
  )
  assertUnique(
    manifest.publicChecks.map((check) => check.id),
    'public check id',
  )
  const groupIds = new Set(manifest.acceptanceGroups.map((group) => group.id))
  for (const check of manifest.publicChecks) {
    if (!groupIds.has(check.acceptanceGroupId)) {
      throw new BenchmarkCaseValidationError(
        `Public check references an unknown acceptance group: ${check.id}`,
      )
    }
    validateCommand(check.command)
  }
  for (const command of manifest.setup) validateCommand(command)
  for (const pattern of [
    ...manifest.modificationScope.allowedPaths,
    ...manifest.modificationScope.deniedPaths,
  ]) {
    validateRelativeValue(pattern, 'modification scope pattern', true)
  }
}

function validateArchiveRelationships(
  archive: BenchmarkArchive,
  manifest: BenchmarkCase,
): void {
  assertUnique(
    archive.files.map((file) => file.path),
    'archive path',
  )
  for (const file of archive.files) {
    validateRelativeValue(file.path, 'archive path')
    if (Buffer.byteLength(file.content, 'utf8') > 1024 * 1024) {
      throw new BenchmarkCaseValidationError(
        `Archive file exceeds 1 MiB: ${file.path}`,
      )
    }
  }
  const treeSha256 = archiveTreeSha256(archive)
  if (
    archive.treeSha256 !== treeSha256 ||
    manifest.repository.treeSha256 !== treeSha256
  ) {
    throw new BenchmarkCaseValidationError(
      `Archive tree checksum mismatch for ${manifest.id}`,
    )
  }
}

function validatePrivateRelationships(
  spec: PrivateCaseSpec,
  manifest: BenchmarkCase,
): void {
  if (
    spec.caseId !== manifest.id ||
    spec.suiteId !== manifest.suite.id ||
    spec.suiteRevision !== manifest.suite.revision
  ) {
    throw new BenchmarkCaseValidationError(
      `Private spec identity mismatch for ${manifest.id}`,
    )
  }
  if (spec.mutants.length < manifest.quality.minimumRejectedMutants) {
    throw new BenchmarkCaseValidationError(
      `Private spec has too few mutants for ${manifest.id}`,
    )
  }
  assertUnique(
    spec.checks.map((check) => check.id),
    'private check id',
  )
  assertUnique(
    spec.mutants.map((mutant) => mutant.id),
    'mutant id',
  )
  const groupIds = new Set(manifest.acceptanceGroups.map((group) => group.id))
  for (const check of spec.checks) {
    if (!groupIds.has(check.acceptanceGroupId)) {
      throw new BenchmarkCaseValidationError(
        `Private check references an unknown group: ${check.id}`,
      )
    }
    validateCommand(check.command)
  }
  for (const mutant of spec.mutants) {
    for (const groupId of mutant.expectedFailedGroups) {
      if (!groupIds.has(groupId)) {
        throw new BenchmarkCaseValidationError(
          `Mutant references an unknown group: ${mutant.id}`,
        )
      }
    }
  }
}

function validateCommand(command: {
  executable: string
  args: string[]
  cwd?: string
}): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u.test(command.executable)) {
    throw new BenchmarkCaseValidationError('Command executable is invalid')
  }
  if (command.cwd) validateRelativeValue(command.cwd, 'command cwd')
  for (const argument of command.args) {
    if (/\0/u.test(argument)) {
      throw new BenchmarkCaseValidationError('Command argument contains NUL')
    }
  }
}

function validateRelativeValue(
  value: string,
  label: string,
  allowGlob = false,
): void {
  const normalized = value
  const segments = normalized.split('/')
  if (
    value.includes('\\') ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.includes('\0') ||
    normalized.includes(':') ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        (!allowGlob && /[*?]/u.test(segment)) ||
        (allowGlob && /[*?]/u.test(segment) && segment !== '**') ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    ) ||
    /^[a-zA-Z]:/u.test(normalized)
  ) {
    throw new BenchmarkCaseValidationError(`${label} is unsafe: ${value}`)
  }
}

async function resolveContainedFile(
  root: string,
  relative: string,
  label: string,
): Promise<string> {
  validateRelativeValue(relative, label)
  const candidate = await realpath(path.resolve(root, relative))
  const relation = path.relative(root, candidate)
  if (
    relation === '' ||
    relation === '..' ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new BenchmarkCaseValidationError(`${label} escapes benchmark root`)
  }
  return candidate
}

async function readBounded(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const value = await readFile(filePath)
  if (value.byteLength > maxBytes) {
    throw new BenchmarkCaseValidationError(`${label} exceeds its byte limit`)
  }
  return value
}

function parseAndValidate<T>(
  raw: Buffer,
  validate: ((value: unknown) => boolean) & { errors?: unknown },
  label: string,
): T {
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new BenchmarkCaseValidationError(`${label} is not valid JSON`)
  }
  if (!validate(value)) {
    throw new BenchmarkCaseValidationError(
      `${label}: ${formatSchemaErrors(validate.errors as never)}`,
    )
  }
  return structuredClone(value) as T
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new BenchmarkCaseValidationError(`${label} must be unique`)
  }
}
