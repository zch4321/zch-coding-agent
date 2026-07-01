import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPROVAL_PROMPT_REFS,
  DEFAULT_HARNESS_PROMPT_REFS,
  DEFAULT_ORCHESTRATION_PROMPT_REFS,
} from '../../shared/prompt-resources'
import { PromptRegistry } from './registry'

describe('PromptRegistry', () => {
  it('loads versioned prompt resources and resolves localized system prompts', async () => {
    const registry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )

    const legacyZh = await readFile(
      path.resolve('resources', 'prompts', 'system', 'zh-CN.md'),
      'utf8',
    )
    expect(registry.systemPrompt('zh-CN').content).toBe(legacyZh.trim())
    expect(
      registry
        .list()
        .every((resource) => /^[a-f0-9]{64}$/u.test(resource.sha256)),
    ).toBe(true)
  })

  it('loads append-only harness prompt resources', async () => {
    const registry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )
    const base = registry.harnessPrompt('baseInstructions', 'zh-CN')
    const runtime = registry.harnessPrompt('runtimeContext', 'en-US')

    expect(base.resource.id).toBe(
      DEFAULT_HARNESS_PROMPT_REFS.baseInstructions['zh-CN'].id,
    )
    expect(base.content).toContain('指令优先级与上下文边界')
    expect(base.content).toContain('Harness 标签')
    expect(base.content).toContain('ProjectModel')
    expect(base.content).not.toContain('<runtime_policy>')
    expect(runtime.resource.id).toBe(
      DEFAULT_HARNESS_PROMPT_REFS.runtimeContext['en-US'].id,
    )
    expect(runtime.content.trimStart()).toMatch(/^<environment_context/u)
    expect(runtime.content).toContain('<module_context')
    expect(runtime.content).not.toContain('<runtime_policy>')
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

  it('loads orchestration slash command prompt resources', async () => {
    const registry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )
    const goal = registry.orchestrationPrompt('goalStarted', 'zh-CN')
    const plan = registry.orchestrationPrompt('planStarted', 'en-US')

    expect(goal.resource.id).toBe(
      DEFAULT_ORCHESTRATION_PROMPT_REFS.goalStarted['zh-CN'].id,
    )
    expect(goal.content).toContain('${objective}')
    expect(plan.resource.id).toBe(
      DEFAULT_ORCHESTRATION_PROMPT_REFS.planStarted['en-US'].id,
    )
    expect(plan.content).toContain('plan_set')
    expect(plan.content).toContain('${objective}')
  })
})
