export type AgentApi = Readonly<Record<never, never>>

export const AGENT_API_KEYS = [] as const satisfies readonly (keyof AgentApi)[]
