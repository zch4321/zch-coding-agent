import { randomUUID } from 'node:crypto'
import type { PublicConfig } from '../../shared/config'
import type { PromptLayerKind } from '../../shared/trace'
import type { GoalState } from '../../shared/orchestration'
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
    kind: Extract<PromptLayerKind, 'selected_context' | 'orchestrator'>
    content: string
    source: string
  }>
  goal?: GoalState
  swarmGoal?: string
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
        ? 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a concise, structured, factual handoff summary for another LLM that will resume the task. Include current progress, key decisions, important context, tools run, files touched, validation results, remaining work, and critical references.'
        : '',
  }
}

/** Parses a slash command and returns its normalized command effects and prompt content. */
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

  if (parsed.command === 'prompt') {
    if (!parsed.rest) {
      throw new Error('/prompt requires instruction text.')
    }

    return {
      visibleMessage: input.message,
      providerMessage: input.message,
      providerContextMessages: [
        {
          kind: 'orchestrator',
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

  if (parsed.command === 'swarm') {
    if (!parsed.rest) {
      throw new Error('/swarm requires an objective.')
    }
    const resolved = input.promptRegistry?.swarmPrompt(
      input.config.assistant.language,
    )
    const prompt = resolved
      ? { text: resolved.content, resource: resolved.resource }
      : {
          text: 'Coordinate this Swarm objective: ${objective}\n\nRun relevant verification first when feasible. Put its commands, exit codes, and concise output with common background in sharedContext, then use swarm_run with focused read-only tasks. Use multiple replicas for independent cross-model checks, compare every result, and produce the final synthesis.',
        }
    const instruction = renderPromptTemplate(prompt.text, {
      objective: parsed.rest,
    })
    return {
      visibleMessage: input.message,
      providerMessage: input.message,
      providerContextMessages: [
        {
          kind: 'orchestrator',
          source: 'slash:/swarm',
          content: orchestrationRequestContent('swarm', instruction),
        },
      ],
      swarmGoal: parsed.rest,
      orchestratorMessage: {
        kind: 'swarm-started',
        text: `Swarm requested: ${parsed.rest}`,
        resource: prompt.resource,
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
          kind: 'orchestrator',
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

    const prompt = orchestrationPrompt(
      input.promptRegistry,
      input.config,
      'planStarted',
    )
    const instruction = renderPromptTemplate(prompt.text, {
      objective: parsed.rest,
    })
    return {
      visibleMessage: input.message,
      providerMessage: input.message,
      providerContextMessages: [
        {
          kind: 'orchestrator',
          source: 'slash:/plan',
          content: orchestrationRequestContent('plan-started', instruction),
        },
      ],
      orchestratorMessage: {
        kind: 'plan-started',
        text: `Plan requested: ${parsed.rest}`,
        resource: prompt.resource,
      },
    }
  }

  throw new Error(
    `Unknown slash command "/${parsed.command}". Supported commands: /prompt, /skill, /compact, /goal, /plan, /swarm.`,
  )
}
