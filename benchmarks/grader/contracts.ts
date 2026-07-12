import { Type, type Static } from '@sinclair/typebox'
import { BenchmarkCommandSchema } from '../cases/contracts'

const IdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z0-9]+(?:[a-z0-9._-]*[a-z0-9])?$',
})
const HashSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: '^[a-f0-9]{64}$',
})

export const ISOLATED_GRADER_PROTOCOL_VERSION = 1 as const
export const ISOLATED_GRADER_REVISION = 'isolated-grader-v1' as const

const GraderCheckSchema = Type.Object(
  {
    id: IdSchema,
    acceptanceGroupId: IdSchema,
    command: BenchmarkCommandSchema,
  },
  { additionalProperties: false },
)

export const IsolatedGraderInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ISOLATED_GRADER_PROTOCOL_VERSION),
    graderRevision: Type.Literal(ISOLATED_GRADER_REVISION),
    caseIdentity: Type.Object(
      {
        caseId: IdSchema,
        suiteId: IdSchema,
        suiteRevision: IdSchema,
        manifestSha256: HashSchema,
        privateSpecSha256: HashSchema,
        patchSha256: HashSchema,
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
    privateChecks: Type.Array(GraderCheckSchema, {
      minItems: 1,
      maxItems: 64,
    }),
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
  },
  { additionalProperties: false },
)
export type IsolatedGraderInput = Static<typeof IsolatedGraderInputSchema>

export const GraderCommandOutcomeSchema = Type.Object(
  {
    stage: Type.Union([
      Type.Literal('setup'),
      Type.Literal('public'),
      Type.Literal('private'),
    ]),
    id: IdSchema,
    acceptanceGroupId: Type.Optional(IdSchema),
    passed: Type.Boolean(),
    exitCode: Type.Integer(),
    timedOut: Type.Boolean(),
    durationMs: Type.Number({ minimum: 0 }),
    stdoutSha256: HashSchema,
    stderrSha256: HashSchema,
    failureCategory: Type.Union([
      Type.Literal('none'),
      Type.Literal('exit_nonzero'),
      Type.Literal('timed_out'),
      Type.Literal('execution_error'),
    ]),
  },
  { additionalProperties: false },
)
export type GraderCommandOutcome = Static<typeof GraderCommandOutcomeSchema>

export const IsolatedGraderOutputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(ISOLATED_GRADER_PROTOCOL_VERSION),
    graderRevision: Type.Literal(ISOLATED_GRADER_REVISION),
    status: Type.Union([Type.Literal('completed'), Type.Literal('failed')]),
    inputSha256: HashSchema,
    caseId: IdSchema,
    startedAt: Type.String({ format: 'date-time' }),
    completedAt: Type.String({ format: 'date-time' }),
    durationMs: Type.Number({ minimum: 0 }),
    commands: Type.Array(GraderCommandOutcomeSchema, { maxItems: 112 }),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 128 }),
          message: Type.String({ maxLength: 4_096 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
export type IsolatedGraderOutput = Static<typeof IsolatedGraderOutputSchema>

export interface IsolatedGraderSandboxEvidence {
  networkDisabled: boolean
  readOnlyRoot: boolean
  nonRoot: boolean
  capabilitiesDropped: boolean
  noNewPrivileges: boolean
  boundedResources: boolean
  privateInputReadOnly: boolean
  dockerSocketAbsent: boolean
}

export interface IsolatedGraderRunResult {
  schemaVersion: typeof ISOLATED_GRADER_PROTOCOL_VERSION
  status: 'completed' | 'attempted' | 'invalid' | 'unsupported'
  graderRevision: typeof ISOLATED_GRADER_REVISION
  graderImageDigest: string
  inputSha256: string
  startedAt: string
  completedAt: string
  durationMs: number
  patch: {
    sha256: string
    present: boolean
    applies: boolean
    scopeCompliant: boolean
    hygienePassed: boolean
  }
  sandbox: IsolatedGraderSandboxEvidence
  inputImmutable: boolean
  output?: IsolatedGraderOutput
  cleanup: { containerRemoved: boolean; privateDirectoryRemoved: boolean }
  artifacts: {
    directory: string
    rawReportPath?: string
    stdoutPath: string
    stderrPath: string
    coordinatorResultPath: string
  }
  error?: { code: string; message: string }
}
