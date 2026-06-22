import { randomUUID } from 'node:crypto'
import type { PublicConfig } from '../../shared/config'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { SkillsManager } from '../skills/manager'
import type { PromptRegistry, PromptResourceSummary } from '../prompts/registry'

export interface SlashCommandResolution {
  visibleMessage: string
  providerMessage: string
  orchestratorMessage?: {
    kind: string
    text: string
    resource?: PromptResourceSummary
  }
  goal?: GoalState
  plan?: PlanState
}

function now(): string {
  return new Date().toISOString()
}

function newGoal(objective: string): GoalState {
  const createdAt = now()
  return {
    id: `goal:${randomUUID()}`,
    objective,
    status: 'active',
    createdAt,
    updatedAt: createdAt,
    continuationCount: 0,
  }
}

function newPlan(objective: string): PlanState {
  const createdAt = now()
  return {
    id: `plan:${randomUUID()}`,
    objective,
    items: [],
    createdAt,
    updatedAt: createdAt,
    continuationCount: 0,
  }
}

function splitCommand(
  message: string,
): { command: string; rest: string } | undefined {
  const trimmed = message.trim()

  if (!trimmed.startsWith('/')) {
    return undefined
  }

  const [command = '', ...rest] = trimmed.slice(1).split(/\s+/u)
  return {
    command: command.toLowerCase(),
    rest: rest.join(' ').trim(),
  }
}

function orchestrationPrompt(
  registry: PromptRegistry | undefined,
  config: PublicConfig,
  kind: 'compact',
): { text: string; resource?: PromptResourceSummary } {
  const resolved = registry?.orchestrationPrompt(
    kind,
    config.assistant.language,
  )

  if (resolved) {
    return { text: resolved.content, resource: resolved.resource }
  }

  return {
    text: 'Create a traceable compact summary. Preserve goals, decisions, tool results, changes, unfinished work, and risks. Do not delete history.',
  }
}

export function resolveSlashCommand(input: {
  message: string
  config: PublicConfig
  skillsManager?: SkillsManager
  promptRegistry?: PromptRegistry
}): SlashCommandResolution {
  const parsed = splitCommand(input.message)

  if (!parsed) {
    return {
      visibleMessage: input.message,
      providerMessage: input.message,
    }
  }

  if (parsed.command === 'skill') {
    const [name = '', ...restParts] = parsed.rest.split(/\s+/u)
    const instruction = restParts.join(' ').trim()
    const skill = input.skillsManager?.read(name)

    if (!skill) {
      throw new Error(
        `Skill "${name || '(missing)'}" is not installed and enabled.`,
      )
    }

    return {
      visibleMessage: input.message,
      providerMessage: [
        `The user explicitly requested skill "${skill.name}". Follow its full instructions without first calling read_skill.`,
        `<skill name="${skill.name}" source="${skill.source}" sha256="${skill.sha256}">`,
        skill.body,
        '</skill>',
        instruction
          ? `User request: ${instruction}`
          : 'User request: execute the requested skill.',
      ].join('\n\n'),
    }
  }

  if (parsed.command === 'compact') {
    const prompt = orchestrationPrompt(
      input.promptRegistry,
      input.config,
      'compact',
    )
    const text = parsed.rest
      ? `${prompt.text}\n\nAdditional user instruction: ${parsed.rest}`
      : prompt.text

    return {
      visibleMessage: input.message,
      providerMessage: text,
      orchestratorMessage: {
        kind: 'compact',
        text,
        resource: prompt.resource,
      },
    }
  }

  if (parsed.command === 'prompt') {
    if (!parsed.rest) {
      throw new Error('/prompt requires instruction text.')
    }

    return {
      visibleMessage: input.message,
      providerMessage: parsed.rest,
      orchestratorMessage: {
        kind: 'prompt',
        text: parsed.rest,
      },
    }
  }

  if (parsed.command === 'goal') {
    if (!parsed.rest) {
      throw new Error('/goal requires an objective.')
    }

    const goal = newGoal(parsed.rest)
    return {
      visibleMessage: input.message,
      providerMessage: [
        `Start and pursue this Goal: ${goal.objective}`,
        'Use goal_get when you need the current state. You must eventually call goal_complete with evidence, or goal_block with required input if blocked.',
      ].join('\n\n'),
      goal,
      orchestratorMessage: {
        kind: 'goal-started',
        text: `Goal started: ${goal.objective}`,
      },
    }
  }

  if (parsed.command === 'plan') {
    if (!parsed.rest) {
      throw new Error('/plan requires an objective.')
    }

    const plan = newPlan(parsed.rest)
    return {
      visibleMessage: input.message,
      providerMessage: [
        `Create and execute a Plan for: ${plan.objective}`,
        'First call plan_set with concrete items. Then update each item with plan_update. Completed items require result and evidence.',
      ].join('\n\n'),
      plan,
      orchestratorMessage: {
        kind: 'plan-started',
        text: `Plan started: ${plan.objective}`,
      },
    }
  }

  throw new Error(
    `Unknown slash command "/${parsed.command}". Supported commands: /prompt, /skill, /compact, /goal, /plan.`,
  )
}
