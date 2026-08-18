import { Type, type Static } from '@sinclair/typebox'
import type { AssistantLanguage } from '../system-prompts'

export const AssistantLanguageSchema = Type.Union([
  Type.Literal('zh-CN'),
  Type.Literal('en-US'),
])
export type { AssistantLanguage }

export const PromptResourceRefSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 256 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
)

export const AssistantConfigSchema = Type.Object(
  {
    language: AssistantLanguageSchema,
    preferences: Type.Object(
      {
        'zh-CN': Type.String({ maxLength: 32_768 }),
        'en-US': Type.String({ maxLength: 32_768 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type AssistantConfig = Static<typeof AssistantConfigSchema>

export const PromptsConfigSchema = Type.Object(
  {
    approval: Type.Object(
      {
        classifyRisk: PromptResourceRefSchema,
      },
      { additionalProperties: false },
    ),
    orchestration: Type.Object(
      {
        goalStarted: Type.Object(
          {
            'zh-CN': PromptResourceRefSchema,
            'en-US': PromptResourceRefSchema,
          },
          { additionalProperties: false },
        ),
        goalContinue: Type.Object(
          {
            'zh-CN': PromptResourceRefSchema,
            'en-US': PromptResourceRefSchema,
          },
          { additionalProperties: false },
        ),
        planStarted: Type.Object(
          {
            'zh-CN': PromptResourceRefSchema,
            'en-US': PromptResourceRefSchema,
          },
          { additionalProperties: false },
        ),
        planContinue: Type.Object(
          {
            'zh-CN': PromptResourceRefSchema,
            'en-US': PromptResourceRefSchema,
          },
          { additionalProperties: false },
        ),
        planWarning: Type.Object(
          {
            'zh-CN': PromptResourceRefSchema,
            'en-US': PromptResourceRefSchema,
          },
          { additionalProperties: false },
        ),
        compact: Type.Object(
          {
            'zh-CN': PromptResourceRefSchema,
            'en-US': PromptResourceRefSchema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)
export type PromptsConfig = Static<typeof PromptsConfigSchema>
