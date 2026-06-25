import type { AssistantLanguage } from './system-prompts'

export const PROMPT_RESOURCE_VERSION = '2026-06-21'

export interface PromptResourceRef {
  id: string
  version: string
}

export const DEFAULT_SYSTEM_PROMPT_REFS: Record<
  AssistantLanguage,
  PromptResourceRef
> = {
  'zh-CN': { id: 'system.zh-CN', version: PROMPT_RESOURCE_VERSION },
  'en-US': { id: 'system.en-US', version: PROMPT_RESOURCE_VERSION },
}

export const DEFAULT_HARNESS_PROMPT_REFS: Record<
  'baseInstructions' | 'runtimeContext',
  Record<AssistantLanguage, PromptResourceRef>
> = {
  baseInstructions: {
    'zh-CN': {
      id: 'harness.base-instructions.zh-CN',
      version: PROMPT_RESOURCE_VERSION,
    },
    'en-US': {
      id: 'harness.base-instructions.en-US',
      version: PROMPT_RESOURCE_VERSION,
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

export const DEFAULT_ORCHESTRATION_PROMPT_REFS: Record<
  'goalContinue' | 'planContinue' | 'planWarning' | 'compact',
  Record<AssistantLanguage, PromptResourceRef>
> = {
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
