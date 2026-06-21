import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APPROVAL_PROMPT_REFS } from '../../shared/prompt-resources'
import { DEFAULT_SYSTEM_PROMPTS } from '../../shared/system-prompts'
import { PromptRegistry } from './registry'

describe('PromptRegistry', () => {
  it('loads versioned prompt resources and resolves localized system prompts', async () => {
    const registry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )

    expect(registry.systemPrompt('zh-CN').content).toBe(
      DEFAULT_SYSTEM_PROMPTS['zh-CN'],
    )
    expect(registry.systemPrompt('en-US').content).toBe(
      DEFAULT_SYSTEM_PROMPTS['en-US'],
    )
    expect(
      registry
        .list()
        .every((resource) => /^[a-f0-9]{64}$/u.test(resource.sha256)),
    ).toBe(true)
  })

  it('keeps the approval classifier prompt as a non-customized resource', async () => {
    const registry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )
    const approval = registry.approvalPrompt()

    expect(approval.customized).toBe(false)
    expect(approval.resource.id).toBe(
      DEFAULT_APPROVAL_PROMPT_REFS.classifyRisk.id,
    )
    expect(approval.content).toContain('Return only strict JSON')
  })
})
