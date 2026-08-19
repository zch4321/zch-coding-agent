import { Type } from '@sinclair/typebox'
import { IPC_VERSION } from '../channels'
import { McpServerIdSchema, McpSettingsSnapshotSchema } from '../mcp'
import { SkillListSchema, SkillSummarySchema } from '../skills'
import { EmptyPayloadSchema, ipcResultSchema } from './common'

export const MCP_IPC_CONTRACTS = {
  'mcp:list': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
  'mcp:reload': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
  'mcp:trust-enable': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        serverId: McpServerIdSchema,
        fingerprint: Type.String({ minLength: 64, maxLength: 64 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
  'mcp:disable': {
    payload: Type.Object(
      { version: Type.Literal(IPC_VERSION), serverId: McpServerIdSchema },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
  'mcp:restart': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        serverId: McpServerIdSchema,
        workspace: Type.Optional(
          Type.String({ minLength: 1, maxLength: 4_096 }),
        ),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(McpSettingsSnapshotSchema),
  },
} as const

export const SKILLS_IPC_CONTRACTS = {
  'skills:list': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(SkillListSchema),
  },
  'skills:installFromUrl': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        url: Type.String({ minLength: 1, maxLength: 2_048 }),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object(
        {
          installed: Type.Boolean(),
          skill: Type.Optional(SkillSummarySchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'skills:chooseAndInstallFile': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(
      Type.Object(
        {
          installed: Type.Boolean(),
          skill: Type.Optional(SkillSummarySchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  'skills:refresh': {
    payload: EmptyPayloadSchema,
    result: ipcResultSchema(SkillListSchema),
  },
  'skills:setEnabled': {
    payload: Type.Object(
      {
        version: Type.Literal(IPC_VERSION),
        name: Type.String({ minLength: 1, maxLength: 128 }),
        enabled: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    result: ipcResultSchema(
      Type.Object({ updated: Type.Boolean() }, { additionalProperties: false }),
    ),
  },
} as const
