import { Type, type Static } from '@sinclair/typebox'

export const GitReviewModeSchema = Type.Union([
  Type.Literal('head'),
  Type.Literal('unstaged'),
  Type.Literal('staged'),
  Type.Literal('merge_base'),
])
export type GitReviewMode = Static<typeof GitReviewModeSchema>

export const GitReviewStatusKindSchema = Type.Union([
  Type.Literal('added'),
  Type.Literal('copied'),
  Type.Literal('deleted'),
  Type.Literal('ignored'),
  Type.Literal('modified'),
  Type.Literal('renamed'),
  Type.Literal('type_changed'),
  Type.Literal('unmerged'),
  Type.Literal('untracked'),
  Type.Literal('unknown'),
])
export type GitReviewStatusKind = Static<typeof GitReviewStatusKindSchema>

export const GitReviewStatusEntrySchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    originalPath: Type.Optional(
      Type.String({ minLength: 1, maxLength: 4_096 }),
    ),
    indexStatus: Type.String({ minLength: 1, maxLength: 1 }),
    worktreeStatus: Type.String({ minLength: 1, maxLength: 1 }),
    kind: GitReviewStatusKindSchema,
  },
  { additionalProperties: false },
)
export type GitReviewStatusEntry = Static<typeof GitReviewStatusEntrySchema>

export const GitReviewStatusSchema = Type.Object(
  {
    repository: Type.Boolean(),
    workspace: Type.String({ minLength: 1, maxLength: 4_096 }),
    topLevel: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    headRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    headOid: Type.Optional(Type.String({ minLength: 4, maxLength: 128 })),
    upstreamRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    detached: Type.Boolean(),
    unborn: Type.Boolean(),
    baseRefs: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
      maxItems: 500,
    }),
    entries: Type.Array(GitReviewStatusEntrySchema, { maxItems: 10_000 }),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type GitReviewStatus = Static<typeof GitReviewStatusSchema>

export const GitReviewDiffSchema = Type.Object(
  {
    mode: GitReviewModeSchema,
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    baseRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    baseOid: Type.Optional(Type.String({ minLength: 4, maxLength: 128 })),
    content: Type.String({ maxLength: 1_000_000 }),
    totalBytes: Type.Integer({ minimum: 0 }),
    truncated: Type.Boolean(),
    binary: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type GitReviewDiff = Static<typeof GitReviewDiffSchema>
