import { Type, type Static } from '@sinclair/typebox'

const IdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$',
})
const Sha256Schema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: '^[a-f0-9]{64}$',
})
const OciDigestSchema = Type.String({
  minLength: 71,
  maxLength: 71,
  pattern: '^sha256:[a-f0-9]{64}$',
})
const RelativePathSchema = Type.String({ minLength: 1, maxLength: 1_024 })

export const BenchmarkCommandSchema = Type.Object(
  {
    executable: Type.String({ minLength: 1, maxLength: 256 }),
    args: Type.Array(Type.String({ maxLength: 8_192 }), { maxItems: 128 }),
    cwd: Type.Optional(RelativePathSchema),
    timeoutMs: Type.Integer({ minimum: 100, maximum: 300_000 }),
    maxOutputBytes: Type.Integer({ minimum: 1_024, maximum: 4_194_304 }),
  },
  { additionalProperties: false },
)
export type BenchmarkCommand = Static<typeof BenchmarkCommandSchema>

export const BenchmarkCaseSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: IdSchema,
    suite: Type.Object(
      {
        id: IdSchema,
        revision: IdSchema,
      },
      { additionalProperties: false },
    ),
    kind: Type.Union([
      Type.Literal('bug-fix'),
      Type.Literal('feature'),
      Type.Literal('refactor'),
      Type.Literal('abstain'),
      Type.Literal('harness-stress'),
    ]),
    task: Type.String({ minLength: 1, maxLength: 65_536 }),
    repository: Type.Object(
      {
        source: Type.Object(
          {
            kind: Type.Union([
              Type.Literal('synthetic'),
              Type.Literal('git'),
              Type.Literal('dataset'),
            ]),
            locator: Type.String({ minLength: 1, maxLength: 2_048 }),
            revision: Type.String({ minLength: 1, maxLength: 256 }),
            license: Type.String({ minLength: 1, maxLength: 256 }),
          },
          { additionalProperties: false },
        ),
        archive: RelativePathSchema,
        archiveSha256: Sha256Schema,
        treeSha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
    platform: Type.Object(
      {
        os: Type.Literal('linux'),
        architecture: Type.Literal('x64'),
        libc: Type.Literal('glibc'),
        nodeMajor: Type.Literal(24),
      },
      { additionalProperties: false },
    ),
    caseImage: Type.Object(
      {
        reference: Type.String({ minLength: 1, maxLength: 512 }),
        digest: OciDigestSchema,
      },
      { additionalProperties: false },
    ),
    setup: Type.Array(BenchmarkCommandSchema, { maxItems: 16 }),
    publicChecks: Type.Array(
      Type.Object(
        {
          id: IdSchema,
          title: Type.String({ minLength: 1, maxLength: 256 }),
          acceptanceGroupId: IdSchema,
          command: BenchmarkCommandSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
    grader: Type.Object(
      {
        adapter: Type.Literal('native-command-v1'),
        protocolVersion: Type.Literal(1),
        privateSpecSha256: Sha256Schema,
      },
      { additionalProperties: false },
    ),
    acceptanceGroups: Type.Array(
      Type.Object(
        {
          id: IdSchema,
          title: Type.String({ minLength: 1, maxLength: 256 }),
          critical: Type.Boolean(),
          weight: Type.Number({ exclusiveMinimum: 0, maximum: 100 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
    feedbackPolicy: Type.Object(
      {
        allowed: Type.Union([
          Type.Literal('none'),
          Type.Literal('public'),
          Type.Literal('diagnostic'),
        ]),
        repairOnceAllowed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    modificationScope: Type.Object(
      {
        allowedPaths: Type.Array(RelativePathSchema, {
          minItems: 1,
          maxItems: 64,
        }),
        deniedPaths: Type.Array(RelativePathSchema, { maxItems: 64 }),
        maxChangedFiles: Type.Integer({ minimum: 1, maximum: 10_000 }),
        maxPatchBytes: Type.Integer({ minimum: 1_024, maximum: 16_777_216 }),
      },
      { additionalProperties: false },
    ),
    resources: Type.Object(
      {
        wallTimeMs: Type.Integer({ minimum: 1_000, maximum: 86_400_000 }),
        cpus: Type.Number({ minimum: 0.1, maximum: 16 }),
        memoryBytes: Type.Integer({
          minimum: 134_217_728,
          maximum: 68_719_476_736,
        }),
        pids: Type.Integer({ minimum: 16, maximum: 4_096 }),
        diskBytes: Type.Integer({
          minimum: 16_777_216,
          maximum: 68_719_476_736,
        }),
        maxAgentSteps: Type.Integer({ minimum: 1, maximum: 512 }),
        maxContextTokens: Type.Integer({ minimum: 1_024, maximum: 10_000_000 }),
      },
      { additionalProperties: false },
    ),
    quality: Type.Object(
      {
        baselineExpected: Type.Union([
          Type.Literal('fail'),
          Type.Literal('pass'),
        ]),
        minimumRejectedMutants: Type.Integer({ minimum: 2, maximum: 16 }),
        repetitions: Type.Literal(3),
        review: Type.Object(
          {
            status: Type.Literal('reviewed'),
            reviewer: Type.String({ minLength: 1, maxLength: 256 }),
            reviewedAt: Type.String({ format: 'date-time' }),
            method: Type.String({ minLength: 1, maxLength: 1_024 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type BenchmarkCase = Static<typeof BenchmarkCaseSchema>

export const BenchmarkSuiteSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: IdSchema,
    revision: IdSchema,
    title: Type.String({ minLength: 1, maxLength: 256 }),
    targetCaseCount: Type.Integer({ minimum: 1, maximum: 10_000 }),
    cases: Type.Array(
      Type.Object(
        {
          id: IdSchema,
          manifest: RelativePathSchema,
          manifestSha256: Sha256Schema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 10_000 },
    ),
  },
  { additionalProperties: false },
)
export type BenchmarkSuite = Static<typeof BenchmarkSuiteSchema>

export const BenchmarkArchiveSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    treeSha256: Sha256Schema,
    files: Type.Array(
      Type.Object(
        {
          path: RelativePathSchema,
          encoding: Type.Literal('utf8'),
          executable: Type.Boolean(),
          content: Type.String({ maxLength: 1_048_576 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 2_000 },
    ),
  },
  { additionalProperties: false },
)
export type BenchmarkArchive = Static<typeof BenchmarkArchiveSchema>

export const PrivateCaseSpecSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    caseId: IdSchema,
    suiteId: IdSchema,
    suiteRevision: IdSchema,
    checks: Type.Array(
      Type.Object(
        {
          id: IdSchema,
          acceptanceGroupId: IdSchema,
          command: BenchmarkCommandSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 64 },
    ),
    oracle: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('patch'),
          patch: Type.String({ minLength: 1, maxLength: 1_048_576 }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { kind: Type.Literal('no-change') },
        { additionalProperties: false },
      ),
    ]),
    mutants: Type.Array(
      Type.Object(
        {
          id: IdSchema,
          description: Type.String({ minLength: 1, maxLength: 1_024 }),
          patch: Type.String({ minLength: 1, maxLength: 1_048_576 }),
          expectedFailedGroups: Type.Array(IdSchema, {
            minItems: 1,
            maxItems: 32,
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: 16 },
    ),
  },
  { additionalProperties: false },
)
export type PrivateCaseSpec = Static<typeof PrivateCaseSpecSchema>

export const BENCHMARK_CASE_INTERNAL: unique symbol = Symbol(
  'benchmark-case-internal',
)

export interface LoadedBenchmarkCase {
  manifest: BenchmarkCase
  identity: {
    manifestSha256: string
    archiveSha256: string
    treeSha256: string
    privateSpecSha256: string
  }
  [BENCHMARK_CASE_INTERNAL]: {
    archivePath: string
    privateSpecPath: string
  }
}

export interface LoadedBenchmarkSuite {
  suite: BenchmarkSuite
  suiteSha256: string
  cases: LoadedBenchmarkCase[]
}

export interface AgentCaseDescriptor {
  schemaVersion: 1
  caseId: string
  suiteId: string
  suiteRevision: string
  task: string
  publicChecks: BenchmarkCase['publicChecks']
  modificationScope: BenchmarkCase['modificationScope']
  resources: BenchmarkCase['resources']
}
