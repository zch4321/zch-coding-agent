import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AssistantLanguage } from '../../shared/system-prompts'
import {
  DEFAULT_APPROVAL_PROMPT_REFS,
  DEFAULT_ORCHESTRATION_PROMPT_REFS,
  DEFAULT_SYSTEM_PROMPT_REFS,
} from '../../shared/prompt-resources'

export interface PromptResource {
  id: string
  version: string
  path: string
  content: string
  sha256: string
}

export interface ResolvedPrompt {
  content: string
  resource: Omit<PromptResource, 'content'>
  customized: boolean
}

export type PromptResourceSummary = Omit<PromptResource, 'content'>

export class PromptRegistry {
  readonly #resources: Map<string, PromptResource>

  private constructor(resources: PromptResource[]) {
    this.#resources = new Map(
      resources.map((resource) => [resource.id, resource]),
    )
  }

  static async load(rootDirectory: string): Promise<PromptRegistry> {
    const resources = await Promise.all([
      loadResource(
        DEFAULT_SYSTEM_PROMPT_REFS['zh-CN'].id,
        DEFAULT_SYSTEM_PROMPT_REFS['zh-CN'].version,
        path.join(rootDirectory, 'system', 'zh-CN.md'),
      ),
      loadResource(
        DEFAULT_SYSTEM_PROMPT_REFS['en-US'].id,
        DEFAULT_SYSTEM_PROMPT_REFS['en-US'].version,
        path.join(rootDirectory, 'system', 'en-US.md'),
      ),
      loadResource(
        DEFAULT_APPROVAL_PROMPT_REFS.classifyRisk.id,
        DEFAULT_APPROVAL_PROMPT_REFS.classifyRisk.version,
        path.join(rootDirectory, 'approval', 'classify-risk.md'),
      ),
      ...Object.values(DEFAULT_ORCHESTRATION_PROMPT_REFS).flatMap((localized) =>
        (['zh-CN', 'en-US'] as const).map((locale) =>
          loadResource(
            localized[locale].id,
            localized[locale].version,
            path.join(
              rootDirectory,
              'orchestration',
              `${localized[locale].id.replace('orchestration.', '')}.md`,
            ),
          ),
        ),
      ),
    ])
    return new PromptRegistry(resources)
  }

  static fromResources(resources: PromptResource[]): PromptRegistry {
    return new PromptRegistry(resources)
  }

  list(): PromptResourceSummary[] {
    return [...this.#resources.values()].map((resource) =>
      withoutContent(resource),
    )
  }

  get(id: string): PromptResource {
    const resource = this.#resources.get(id)
    if (!resource) {
      throw new Error(`Prompt resource is not registered: ${id}`)
    }
    return resource
  }

  systemPrompt(locale: AssistantLanguage, override?: string): ResolvedPrompt {
    const resource = this.get(DEFAULT_SYSTEM_PROMPT_REFS[locale].id)
    const normalizedOverride = override?.trim()
    const customized = Boolean(
      normalizedOverride && normalizedOverride !== resource.content,
    )
    return {
      content: customized ? normalizedOverride! : resource.content,
      resource: withoutContent(resource),
      customized,
    }
  }

  approvalPrompt(): ResolvedPrompt {
    const resource = this.get(DEFAULT_APPROVAL_PROMPT_REFS.classifyRisk.id)
    return {
      content: resource.content,
      resource: withoutContent(resource),
      customized: false,
    }
  }

  orchestrationPrompt(
    kind: keyof typeof DEFAULT_ORCHESTRATION_PROMPT_REFS,
    locale: AssistantLanguage,
  ): ResolvedPrompt {
    const resource = this.get(
      DEFAULT_ORCHESTRATION_PROMPT_REFS[kind][locale].id,
    )
    return {
      content: resource.content,
      resource: withoutContent(resource),
      customized: false,
    }
  }
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function withoutContent(resource: PromptResource): PromptResourceSummary {
  return {
    id: resource.id,
    version: resource.version,
    path: resource.path,
    sha256: resource.sha256,
  }
}

async function loadResource(
  id: string,
  version: string,
  filePath: string,
): Promise<PromptResource> {
  const content = (await readFile(filePath, 'utf8')).trim()
  if (!content) {
    throw new Error(`Prompt resource is empty: ${filePath}`)
  }
  if (/\{\{[^}]+\}\}/u.test(content)) {
    throw new Error(`Prompt resource has unrendered variables: ${filePath}`)
  }
  return {
    id,
    version,
    path: filePath,
    content,
    sha256: hash(content),
  }
}
