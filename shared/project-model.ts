import { Type, type Static } from '@sinclair/typebox'

export const ProjectModuleSourceSchema = Type.Union([
  Type.Literal('detected'),
  Type.Literal('agent-set'),
  Type.Literal('user-set'),
  Type.Literal('imported'),
])
export type ProjectModuleSource = Static<typeof ProjectModuleSourceSchema>

export const CodeIntelligenceCapabilitySchema = Type.Union([
  Type.Literal('symbol_overview'),
  Type.Literal('definition'),
  Type.Literal('references'),
  Type.Literal('workspace_symbols'),
  Type.Literal('diagnostics'),
  Type.Literal('rename'),
  Type.Literal('edit'),
])
export type CodeIntelligenceCapability = Static<
  typeof CodeIntelligenceCapabilitySchema
>

export const CodeBackendKindSchema = Type.Union([
  Type.Literal('serena-mcp'),
  Type.Literal('fallback'),
])
export type CodeBackendKind = Static<typeof CodeBackendKindSchema>

export const ProjectModuleSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    root: Type.String({ minLength: 1, maxLength: 4_096 }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    languages: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      maxItems: 32,
    }),
    manifests: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 64,
    }),
    sourceRoots: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 64,
    }),
    testRoots: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 64,
    }),
    excludedRoots: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
      maxItems: 128,
    }),
    backendHints: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 32,
    }),
    source: ProjectModuleSourceSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    fingerprint: Type.String({ minLength: 1, maxLength: 128 }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
)
export type ProjectModule = Static<typeof ProjectModuleSchema>

export const CodeBackendBindingSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    moduleId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    language: Type.String({ minLength: 1, maxLength: 64 }),
    backendId: Type.String({ minLength: 1, maxLength: 128 }),
    backendKind: CodeBackendKindSchema,
    enabled: Type.Boolean(),
    capabilities: Type.Array(CodeIntelligenceCapabilitySchema, {
      maxItems: 16,
    }),
    configuredBy: Type.Union([Type.Literal('user'), Type.Literal('imported')]),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
)
export type CodeBackendBinding = Static<typeof CodeBackendBindingSchema>

export const SerenaBackendConfigSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    enabled: Type.Boolean(),
    command: Type.String({ minLength: 1, maxLength: 512 }),
    args: Type.Array(Type.String({ maxLength: 2_048 }), { maxItems: 64 }),
    cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    startupTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
    toolTimeoutMs: Type.Integer({ minimum: 1_000, maximum: 300_000 }),
    languages: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      maxItems: 32,
    }),
  },
  { additionalProperties: false },
)
export type SerenaBackendConfig = Static<typeof SerenaBackendConfigSchema>

export const CodeBackendStatusSchema = Type.Object(
  {
    backendId: Type.String({ minLength: 1, maxLength: 128 }),
    backendKind: CodeBackendKindSchema,
    state: Type.Union([
      Type.Literal('not_configured'),
      Type.Literal('stopped'),
      Type.Literal('starting'),
      Type.Literal('ready'),
      Type.Literal('error'),
    ]),
    capabilities: Type.Array(CodeIntelligenceCapabilitySchema, {
      maxItems: 16,
    }),
    message: Type.Optional(Type.String({ maxLength: 4_096 })),
    pid: Type.Optional(Type.Integer({ minimum: 1 })),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
)
export type CodeBackendStatus = Static<typeof CodeBackendStatusSchema>

export const ProjectModelSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    workspaceRoot: Type.String({ minLength: 1, maxLength: 4_096 }),
    modules: Type.Array(ProjectModuleSchema, { maxItems: 64 }),
    defaultModuleId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128 }),
    ),
    storage: Type.Literal('project-local'),
    backendBindings: Type.Array(CodeBackendBindingSchema, { maxItems: 128 }),
    serena: SerenaBackendConfigSchema,
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
)
export type ProjectModel = Static<typeof ProjectModelSchema>

export const ProjectModelFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    project: ProjectModelSchema,
  },
  { additionalProperties: false },
)
export type ProjectModelFile = Static<typeof ProjectModelFileSchema>

export const DetectedProjectModulesSchema = Type.Object(
  {
    modules: Type.Array(ProjectModuleSchema, { maxItems: 64 }),
  },
  { additionalProperties: false },
)
export type DetectedProjectModules = Static<typeof DetectedProjectModulesSchema>

export const ProjectMetadataSnapshotSchema = Type.Object(
  {
    project: ProjectModelSchema,
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    gitIgnoreRecommended: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type ProjectMetadataSnapshot = Static<
  typeof ProjectMetadataSnapshotSchema
>

export const CodeSymbolKindSchema = Type.Union([
  Type.Literal('file'),
  Type.Literal('module'),
  Type.Literal('namespace'),
  Type.Literal('package'),
  Type.Literal('class'),
  Type.Literal('method'),
  Type.Literal('property'),
  Type.Literal('field'),
  Type.Literal('constructor'),
  Type.Literal('enum'),
  Type.Literal('interface'),
  Type.Literal('function'),
  Type.Literal('variable'),
  Type.Literal('constant'),
  Type.Literal('string'),
  Type.Literal('number'),
  Type.Literal('boolean'),
  Type.Literal('array'),
  Type.Literal('object'),
  Type.Literal('key'),
  Type.Literal('null'),
  Type.Literal('enum_member'),
  Type.Literal('struct'),
  Type.Literal('event'),
  Type.Literal('operator'),
  Type.Literal('type_parameter'),
  Type.Literal('unknown'),
])
export type CodeSymbolKind = Static<typeof CodeSymbolKindSchema>

export const CodeRangeSchema = Type.Object(
  {
    startLine: Type.Integer({ minimum: 1 }),
    startColumn: Type.Integer({ minimum: 1 }),
    endLine: Type.Integer({ minimum: 1 }),
    endColumn: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
)
export type CodeRange = Static<typeof CodeRangeSchema>

export const CodeSymbolItemSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 512 }),
    kind: CodeSymbolKindSchema,
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
    range: Type.Optional(CodeRangeSchema),
    containerName: Type.Optional(Type.String({ maxLength: 512 })),
    context: Type.Optional(Type.String({ maxLength: 4_096 })),
  },
  { additionalProperties: false },
)
export type CodeSymbolItem = Static<typeof CodeSymbolItemSchema>

export const CodeDiagnosticSeveritySchema = Type.Union([
  Type.Literal('error'),
  Type.Literal('warning'),
  Type.Literal('info'),
  Type.Literal('hint'),
])
export type CodeDiagnosticSeverity = Static<typeof CodeDiagnosticSeveritySchema>

export const CodeDiagnosticItemSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4_096 }),
    range: Type.Optional(CodeRangeSchema),
    severity: CodeDiagnosticSeveritySchema,
    message: Type.String({ minLength: 1, maxLength: 4_096 }),
    source: Type.Optional(Type.String({ maxLength: 256 })),
    code: Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: false },
)
export type CodeDiagnosticItem = Static<typeof CodeDiagnosticItemSchema>

export const CodeIntelligenceResultCodeSchema = Type.Union([
  Type.Literal('UNSUPPORTED_CAPABILITY'),
  Type.Literal('BACKEND_UNAVAILABLE'),
  Type.Literal('MODULE_NOT_FOUND'),
  Type.Literal('PATH_OUTSIDE_MODULE'),
])
export type CodeIntelligenceResultCode = Static<
  typeof CodeIntelligenceResultCodeSchema
>

export const CodeIntelligenceResultSchema = Type.Object(
  {
    backendId: Type.String({ minLength: 1, maxLength: 128 }),
    capability: CodeIntelligenceCapabilitySchema,
    precision: Type.Union([
      Type.Literal('semantic'),
      Type.Literal('syntactic'),
      Type.Literal('fallback'),
      Type.Literal('unsupported'),
    ]),
    source: Type.String({ minLength: 1, maxLength: 256 }),
    truncated: Type.Boolean(),
    items: Type.Array(
      Type.Union([CodeSymbolItemSchema, CodeDiagnosticItemSchema]),
      {
        maxItems: 200,
      },
    ),
    message: Type.Optional(Type.String({ maxLength: 4_096 })),
    code: Type.Optional(CodeIntelligenceResultCodeSchema),
  },
  { additionalProperties: false },
)
export type CodeIntelligenceResult = Static<typeof CodeIntelligenceResultSchema>
