import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPROVAL_PROMPT_REFS,
  DEFAULT_HARNESS_PROMPT_REFS,
  DEFAULT_ORCHESTRATION_PROMPT_REFS,
  PROMPT_RESOURCE_VERSION,
  type PromptResourceRef,
} from '../../shared/prompt-resources'
import { PromptRegistry } from './registry'

function defaultPromptRefs(): PromptResourceRef[] {
  return [
    ...Object.values(DEFAULT_HARNESS_PROMPT_REFS).flatMap((localized) =>
      Object.values(localized),
    ),
    DEFAULT_APPROVAL_PROMPT_REFS.classifyRisk,
    ...Object.values(DEFAULT_ORCHESTRATION_PROMPT_REFS).flatMap((localized) =>
      Object.values(localized),
    ),
  ]
}

describe('PromptRegistry', () => {
  it('loads versioned prompt resources without legacy system prompts', async () => {
    const registry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )

    expect(
      registry
        .list()
        .every((resource) => /^[a-f0-9]{64}$/u.test(resource.sha256)),
    ).toBe(true)
    expect(registry.list().map((resource) => resource.id)).not.toContain(
      'system.zh-CN',
    )
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

  it('resolves every default prompt ref to a non-empty versioned resource', async () => {
    const registry = await PromptRegistry.load(
      path.resolve('resources', 'prompts'),
    )
    const listed = new Map(
      registry.list().map((resource) => [resource.id, resource]),
    )

    for (const ref of defaultPromptRefs()) {
      const resource = registry.get(ref.id)

      expect(listed.get(ref.id)).toMatchObject({
        id: ref.id,
        version: PROMPT_RESOURCE_VERSION,
        path: resource.path,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      })
      expect(resource.version).toBe(ref.version)
      expect(resource.version).toBe(PROMPT_RESOURCE_VERSION)
      expect(resource.path).toBeTruthy()
      expect(resource.content.trim()).not.toBe('')
      await expect(readFile(resource.path, 'utf8')).resolves.toContain(
        resource.content,
      )
    }
  })
})
