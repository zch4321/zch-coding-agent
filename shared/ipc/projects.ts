import { Type } from '@sinclair/typebox'
import { IPC_VERSION } from '../channels'
import {
  ContextAttachmentChipSchema,
  ContextAttachmentKindSchema,
} from '../context'
import { DOMAIN_STATE_API_CONTRACTS } from '../domain-state-api'
import { ProjectIdSchema } from '../ids'
import {
  CodeBackendStatusSchema,
  DetectedProjectModulesSchema,
  ProjectMetadataSnapshotSchema,
  ProjectModelSchema,
} from '../project-model'
import {
  EmptyPayloadSchema,
  domainIpcContract,
  ipcResultSchema,
} from './common'

export const PROJECT_STATE_IPC_CONTRACTS = {
  'project:list': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['project:list']),
  'project:add': domainIpcContract(DOMAIN_STATE_API_CONTRACTS['project:add']),
  'project:update': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['project:update'],
  ),
  'project:remove': domainIpcContract(
    DOMAIN_STATE_API_CONTRACTS['project:remove'],
  ),
} as const

export const WORKSPACE_IPC_CONTRACTS = {
  'workspace:choose': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(
      Type.Object(
        {
          path: Type.Union([
            Type.String({ minLength: 1, maxLength: 4_096 }),
            Type.Null(),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'workspace:list-directory': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          workspace: Type.String({ minLength: 1, maxLength: 4_096 }),
          path: Type.String({ minLength: 1, maxLength: 4_096 }),
          entries: Type.Array(
            Type.Object(
              {
                path: Type.String({ minLength: 1, maxLength: 4_096 }),
                name: Type.String({ minLength: 1, maxLength: 1_024 }),
                type: Type.Union([
                  Type.Literal('file'),
                  Type.Literal('directory'),
                ]),
              },
              { additionalProperties: false },
            ),
            { maxItems: 1_000 },
          ),
          truncated: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'workspace:read-file': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          workspace: Type.String({ minLength: 1, maxLength: 4_096 }),
          path: Type.String({ minLength: 1, maxLength: 4_096 }),
          content: Type.String({ maxLength: 500_000 }),
          totalBytes: Type.Integer({ minimum: 0 }),
          truncated: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'workspace:open-file': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        path: Type.String({ minLength: 1, maxLength: 4_096 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 4_096 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'workspace:choose-context': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        kind: ContextAttachmentKindSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          attachments: Type.Array(ContextAttachmentChipSchema, {
            maxItems: 32,
          }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'project:get': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(ProjectMetadataSnapshotSchema),
  },
  'project:save': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        project: ProjectModelSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(ProjectMetadataSnapshotSchema),
  },
  'project:detect-modules': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(DetectedProjectModulesSchema),
  },
  'project:backend-status': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          statuses: Type.Array(CodeBackendStatusSchema, { maxItems: 32 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'project:restart-backend': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        projectId: ProjectIdSchema,
        backendId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(CodeBackendStatusSchema),
  },
} as const
