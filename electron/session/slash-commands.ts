import { randomUUID } from 'node:crypto'
import type { PublicConfig } from '../../shared/config'
import type { PromptLayerKind } from '../../shared/trace'
import type { GoalState, PlanState } from '../../shared/orchestration'
import type { SkillsManager } from '../skills/manager'
import type { PromptRegistry, PromptResourceSummary } from '../prompts/registry'
import {
  orchestrationRequestContent,
  renderPromptTemplate,
  selectedContextContent,
} from './prompt-harness'

export interface SlashCommandResolution {
  visibleMessage: string
  providerMessage: string
  orchestratorMessage?: {
    kind: string
    text: string
    resource?: PromptResourceSummary
  }
  providerContextMessages?: Array<{
    kind: Extract<PromptLayerKind, 'selected_context' | 'orchestration_request'>
    content: string
    source: string
  }>
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
    status: 'awaiting_review',
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
  kind: 'compact' | 'goalStarted' | 'planStarted',
): { text: string; resource?: PromptResourceSummary } {
  const resolved = registry?.orchestrationPrompt(
    kind,
    config.assistant.language,
  )

  if (resolved) {
    return { text: resolved.content, resource: resolved.resource }
  }

  return {
    text:
      kind === 'compact'
        ? 'Create a traceable compact summary that will replace the older conversation history. Preserve goals, decisions, tool results, changes, unfinished work, and risks. Output only the summary.'
        : '',
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
      providerMessage: input.message,
      providerContextMessages: [
        {
          kind: 'selected_context',
          source: `skill:${skill.name}`,
          content: selectedContextContent(
            [
              `<skill_request name="${skill.name}">`,
              `The user explicitly requested skill "${skill.name}". Follow its full instructions without first calling read_skill.`,
              instruction
                ? `User request: ${instruction}`
                : 'User request: execute the requested skill.',
              '</skill_request>',
              `<skill name="${skill.name}" source="${skill.source}" sha256="${skill.sha256}">`,
              skill.body,
              '</skill>',
            ].join('\n\n'),
            `skill:${skill.name}`,
          ),
        },
      ],
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
      providerMessage: input.message,
      providerContextMessages: [
        {
          kind: 'orchestration_request',
          source: 'slash:/compact',
          content: orchestrationRequestContent('compact', text),
        },
      ],
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
      providerMessage: input.message,
      providerContextMessages: [
        {
          kind: 'orchestration_request',
          source: 'slash:/prompt',
          content: orchestrationRequestContent('prompt', parsed.rest),
        },
      ],
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
    const prompt = orchestrationPrompt(
      input.promptRegistry,
      input.config,
      'goalStarted',
    )
    const instruction = renderPromptTemplate(prompt.text, {
      objective: goal.objective,
    })
    return {
      visibleMessage: input.message,
      providerMessage: input.message,
      providerContextMessages: [
        {
          kind: 'orchestration_request',
          source: 'slash:/goal',
          content: orchestrationRequestContent('goal-started', instruction),
        },
      ],
      goal,
      orchestratorMessage: {
        kind: 'goal-started',
        text: `Goal started: ${goal.objective}`,
        resource: prompt.resource,
      },
    }
  }

  if (parsed.command === 'plan') {
    if (!parsed.rest) {
      throw new Error('/plan requires an objective.')
    }

    const plan = newPlan(parsed.rest)
    const prompt = orchestrationPrompt(
      input.promptRegistry,
      input.config,
      'planStarted',
    )
    const instruction = renderPromptTemplate(prompt.text, {
      objective: plan.objective,
    })
    return {
      visibleMessage: input.message,
      providerMessage: input.message,
      providerContextMessages: [
        {
          kind: 'orchestration_request',
          source: 'slash:/plan',
          content: orchestrationRequestContent('plan-started', instruction),
        },
      ],
      plan,
      orchestratorMessage: {
        kind: 'plan-started',
        text: `Plan awaiting review: ${plan.objective}`,
        resource: prompt.resource,
      },
    }
  }

  throw new Error(
    `Unknown slash command "/${parsed.command}". Supported commands: /prompt, /skill, /compact, /goal, /plan.`,
  )
}
