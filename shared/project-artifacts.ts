import { Type, type Static } from '@sinclair/typebox'
import { ProjectIdSchema } from './ids'

export const ArtifactKindSchema = Type.Union([
  Type.Literal('commands'),
  Type.Literal('terminals'),
  Type.Literal('subagents'),
  Type.Literal('swarms'),
  Type.Literal('fetch'),
  Type.Literal('web-search'),
  Type.Literal('mcp'),
])
export type ArtifactKind = Static<typeof ArtifactKindSchema>

export const ArtifactRefSchema = Type.Object(
  {
    projectId: ProjectIdSchema,
    kind: ArtifactKindSchema,
    id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
)
export type ArtifactRef = Static<typeof ArtifactRefSchema>

export interface ProjectRuntimePaths {
  projectRoot: string
  workspace: string
  canonicalWorkspace: string
  tmp: string
  artifacts: string
  scratch: string
}
