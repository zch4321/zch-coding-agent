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
import { BACKGROUND_IPC_CONTRACTS } from './ipc/background'
import { BackgroundTaskEventSchema } from './background-tasks'

function schemaHash(schema: object): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex')
}

describe('shared IPC contracts', () => {
  it('records the intentional background and runtime-cursor wire schema additions', () => {
    expect(Object.keys(IPC_CONTRACTS)).toHaveLength(76)
    expect
      .soft(schemaHash(IPC_CONTRACTS))
      .toBe('cd75a046490e7f3936459e3a45b6df0b28b747f0f3753cec33653a9e33cd21b6')
    expect(schemaHash(ConfigSetRequestSchema)).toBe(
      'c781cacd302c2e52f362751359ad943ff56c9d7db350eca80c0a876d5f720f19',
    )
    expect
      .soft(
        schemaHash({
          IpcErrorSchema,
          AgentEventEnvelopeSchema,
          AgentExecutionEventEnvelopeSchema,
          TerminalEventEnvelopeSchema,
          DomainStateDeliverySchema,
          BackgroundTaskEventSchema,
        }),
      )
      .toBe('7e13b135bef272ac5ea8ebb385282056358602c2b5709ce2fe7d06a3dc4abe97')
  })

  it('composes every channel once from its owning IPC domain', () => {
    const groups = [
      BACKGROUND_IPC_CONTRACTS,
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
