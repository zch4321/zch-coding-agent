import type {
  CodeIntelligenceCapability,
  CodeIntelligenceResult,
  ProjectModel,
} from '../../shared/project-model'

export interface CodeIntelligenceQuery {
  capability: CodeIntelligenceCapability
  workspace: string
  moduleId?: string
  path?: string
  symbolName?: string
  query?: string
}

export interface CodeIntelligenceBackend {
  query(
    project: ProjectModel,
    input: CodeIntelligenceQuery,
  ): Promise<CodeIntelligenceResult>
}
