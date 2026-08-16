import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import type { TSchema } from '@sinclair/typebox'
import {
  AppBootstrapResultSchema,
  DOMAIN_STATE_API_CONTRACTS,
  DomainStateEventSchema,
  DurableRunStartPayloadSchema,
  DurableRunStartResultSchema,
  FileChangeCommittedChangeSchema,
  MessageListPayloadSchema,
  ProjectCommittedChangeSchema,
  SessionCommittedChangeSchema,
  SessionRemovedChangeSchema,
  SessionUpdatePatchSchema,
  type DomainStateApiPayload,
  type DomainStateEvent,
} from './domain-state-api'
import { MAX_MESSAGE_PAGE_RECORDS } from './durable'
import {
  assertFileChangeSummarySemantics,
  EMPTY_FILE_SHA256,
  FileChangePageSchema,
  FileChangeSummarySchema,
  type FileChangeSummary,
} from './file-change'
import type {
  CallId,
  FileChangeId,
  MessageId,
  ProjectId,
  SessionId,
} from './ids'
import { assertBoundedJsonValue, type JsonValueLimits } from './json'
import {
  assertMessagePageSemantics,
  assertMessageRecordSemantics,
  MessagePageSchema,
  MessageRecordSchema,
  type MessagePage,
  type MessageRecord,
} from './message'
import {
  assertModelRouteSnapshotSafe,
  ModelRouteSnapshotSchema,
  type ModelRouteSnapshot,
} from './model-route'
import { ProjectRecordSchema, type ProjectRecord } from './project'
import {
  assertSessionPageSemantics,
  assertSessionSnapshotSemantics,
  SessionPageSchema,
  SessionRecordSchema,
  SessionSnapshotSchema,
  type SessionRecord,
} from './session'
import { ActiveRunPublicSnapshotSchema } from './runtime-state'

const projectId = 'project:one' as ProjectId
const sessionId = 'session:one' as SessionId
const callId = 'call:one' as CallId
const hash = 'a'.repeat(64)
const timestamp = '2026-07-22T12:00:00.000Z'

function createSchemaCompiler(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: true })
  ajv.addFormat('date-time', {
    type: 'string',
    validate(value: string) {
      return (
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
          value,
        ) && Number.isFinite(Date.parse(value))
      )
    },
  })
  return ajv
}

const schemaCompiler = createSchemaCompiler()

function compileSchema(schema: TSchema) {
  return schemaCompiler.compile(schema)
}

function roundTrip<Schema extends TSchema>(schema: Schema, value: unknown) {
  const validate = compileSchema(schema)
  const copy = JSON.parse(JSON.stringify(value)) as unknown
  expect(validate(copy), JSON.stringify(validate.errors)).toBe(true)
  expect(copy).toEqual(value)
}

function everySchemaBranchHasVersion(schema: TSchema): boolean {
  const candidate = schema as {
    properties?: Record<string, unknown>
    anyOf?: TSchema[]
  }
  if (candidate.properties?.version) return true
  return Boolean(
    candidate.anyOf?.length &&
    candidate.anyOf.every((branch) => everySchemaBranchHasVersion(branch)),
  )
}

const route: ModelRouteSnapshot = {
  schemaVersion: 2,
  purpose: 'main',
  providerType: 'deepseek.chat-completions',
  providerId: 'deepseek',
  model: 'deepseek-chat',
  reasoning: 'off',
  endpoint: 'https://api.deepseek.com/chat/completions',
  providerConfigRevision: 1,
}

const project: ProjectRecord = {
  schemaVersion: 1,
  id: projectId,
  path: 'F:\\workspace\\one',
  name: 'one',
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
}

const session: SessionRecord = {
  schemaVersion: 1,
  id: sessionId,
  projectId,
  title: 'Canonical contracts',
  titleSource: 'user',
  lifecycle: 'active',
  permissionMode: 'confirm',
  modelSelection: {
    providerId: 'deepseek',
    model: 'deepseek-chat',
    reasoning: 'off',
  },
  goal: null,
  plan: null,
  revision: 1,
  lastSeq: 9,
  createdAt: timestamp,
  updatedAt: timestamp,
}

function identity(id: string, seq: number) {
  return {
    schemaVersion: 1 as const,
    id: id as MessageId,
    sessionId,
    seq,
    visibility: 'visible' as const,
    inHistory: true,
    createdAt: timestamp,
  }
}

const messages: MessageRecord[] = [
  {
    ...identity('message:1', 1),
    kind: 'user_input',
    clientRequestId: 'request:1',
    parts: [{ type: 'text', text: 'Inspect the repository' }],
    metadata: {
      schemaVersion: 1,
      submission: { type: 'message' },
      attachments: [
        {
          kind: 'file',
          path: 'README.md',
          source: 'mention',
          truncated: false,
        },
      ],
    },
  },
  {
    ...identity('message:2', 2),
    kind: 'assistant_turn',
    parts: [
      { type: 'text', text: 'I will inspect it.' },
      {
        type: 'tool_call',
        callId,
        name: 'read_file',
        arguments: { path: 'README.md' },
      },
    ],
    normalizedReasoningText: 'Need repository context.',
    providerContinuation: {
      schemaVersion: 2,
      providerType: 'deepseek.chat-completions',
      format: 'reasoning-content-v1',
      data: { ordered: ['first', 'second'] },
    },
    modelRoute: route,
    metadata: {
      schemaVersion: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
      reasoningProjection: {
        truncated: false,
        omittedOpaqueBlocks: true,
      },
    },
  },
  {
    ...identity('message:3', 3),
    kind: 'tool_result',
    parts: [
      {
        type: 'tool_result',
        callId,
        content: [
          { type: 'text', text: 'README' },
          { type: 'json', value: { bytes: 6 } },
        ],
        isError: false,
      },
    ],
    metadata: {
      schemaVersion: 1,
      tool: {
        name: 'read_file',
        status: 'completed',
        truncated: false,
      },
    },
  },
  {
    ...identity('message:4', 4),
    kind: 'system_instruction',
    parts: [{ type: 'text', text: 'Base instructions' }],
    metadata: {
      schemaVersion: 1,
      layer: {
        source: 'prompt:base',
        trusted: true,
        editable: false,
        hash,
      },
      prompt: { resourceId: 'base', version: '1', hash },
    },
  },
  {
    ...identity('message:5', 5),
    kind: 'runtime_context',
    parts: [{ type: 'text', text: 'Runtime context' }],
  },
  {
    ...identity('message:6', 6),
    kind: 'agents_context',
    parts: [{ type: 'text', text: 'AGENTS context' }],
  },
  {
    ...identity('message:7', 7),
    kind: 'orchestrator',
    parts: [{ type: 'text', text: 'Continue the active plan' }],
  },
  {
    ...identity('message:8', 8),
    kind: 'interjection',
    parts: [{ type: 'text', text: 'Also check the tests' }],
  },
  {
    ...identity('message:9', 9),
    kind: 'compact_summary',
    parts: [{ type: 'text', text: 'Summary of earlier messages' }],
    metadata: {
      schemaVersion: 1,
      compact: { replacesThroughSeq: 8, sourceHash: hash },
    },
  },
]

const fileChange: FileChangeSummary = {
  schemaVersion: 1,
  id: 'file-change:one' as FileChangeId,
  sessionId,
  callId,
  path: 'README.md',
  operation: 'patch',
  diff: '@@ -1 +1 @@',
  diffHash: hash,
  diffTruncated: false,
  beforeExists: true,
  beforeHash: hash,
  afterExists: true,
  afterHash: hash,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
}

describe('domain-state canonical records', () => {
  it('round-trips Project, Session, every Message kind, route and FileChange', () => {
    roundTrip(ProjectRecordSchema, project)
    roundTrip(SessionRecordSchema, session)
    roundTrip(ModelRouteSnapshotSchema, route)
    roundTrip(FileChangeSummarySchema, fileChange)
    for (const message of messages) roundTrip(MessageRecordSchema, message)
  })

  it('enforces lifecycle, revision and secret-safe public fields', () => {
    const validateSession = compileSchema(SessionRecordSchema)
    const validateProject = compileSchema(ProjectRecordSchema)
    const validateFileChange = compileSchema(FileChangeSummarySchema)

    expect(validateSession({ ...session, lifecycle: 'archived' })).toBe(false)
    expect(
      validateSession({
        ...session,
        lifecycle: 'archived',
        archivedAt: timestamp,
      }),
    ).toBe(true)
    expect(validateProject({ ...project, revision: 0 })).toBe(false)
    expect(
      validateFileChange({ ...fileChange, beforeContent: 'private snapshot' }),
    ).toBe(false)
    expect(validateSession({ ...session, updatedAt: 'not-a-date' })).toBe(false)
  })
})

describe('canonical Message constraints', () => {
  const validate = compileSchema(MessageRecordSchema)

  it('rejects illegal kind/part and metadata combinations', () => {
    const user = messages[0]!
    const assistant = messages[1]!
    const toolResult = messages[2]!
    const compact = messages[8]!

    expect(
      validate({
        ...user,
        parts: [
          {
            type: 'tool_call',
            callId,
            name: 'read_file',
            arguments: {},
          },
        ],
      }),
    ).toBe(false)
    expect(validate({ ...assistant, parts: toolResult.parts })).toBe(false)
    expect(
      validate({
        ...toolResult,
        parts: [...toolResult.parts, ...toolResult.parts],
      }),
    ).toBe(false)
    expect(validate({ ...user, providerContinuation: {} })).toBe(false)
    expect(validate({ ...assistant, modelRoute: undefined })).toBe(false)
    expect(
      validate({
        ...assistant,
        metadata: { schemaVersion: 1, providerState: 'not allowed' },
      }),
    ).toBe(false)
    const compactWithoutMetadata: Record<string, unknown> = { ...compact }
    delete compactWithoutMetadata.metadata
    expect(validate(compactWithoutMetadata)).toBe(false)
    expect(
      validate({
        ...user,
        metadata: {
          schemaVersion: 1,
          replayedFromMessageId: 'message:source',
        },
      }),
    ).toBe(false)
    const userWithoutIdentity = { ...user } as Record<string, unknown>
    delete userWithoutIdentity.clientRequestId
    expect(validate(userWithoutIdentity)).toBe(false)
  })

  it('checks local call uniqueness, bounded JSON and route safety', () => {
    const assistant = messages[1]
    if (!assistant || assistant.kind !== 'assistant_turn') {
      throw new Error('assistant fixture is missing')
    }
    const toolCall = assistant.parts.find((part) => part.type === 'tool_call')
    if (!toolCall) throw new Error('tool-call fixture is missing')

    expect(() =>
      assertMessageRecordSemantics({
        ...assistant,
        parts: [...assistant.parts, { ...toolCall }],
      }),
    ).toThrow(/Duplicate assistant tool call/u)
    expect(() =>
      assertMessageRecordSemantics({
        ...assistant,
        modelRoute: {
          ...route,
          endpoint: 'https://user:secret@example.test/v1',
        },
      }),
    ).toThrow(/credentials/u)
    expect(() =>
      assertModelRouteSnapshotSafe({
        ...route,
        endpoint: 'https://example.test/v1?api_key=secret',
      }),
    ).toThrow(/credential query/u)
    for (const endpoint of ['file:///tmp/provider', 'javascript:alert(1)']) {
      expect(() =>
        assertModelRouteSnapshotSafe({ ...route, endpoint }),
      ).toThrow(/HTTP or HTTPS/u)
    }
  })

  it('preserves opaque continuation JSON ordering through a round-trip', () => {
    const assistant = messages[1]
    if (!assistant || assistant.kind !== 'assistant_turn') {
      throw new Error('assistant fixture is missing')
    }
    const serialized = JSON.stringify(assistant.providerContinuation)
    expect(JSON.stringify(JSON.parse(serialized))).toBe(serialized)
  })
})

describe('bounded canonical JSON', () => {
  const limits: JsonValueLimits = {
    maxDepth: 2,
    maxArrayLength: 2,
    maxObjectKeys: 2,
    maxStringLength: 4,
    maxBytes: 32,
  }

  it('accepts values within limits and rejects every structural bound', () => {
    expect(() => assertBoundedJsonValue({ ok: [1, 2] }, limits)).not.toThrow()
    expect(() =>
      assertBoundedJsonValue({ a: { b: { c: 1 } } }, limits),
    ).toThrow(/depth/u)
    expect(() => assertBoundedJsonValue([1, 2, 3], limits)).toThrow(/array/u)
    expect(() => assertBoundedJsonValue({ a: 1, b: 2, c: 3 }, limits)).toThrow(
      /key count/u,
    )
    expect(() => assertBoundedJsonValue('12345', limits)).toThrow(/string/u)
    expect(() =>
      assertBoundedJsonValue(
        { abcd: 'abcd', efgh: 'efgh' },
        { ...limits, maxBytes: 20 },
      ),
    ).toThrow(/size/u)
  })

  it('rejects non-JSON values and cycles', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(() => assertBoundedJsonValue(Number.NaN, limits)).toThrow(/finite/u)
    expect(() => assertBoundedJsonValue(new Date(), limits)).toThrow(/plain/u)
    expect(() => assertBoundedJsonValue(cycle, limits)).toThrow(/cycles/u)
  })

  it('bounds repeated DAG traversal before serialization can explode', () => {
    let dag: unknown = { value: 1 }
    for (let index = 0; index < 10; index += 1) {
      dag = { left: dag, right: dag }
    }
    expect(() =>
      assertBoundedJsonValue(dag, {
        maxDepth: 32,
        maxArrayLength: 10,
        maxObjectKeys: 2,
        maxStringLength: 100,
        maxBytes: 1_000_000,
        maxNodes: 100,
      }),
    ).toThrow(/node count/u)
  })
})

describe('message paging and Session snapshots', () => {
  const page: MessagePage = {
    schemaVersion: 1,
    sessionId,
    records: messages.slice(0, 3),
    hasMore: true,
    nextBeforeSeq: 1,
  }

  it('uses ascending records and an exclusive beforeSeq cursor', () => {
    roundTrip(MessagePageSchema, page)
    expect(() => assertMessagePageSemantics(page)).not.toThrow()
    expect(() =>
      assertMessagePageSemantics({
        ...page,
        records: [...page.records].reverse(),
        nextBeforeSeq: 3,
      }),
    ).toThrow(/ascending/u)
    expect(() =>
      assertMessagePageSemantics({ ...page, nextBeforeSeq: 2 }),
    ).toThrow(/nextBeforeSeq/u)
  })

  it('keeps Session and page ownership aligned', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      session,
      messagePage: page,
      traceCapture: {
        configuredEnabled: true,
        state: 'active' as const,
        traceId: 'capture-session-one',
      },
    }
    roundTrip(SessionSnapshotSchema, snapshot)
    expect(() => assertSessionSnapshotSemantics(snapshot)).not.toThrow()
    expect(() =>
      assertSessionSnapshotSemantics({
        ...snapshot,
        messagePage: {
          ...page,
          sessionId: 'session:other' as SessionId,
        },
      }),
    ).toThrow(/another Session/u)
  })

  it('pages Session summaries by a stable updatedAt/id cursor', () => {
    const newer: SessionRecord = {
      ...session,
      id: 'session:two' as SessionId,
      updatedAt: '2026-07-22T13:00:00.000Z',
    }
    const page = {
      schemaVersion: 1 as const,
      records: [newer, session],
      hasMore: true as const,
      nextBefore: { updatedAt: session.updatedAt, sessionId: session.id },
    }
    roundTrip(SessionPageSchema, page)
    expect(() => assertSessionPageSemantics(page)).not.toThrow()
    expect(() =>
      assertSessionPageSemantics({
        ...page,
        records: [...page.records].reverse(),
        nextBefore: { updatedAt: newer.updatedAt, sessionId: newer.id },
      }),
    ).toThrow(/descending/u)
    expect(() =>
      assertSessionPageSemantics({
        schemaVersion: 1,
        records: [{ ...session, updatedAt: 'not-a-date' }],
        hasMore: false,
      }),
    ).toThrow(/invalid updatedAt/u)
  })
})

describe('FileChange semantics', () => {
  it('uses the empty-content hash for missing file states', () => {
    const missingBefore = {
      ...fileChange,
      beforeExists: false,
      beforeHash: EMPTY_FILE_SHA256,
    }
    expect(() => assertFileChangeSummarySemantics(missingBefore)).not.toThrow()
    expect(() =>
      assertFileChangeSummarySemantics({
        ...missingBefore,
        beforeHash: hash,
      }),
    ).toThrow(/empty-content/u)
  })
})

describe('bounded domain-state API contracts', () => {
  const cursor = {
    schemaVersion: 1 as const,
    backendInstanceId: 'backend:one',
    sequence: 1,
  }
  const contractEntries = Object.entries(DOMAIN_STATE_API_CONTRACTS)

  it('keeps payload and result versions explicit', () => {
    const payload: DomainStateApiPayload<'message:list'> = {
      version: 1,
      sessionId,
      beforeSeq: 9,
      limit: MAX_MESSAGE_PAGE_RECORDS,
    }
    const validatePayload = compileSchema(MessageListPayloadSchema)
    expect(validatePayload(payload)).toBe(true)
    expect(validatePayload({ ...payload, version: 2 })).toBe(false)
    expect(
      validatePayload({ ...payload, limit: MAX_MESSAGE_PAGE_RECORDS + 1 }),
    ).toBe(false)
    expect(contractEntries).toHaveLength(20)
    expect(DOMAIN_STATE_API_CONTRACTS).not.toHaveProperty('session:create')
    expect(DOMAIN_STATE_API_CONTRACTS).toHaveProperty('run:start')
    expect(DOMAIN_STATE_API_CONTRACTS).toHaveProperty('message:search')
    expect(DOMAIN_STATE_API_CONTRACTS).toHaveProperty('session:fork')
    for (const [, contract] of contractEntries) {
      expect(everySchemaBranchHasVersion(contract.payload)).toBe(true)
      expect(everySchemaBranchHasVersion(contract.result)).toBe(true)
    }
    expect(compileSchema(SessionUpdatePatchSchema)({})).toBe(false)
  })

  it.each(contractEntries)(
    'compiles the %s payload and result schemas',
    (_name, contract) => {
      expect(() => compileSchema(contract.payload)).not.toThrow()
      expect(() => compileSchema(contract.result)).not.toThrow()
    },
  )

  it('models lazy run start and bounded live runtime state', () => {
    const runtime = {
      schemaVersion: 1 as const,
      sessionId,
      runId: 'run:one',
      status: 'calling_llm' as const,
      text: 'partial answer',
      reasoning: 'partial reasoning',
      tools: [],
      interjections: [],
    }
    roundTrip(ActiveRunPublicSnapshotSchema, runtime)
    roundTrip(DurableRunStartPayloadSchema, {
      version: 1,
      kind: 'new_session',
      sessionId,
      projectId,
      permissionMode: 'confirm',
      modelSelection: session.modelSelection,
      message: 'first message',
      clientRequestId: 'request:first',
      context: { attachments: [] },
    })
    roundTrip(DurableRunStartPayloadSchema, {
      version: 1,
      kind: 'existing_session',
      sessionId,
      message: 'continue',
      clientRequestId: 'request:continue',
    })
    roundTrip(DurableRunStartResultSchema, {
      version: 1,
      outcome: 'started',
      commit: {
        schemaVersion: 1,
        cursor,
        topic: 'session.changed',
        change: {
          session,
          messageChange: { mode: 'upsert', records: [messages[0]] },
        },
      },
      runId: runtime.runId,
      runtime,
    })
  })

  it('round-trips bounded topic changes and supports metadata-only Session commits', () => {
    roundTrip(ProjectCommittedChangeSchema, { projects: [project] })
    roundTrip(SessionCommittedChangeSchema, {
      session,
      messageChange: { mode: 'none' },
    })
    roundTrip(SessionCommittedChangeSchema, {
      session,
      messageChange: { mode: 'upsert', records: messages.slice(0, 3) },
    })
    roundTrip(SessionRemovedChangeSchema, { sessionId, projectId })
    roundTrip(FileChangeCommittedChangeSchema, {
      mode: 'upsert',
      sessionId,
      fileChange,
    })
    roundTrip(FileChangeCommittedChangeSchema, { mode: 'invalidate_all' })
    roundTrip(FileChangePageSchema, {
      schemaVersion: 1,
      sessionId,
      records: [fileChange],
      hasMore: true,
      nextBefore: {
        createdAt: fileChange.createdAt,
        fileChangeId: fileChange.id,
      },
    })

    const event: DomainStateEvent = {
      version: 1,
      commit: {
        schemaVersion: 1,
        cursor,
        topic: 'session.changed',
        change: { session, messageChange: { mode: 'none' } },
      },
    }
    roundTrip(DomainStateEventSchema, event)
    roundTrip(DomainStateEventSchema, {
      version: 1,
      commit: {
        schemaVersion: 1,
        cursor,
        topic: 'session.removed',
        change: { sessionId, projectId },
      },
    })
  })

  it('bounds bootstrap collections and rejects unknown result fields', () => {
    const validate = compileSchema(AppBootstrapResultSchema)
    expect(
      validate({
        version: 1,
        cursor,
        projects: [project],
        sessionPage: {
          schemaVersion: 1,
          records: [session],
          hasMore: false,
        },
      }),
    ).toBe(true)
    expect(
      validate({
        version: 1,
        cursor,
        projects: [project],
        sessionPage: {
          schemaVersion: 1,
          records: [session],
          hasMore: false,
        },
        workbench: {},
      }),
    ).toBe(false)
  })
})
