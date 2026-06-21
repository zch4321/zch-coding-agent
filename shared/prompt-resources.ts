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

export const DEFAULT_APPROVAL_PROMPT_REFS = {
  classifyRisk: {
    id: 'approval.classify-risk',
    version: PROMPT_RESOURCE_VERSION,
  },
}
