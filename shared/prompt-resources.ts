import type { AssistantLanguage } from './system-prompts'

export const PROMPT_RESOURCE_VERSION = '2026-08-12.1'
export const BASE_INSTRUCTIONS_PROMPT_RESOURCE_VERSION = '2026-08-16.1'
export const HEADLESS_PROMPT_RESOURCE_VERSION = '2026-07-11.1'
export const SWARM_PROMPT_RESOURCE_VERSION = '2026-08-12.1'

export interface PromptResourceRef {
  id: string
  version: string
}

export const DEFAULT_HARNESS_PROMPT_REFS: Record<
  'baseInstructions' | 'runtimeContext',
  Record<AssistantLanguage, PromptResourceRef>
> = {
  baseInstructions: {
    'zh-CN': {
      id: 'harness.base-instructions.zh-CN',
      version: BASE_INSTRUCTIONS_PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'harness.base-instructions.en-US',
      version: BASE_INSTRUCTIONS_PROMPT_RESOURCE_VERSION,
    },
  },
  runtimeContext: {
    'zh-CN': {
      id: 'harness.runtime-context.zh-CN',
      version: PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'harness.runtime-context.en-US',
      version: PROMPT_RESOURCE_VERSION,
    },
  },
}

export const DEFAULT_APPROVAL_PROMPT_REFS = {
  classifyRisk: {
    id: 'approval.classify-risk',
    version: PROMPT_RESOURCE_VERSION,
  },
}

export const DEFAULT_HEADLESS_PROMPT_REFS: Record<
  'autonomousPlanApproval',
  Record<AssistantLanguage, PromptResourceRef>
> = {
  autonomousPlanApproval: {
    'zh-CN': {
      id: 'headless.autonomous-plan-approval.zh-CN',
      version: HEADLESS_PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'headless.autonomous-plan-approval.en-US',
      version: HEADLESS_PROMPT_RESOURCE_VERSION,
    },
  },
}

export const DEFAULT_ORCHESTRATION_PROMPT_REFS: Record<
  | 'goalStarted'
  | 'goalContinue'
  | 'planStarted'
  | 'planContinue'
  | 'planWarning'
  | 'compact',
  Record<AssistantLanguage, PromptResourceRef>
> = {
  goalStarted: {
    'zh-CN': {
      id: 'orchestration.goal-started.zh-CN',
      version: PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'orchestration.goal-started.en-US',
      version: PROMPT_RESOURCE_VERSION,
    },
  },
  goalContinue: {
    'zh-CN': {
      id: 'orchestration.goal-continue.zh-CN',
      version: PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'orchestration.goal-continue.en-US',
      version: PROMPT_RESOURCE_VERSION,
    },
  },
  planStarted: {
    'zh-CN': {
      id: 'orchestration.plan-started.zh-CN',
      version: PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'orchestration.plan-started.en-US',
      version: PROMPT_RESOURCE_VERSION,
    },
  },
  planContinue: {
    'zh-CN': {
      id: 'orchestration.plan-continue.zh-CN',
      version: PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'orchestration.plan-continue.en-US',
      version: PROMPT_RESOURCE_VERSION,
    },
  },
  planWarning: {
    'zh-CN': {
      id: 'orchestration.plan-warning.zh-CN',
      version: PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'orchestration.plan-warning.en-US',
      version: PROMPT_RESOURCE_VERSION,
    },
  },
  compact: {
    'zh-CN': {
      id: 'orchestration.compact.zh-CN',
      version: PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'orchestration.compact.en-US',
      version: PROMPT_RESOURCE_VERSION,
    },
  },
}

export const DEFAULT_SWARM_PROMPT_REFS: Record<
  AssistantLanguage,
  PromptResourceRef
> = {
  'zh-CN': {
    id: 'orchestration.swarm-started.zh-CN',
    version: SWARM_PROMPT_RESOURCE_VERSION,
  },
  'en-US': {
    id: 'orchestration.swarm-started.en-US',
    version: SWARM_PROMPT_RESOURCE_VERSION,
  },
}
