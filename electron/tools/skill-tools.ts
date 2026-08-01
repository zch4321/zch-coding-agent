import { Type } from '@sinclair/typebox'
import type { SkillsManager } from '../skills/manager'
import type { ToolDefinition } from './types'
import type { ToolRegistry } from './tool-registry'
import { projectReadSkillResult } from './tool-result-formatters'

const ReadSkillArgsSchema = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$',
      description:
        'Exact enabled skill name from the skill summary, without plugin prefix decoration.',
    }),
  },
  { additionalProperties: false },
)

/** Registers skill listing, reading, enablement, and installation tools. */
export function registerSkillTools(
  registry: ToolRegistry,
  skills: SkillsManager,
): void {
  const readSkill: ToolDefinition<typeof ReadSkillArgsSchema> = {
    id: 'read_skill',
    executionMode: 'parallel',
    description:
      'Read the full instructions for an enabled skill by its exact name. Read a relevant skill before following it.',
    inputSchema: ReadSkillArgsSchema,
    effects: ['instruction.read'],
    defaultRisk: 'low',
    supportsAbort: true,
    defaultTimeoutMs: 2_000,
    maxOutputBytes: 80 * 1_024,
    projectResultForModel: projectReadSkillResult,
    async execute(args) {
      const skill = skills.read(args.name)

      if (!skill) {
        return {
          status: 'error',
          code: 'SKILL_NOT_FOUND',
          message: 'Enabled skill was not found',
          retryable: false,
        }
      }

      return {
        status: 'ok',
        content: {
          name: skill.name,
          body: skill.body,
          source: skill.source,
          sha256: skill.sha256,
        },
      }
    },
  }

  registry.registerTool(readSkill)
}
