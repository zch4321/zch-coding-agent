import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_CONFIG, toPublicConfig } from '../config/schema'
import { PromptRegistry } from '../prompts/registry'
import { DEFAULT_ORCHESTRATION_PROMPT_REFS } from '../../shared/prompt-resources'
import { resolveSlashCommand } from './slash-commands'

function publicConfig() {
  return toPublicConfig(structuredClone(DEFAULT_APP_CONFIG), false)
}

describe('resolveSlashCommand', () => {
  it('renders /plan orchestration prompt from the localized resource', async () => {
    const registry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )
    const result = resolveSlashCommand({
      message: '/plan Check something',
      config: publicConfig(),
      promptRegistry: registry,
    })

    const content = result.providerContextMessages?.[0]?.content ?? ''
    expect(content).toContain('<orchestration_request kind="plan-started">')
    expect(content).toContain('为用户审阅创建 Plan：Check something')
    expect(content).toContain('plan_set')
    expect(content).not.toContain('${objective}')
    expect(result.orchestratorMessage?.resource?.id).toBe(
      DEFAULT_ORCHESTRATION_PROMPT_REFS.planStarted['zh-CN'].id,
    )
  })

  it('renders /goal orchestration prompt from the localized resource', async () => {
    const registry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )
    const config = publicConfig()
    config.assistant.language = 'en-US'
    const result = resolveSlashCommand({
      message: '/goal Produce a verified result',
      config,
      promptRegistry: registry,
    })

    const content = result.providerContextMessages?.[0]?.content ?? ''
    expect(content).toContain('<orchestration_request kind="goal-started">')
    expect(content).toContain(
      'Start and pursue this Goal: Produce a verified result',
    )
    expect(content).toContain('goal_complete')
    expect(content).not.toContain('${objective}')
    expect(result.orchestratorMessage?.resource?.id).toBe(
      DEFAULT_ORCHESTRATION_PROMPT_REFS.goalStarted['en-US'].id,
    )
  })
})
