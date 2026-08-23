import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ConfigSectionSchema as ConfigFacadeSectionSchema,
  ConfigSetRequestSchema as ConfigFacadeSetRequestSchema,
} from './config'
import {
  AgentEventEnvelopeSchema as FacadeAgentEventEnvelopeSchema,
  AgentExecutionEventEnvelopeSchema as FacadeAgentExecutionEventEnvelopeSchema,
  DomainStateDeliverySchema as FacadeDomainStateDeliverySchema,
  IPC_CONTRACTS as FacadeIpcContracts,
  IpcErrorSchema as FacadeIpcErrorSchema,
  TerminalEventEnvelopeSchema as FacadeTerminalEventEnvelopeSchema,
} from './ipc-contract'
import { AGENT_EXECUTION_IPC_CONTRACTS, PLAN_IPC_CONTRACTS } from './ipc/agents'
import {
  APP_BOOTSTRAP_IPC_CONTRACTS,
  WINDOW_IPC_CONTRACTS,
} from './ipc/application'
import { IpcErrorSchema } from './ipc/common'
import {
  CONFIGURATION_IPC_CONTRACTS,
  ConfigSectionSchema,
  ConfigSetRequestSchema,
  PROVIDER_IPC_CONTRACTS,
} from './ipc/configuration'
import { DIAGNOSTICS_IPC_CONTRACTS } from './ipc/diagnostics'
import {
  AgentEventEnvelopeSchema,
  AgentExecutionEventEnvelopeSchema,
  DomainStateDeliverySchema,
  TerminalEventEnvelopeSchema,
} from './ipc/events'
import { MCP_IPC_CONTRACTS, SKILLS_IPC_CONTRACTS } from './ipc/integrations'
import {
  PROJECT_STATE_IPC_CONTRACTS,
  WORKSPACE_IPC_CONTRACTS,
} from './ipc/projects'
import { IPC_CONTRACTS } from './ipc/registry'
import { RUN_IPC_CONTRACTS } from './ipc/runs'
import { SESSION_IPC_CONTRACTS } from './ipc/sessions'
import { TERMINAL_IPC_CONTRACTS } from './ipc/terminals'

function schemaHash(schema: object): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex')
}

describe('shared IPC contracts', () => {
  it('preserves the complete wire schema fingerprints across the domain split', () => {
    expect(Object.keys(IPC_CONTRACTS)).toHaveLength(71)
    expect(schemaHash(IPC_CONTRACTS)).toBe(
      '48c873d5bdb0f7924b03540c58c820738b72f48a5e1807d4aa158d95b09aa4cb',
    )
    expect(schemaHash(ConfigSetRequestSchema)).toBe(
      '3ae0dce98aac5eace5fa11790125122294382a876777462f3d09c137921dbaa3',
    )
    expect(
      schemaHash({
        IpcErrorSchema,
        AgentEventEnvelopeSchema,
        AgentExecutionEventEnvelopeSchema,
        TerminalEventEnvelopeSchema,
        DomainStateDeliverySchema,
      }),
    ).toBe('b4a5fddfccbb2e3fd1b5e4c6f38020c2008e82df703182bcdb6f8daac70d7385')
  })

  it('composes every channel once from the nine IPC domains', () => {
    const groups = [
      CONFIGURATION_IPC_CONTRACTS,
      MCP_IPC_CONTRACTS,
      PROVIDER_IPC_CONTRACTS,
      APP_BOOTSTRAP_IPC_CONTRACTS,
      PROJECT_STATE_IPC_CONTRACTS,
      SESSION_IPC_CONTRACTS,
      AGENT_EXECUTION_IPC_CONTRACTS,
      WORKSPACE_IPC_CONTRACTS,
      PLAN_IPC_CONTRACTS,
      RUN_IPC_CONTRACTS,
      TERMINAL_IPC_CONTRACTS,
      WINDOW_IPC_CONTRACTS,
      SKILLS_IPC_CONTRACTS,
      DIAGNOSTICS_IPC_CONTRACTS,
    ]
    const entries = groups.flatMap((group) => Object.entries(group))

    expect(entries.map(([channel]) => channel)).toEqual(
      Object.keys(IPC_CONTRACTS),
    )
    expect(new Set(entries.map(([channel]) => channel)).size).toBe(
      entries.length,
    )
    for (const [channel, contract] of entries) {
      expect((IPC_CONTRACTS as Record<string, unknown>)[channel]).toBe(contract)
    }
  })

  it('keeps the compatibility facade wired to the domain-owned schemas', () => {
    expect(FacadeIpcContracts).toBe(IPC_CONTRACTS)
    expect(FacadeIpcErrorSchema).toBe(IpcErrorSchema)
    expect(ConfigFacadeSectionSchema).toBe(ConfigSectionSchema)
    expect(ConfigFacadeSetRequestSchema).toBe(ConfigSetRequestSchema)
    expect(FacadeAgentEventEnvelopeSchema).toBe(AgentEventEnvelopeSchema)
    expect(FacadeAgentExecutionEventEnvelopeSchema).toBe(
      AgentExecutionEventEnvelopeSchema,
    )
    expect(FacadeTerminalEventEnvelopeSchema).toBe(TerminalEventEnvelopeSchema)
    expect(FacadeDomainStateDeliverySchema).toBe(DomainStateDeliverySchema)
  })
})
