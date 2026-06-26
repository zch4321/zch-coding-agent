# Road Map · Zch Coding Agent

本文件承接 `feature-backlog.md`，只记录下一阶段和仍未实现的产品方向。已完成的 R0-R6 不再保留在路线图正文中；历史背景以 git history、PR 说明和 release notes 为准。

每个阶段都应保持可独立评审、可测试、可回滚。当前优先级从大功能扩张转向影响可用性的基础能力：工具调用紧凑 UI、Prompt Harness、ReAct 编排、项目模块建模、语义代码工具、LSP 后端，以及 Serena/MCP 适配。

## 0. 当前结论

- Prompt 不能继续作为一整块系统提示词拼接。需要改成可审计的 layer model，并把工具 schema、运行时策略、仓库规则、环境信息和会话上下文分开处理。
- 工具调用卡片当前占用过多对话空间，应优先改成一行灰色摘要；参数、结果和自动审批输出放入右侧展开面板或行内展开详情。
- ReAct run 进行中允许用户发送补充信息，但不能打断当前工具调用链。补充信息应排队到下一个安全 checkpoint，并以明确 tag 注入给模型。
- 安全策略、权限边界、路径约束、审批要求和凭据保护属于只读 `runtime_policy`，不能被用户可编辑 Prompt 覆盖。
- 用户可编辑 Prompt 应降级为个人偏好、语气和工作方式补充，优先级低于系统基础指令、运行时策略和仓库指令。
- 项目上下文需要显式建模。多语言仓库不应靠模型每轮临时猜测，而应维护一个可追踪的 `ProjectModel / ModuleGraph`。
- 如果项目没有已配置模块，模型可以通过工具推断和设置 module 根目录；推断结果必须带来源、hash/时间和可覆盖机制。
- 如果项目已有模块，Prompt Harness 应把简洁 module 摘要注入上下文，供模型选择工具和判断代码边界。
- 当语义代码工具可用时，应鼓励模型优先使用 `code_symbol_overview`、`code_find_definition`、`code_find_references`、`code_diagnostics` 等工具，再读取局部文件内容。
- Serena、JetBrains、VS Code、LSP、ast-grep 等后端不应直接暴露成一堆原始工具给模型；模型应看到稳定的 Code Intelligence Facade。
- R7 的浏览器、多模态和高级统计暂缓，等基础可用性、Prompt Harness 与代码理解能力稳定后再推进。

## 1. Tool Call Compact UI

目标：先解决当前对话中工具调用卡片过于占地的问题，让长轮次 ReAct 输出更容易浏览。

范围：纯前端优先，不改变工具执行、审批和 provider 协议。

折叠态：

- 每个工具调用默认渲染为一行灰色摘要文本。
- 摘要包含工具名、状态、耗时、关键参数摘要和结果摘要。
- 文本必须保持单行，超出部分省略，不能撑高消息流。
- 右侧提供展开按钮，用于查看完整参数、结果、错误和审批信息。
- 多个工具调用连续出现时，视觉上保持轻量列表，而不是重复大卡片。

展开态：

- 参数和结果延迟到展开后渲染，避免大 JSON 阻塞消息流。
- 参数、结果、错误、stdout/stderr、diff 摘要分区展示。
- 自动审批的输出也纳入详情区，包括风险等级、允许/拒绝结果、理由、命中的策略和审批来源。
- 如果当前前端状态里缺少自动审批明细，先在 UI 中预留区域和类型入口；需要主进程补持久化字段时，作为后续小任务处理。
- 展开/折叠状态应按消息或 tool call id 稳定保存，切换对话时不产生明显跳动。

验收：

- 默认对话流中，工具调用只占一行灰色摘要。
- 点击右侧按钮可以展开查看完整参数和结果，再次点击收起。
- 自动审批输出能在同一处查看；没有审批信息时不显示空白大块。
- 长工具结果、连续工具调用、错误工具调用和自动审批工具调用都有前端回归测试。
- 移动宽度或窄窗口下，摘要文本、状态和展开按钮不重叠。

## 2. Prompt Harness

目标：把一次模型请求拆成稳定、可审计、可缓存的 Prompt 层，而不是在 `session-run-utils` 中拼接 `basePrompt + skillPrompt`。

建议新增模块：

```text
electron/session/prompt-harness/
├─ prompt-builder.ts
├─ prompt-layer.ts
├─ runtime-policy.ts
├─ environment-context.ts
├─ project-context.ts
├─ prompt-trace.ts
└─ provider-message-mapper.ts
```

核心类型：

```ts
type PromptLayerKind =
  | 'base_instructions'
  | 'runtime_policy'
  | 'repo_instructions'
  | 'skills_metadata'
  | 'environment_context'
  | 'project_context'
  | 'run_context'
  | 'orchestration'
  | 'history'

interface PromptLayer {
  id: string
  kind: PromptLayerKind
  role: 'system' | 'developer' | 'user'
  content: string
  source: string
  sha256: string
  estimatedTokens: number
  trusted: boolean
}
```

实现要求：

- `PromptRegistry` 继续负责加载资源文件、校验版本和记录 hash。
- `PromptBuilder` 负责构造 `PromptLayer[]`，再由 provider mapper 转成具体 provider messages。
- 基础指令和运行时策略尽量保持稳定顺序，减少 prompt cache miss。
- 工具 schema 不混入 Prompt 正文，仍由 provider tools 字段传递。
- `runtime_policy` 包含权限、审批、路径、凭据、工具输出不可信、外部内容不可信等硬规则。
- `environment_context` 每轮动态生成，包含 cwd、shell、当前日期、时区、工作区、git repo、branch、HEAD、dirty summary、主要 manifest 和 top-level structure。
- `project_context` 注入已确认或已推断的 modules、语言、manifest、LSP 后端和 module 来源。
- `repo_instructions` 注入 `AGENTS.override.md`、`AGENTS.md` 等仓库规则，支持嵌套优先级、大小限制、hash 和 untrusted 标记。
- Trace 记录 layer id、kind、source、hash、token 估算和 trusted 状态，避免只记录最终拼接后的 messages。

验收：

- 原有会话请求行为保持兼容，Provider 收到的内容语义不倒退。
- 单测覆盖 layer 顺序、hash、trusted 标记、未替换模板变量、AGENTS 优先级和环境信息裁剪。
- Trace 中可以看出每个 Prompt 片段的来源，不需要读最终大 prompt 才能排查问题。

## 3. ReAct Live Interjections

目标：允许用户在长轮次 ReAct 循环中补充信息，而不取消当前 run、不破坏 provider 的 tool call / tool result 协议顺序。

核心语义：

```text
user: 原始任务
assistant: tool_calls
tool: tool_result A
tool: tool_result B
orchestrator/user: <live_user_interjection>用户中途补充的信息</live_user_interjection>
assistant: 继续推理、下一批 tool calls 或最终回答
```

建议模型：

```ts
interface RunInterjection {
  id: string
  conversationId: string
  runId: string
  content: string
  createdAt: string
  status: 'queued' | 'injected' | 'superseded'
  injectedAfterToolBatchId?: string
}
```

实现要求：

- 用户在 run 进行中发送的新消息不启动新 run，也不立即取消当前 run。
- 当前 provider request 正在飞行中时，interjection 只能进入队列，不能修改已发送请求。
- 当前 tool batch 未完成时，interjection 不能插入到 assistant tool call 和对应 tool result 中间。
- 每个 tool batch 结束后，run loop 检查 pending interjections，并在下一次模型 continuation 前注入。
- 注入内容必须使用固定 tag，例如 `<live_user_interjection>`，并明确说明它是真实用户补充信息，不是 tool output。
- 多条 interjection 可以合并成一个 provider message，但持久化、UI 和 trace 必须保留每条原始消息。
- 如果 assistant 已经进入最终回答且不会再发起下一次 continuation，pending interjection 应作为下一轮普通用户消息，除非用户显式选择 interrupt/restart。
- “停止执行”仍然是独立控制，不依赖 interjection；interjection 不应立即终止正在运行的 shell/tool。

Prompt 规则：

```text
Messages tagged as <live_user_interjection> are real user messages received
while the current run was already in progress. They are not tool output.
Treat them as the latest user instruction for the next reasoning step, while
respecting system, developer, runtime, repository, and tool-safety instructions.
```

验收：

- 长工具调用期间发送补充信息不会破坏当前 tool result 回填。
- 下一次模型 continuation 能看到插入的 interjection，并能据此调整后续步骤。
- UI 时间线能区分普通用户消息、运行中插话、orchestrator continuation 和 tool result。
- Trace 记录 interjection 的创建时间、注入位置、tag 内容和状态变化。

## 4. ProjectModel / ModuleGraph

目标：让多语言、多子项目仓库有明确的 module 边界，为 Prompt Harness、LSP 路由和语义工具提供基础。

模块示例：

```text
workspace/
├─ frontend/  # Vue / TypeScript / package.json
├─ backend/   # Java / Gradle / Spring
└─ scripts/   # Python / pyproject.toml
```

建议模型：

```ts
interface ProjectModule {
  id: string
  root: string
  name: string
  languages: string[]
  manifests: string[]
  sourceRoots: string[]
  testRoots: string[]
  excludedRoots: string[]
  lspBackends: string[]
  source: 'auto-detected' | 'model-suggested' | 'user-confirmed' | 'manual'
  confidence: number
  updatedAt: string
}

interface ProjectModel {
  workspaceRoot: string
  modules: ProjectModule[]
  defaultModuleId?: string
  version: number
}
```

实现要求：

- 先做确定性扫描：`package.json`、`pnpm-workspace.yaml`、`tsconfig.json`、`pyproject.toml`、`requirements.txt`、`go.mod`、`Cargo.toml`、`pom.xml`、`build.gradle`、`.sln`、`*.csproj`、`CMakeLists.txt`。
- 提供 `project_get_modules`、`project_detect_modules`、`project_set_modules` 工具。
- `project_set_modules` 默认写入应用 workspace metadata，不写入仓库；后续可以支持用户显式导出到仓库配置。
- 模型可以在没有 module 配置时调用工具推断模块根目录，但推断结果必须可审计、可替换、可重新检测。
- 一个 workspace 可以有多个 module；同一个文件请求按路径归属路由到对应 module。
- 对 `node_modules`、`dist`、`build`、`target`、`.venv`、`.git` 等目录默认排除，避免污染索引和 Prompt。
- Prompt Harness 在存在模块时注入精简摘要；没有模块时提示模型先建立模块边界，再进行大范围代码探索。

验收：

- 单仓库单模块、前后端双模块、monorepo workspace、脚本目录混合项目都有测试样例。
- 模块配置不会因为模型误判而静默污染用户仓库。
- 当文件路径命中多个或零个 module 时，工具返回明确的歧义或缺失信息。

## 5. Code Intelligence Facade

目标：先定义模型可见的稳定语义代码工具，再在后面替换或叠加 LSP、Serena、JetBrains、VS Code、ast-grep 等后端。

第一批只读工具：

```text
code_symbol_overview
code_find_definition
code_find_references
code_workspace_symbols
code_diagnostics
```

实现要求：

- 工具输入使用 workspace 相对路径和可选 `moduleId`，不要暴露后端实现细节。
- 工具输出保持小而结构化，包含文件、range、symbol kind、简短上下文和后端来源。
- 如果语义后端不可用，允许回退到 `rg`、文件索引或 ast-grep，但结果要标明 `precision`。
- Prompt 中明确鼓励模型先用语义工具定位范围，再读取相关文件片段。
- `read_file` 仍保留，用于小文件、配置文件、最终确认和语义工具无法覆盖的场景。
- 写入类重构工具暂缓，先保证 read-only code intelligence 稳定。

验收：

- 模型可以在不知道具体后端的情况下完成 definition、references、diagnostics 查询。
- 大文件场景下不会默认把全文塞进上下文。
- 所有外部后端输出都按不可信内容处理，并做大小、数量和时间限制。

## 6. LSP Backend

目标：为 Code Intelligence Facade 提供第一类 IDE 能力，按 module 和文件类型自动路由到对应 language server。

优先顺序：

1. TypeScript / JavaScript / Vue：匹配当前 Electron + Vue 项目本身。
2. Python：常见脚本和自动化项目。
3. Go / Rust / Java：按用户项目需求逐步扩展。

实现要求：

- 新增 `LanguageServerManager`，按 workspace + module 复用 language server 进程。
- 新增路由层，根据文件路径、module、语言和 manifest 选择后端。
- 支持初始化、打开文件、关闭文件、definition、references、workspace symbols、diagnostics。
- diagnostics 做缓存，避免每次请求都重新启动或重新扫描。
- language server 未安装、启动失败或不支持某能力时，返回可解释错误并允许 fallback。
- LSP 进程生命周期、超时、输出大小和日志必须受主进程控制。

验收：

- 在当前 TS/Vue 项目内，能通过 facade 查询符号、定义、引用和诊断。
- 多 module 项目中，前端文件不会误用后端 language server，后端文件不会误用前端 language server。
- LSP 不可用时，Agent 仍能退回现有 grep/read-file 工作流。

## 7. Serena / MCP Adapter

目标：接入 Serena 的 symbol-level retrieval/edit/refactor 能力，但对模型保持稳定的 Code Intelligence Facade。

第一阶段：只读 Serena MVP。

- 新增 `electron/mcp/`：
  - `mcp-client-manager.ts`
  - `stdio-transport.ts`
  - `mcp-tool-adapter.ts`
  - `mcp-config.ts`
- 配置 schema 支持 server name、command、args、env allowlist、cwd、enabled tools、disabled tools、startup timeout、tool timeout 和默认审批策略。
- 每个 workspace 启动独立 Serena 进程，避免单活项目状态串线。
- Serena retrieval 能力映射到 `code_symbol_overview`、`code_find_definition`、`code_find_references`、`code_diagnostics`。
- 禁用或默认审批 shell、file edit、rename、replace、insert、memory write 等写入或副作用工具。
- MCP 工具列表不在会话中途静默改变；新增、删除或变更工具应下轮生效或要求重连。

第二阶段：写入和重构。

- rename、replace、insert、safe delete 映射到现有文件写入和权限管线。
- shell 执行映射到现有进程权限模型，默认高风险。
- Serena memory 写入单独审批，并在 UI 中可见。
- 所有 MCP 输出标记为 untrusted，并受大小、时间和 schema 校验限制。

验收：

- 不直接把原始 `mcp__serena__*` 工具暴露给模型作为默认能力。
- Serena 不可用时，Code Intelligence Facade 仍然可用或能给出明确降级信息。
- 写入类能力进入权限管线，不绕过现有文件保护、审批和 trace。

## 8. Multi-Provider Routing

目标：让一个工作区和一段对话可以稳定使用多个模型服务，而不是只有全局 `activeProviderId`。多 Provider 应支持按会话、按用途、按模型能力和按失败策略选择，同时保持凭据隔离、trace 可审计和 UI 可解释。

当前基础：

- 配置层已经有 `providers[]`、`activeProviderId`、`approval.approverProviderId` 和每个 Provider 独立 credential。
- UI 已能保存 OpenAI-compatible Provider、profile、baseURL、model、reasoning、上下文窗口覆盖值和输出上限。
- 当前主模型运行时仍应改成基于 session provider，而不是每次读取全局 active provider。
- 自动审批模型已经有独立 provider/model 配置，可以作为用途路由的第一个参考实现。

建议模型：

```ts
interface ProviderRoleBinding {
  role: 'main' | 'approval' | 'planner' | 'summarizer' | 'code_review'
  providerId: string
  model: string
  reasoning?: 'off' | 'high' | 'max'
}

interface ConversationProviderConfig {
  defaultProviderId: string
  defaultModel: string
  roleBindings: ProviderRoleBinding[]
  fallbackProviderIds: string[]
  pinned: boolean
}
```

实现要求：

- 会话创建时记录 provider/model 快照；运行中不应因为用户修改全局默认 Provider 而静默切换模型。
- `SessionProviderTurnRunner` 按 `session.provider` 和 session model/provider snapshot 选择主模型，不能继续直接使用全局 active provider。
- `ConversationRecord` 保存 providerId、model、profile 和必要的模型能力摘要，便于历史对话恢复和 trace 排查。
- Provider 配置 UI 支持新增、复制、删除、测试连接、刷新模型列表、设置默认 Provider。
- Message composer 可以选择当前对话的主 Provider/model；切换应只影响下一轮 run，并在时间线或 trace 中可见。
- 自动审批、规划、摘要、代码审查等用途可以逐步支持 role binding；第一阶段只做 `main` 与 `approval`，不做模型自动决策。
- 每次 LLM request、usage、trace、错误和重试都必须记录 providerId、providerLabel、model、role 和 profile。
- Provider fallback 必须显式配置；失败后是否切换模型要进入 orchestrator/trace，不能静默换服务商。
- 不同 Provider 的 tools/schema、reasoning、streaming、tool call 格式差异由 provider adapter 处理，session loop 不直接写 provider 特例。
- 凭据继续只在主进程和 safeStorage/env 中使用，renderer 只能看到 credentialConfigured 和 credentialSource。

验收：

- 一个对话创建后，即使全局默认 Provider 改变，该对话下一轮仍使用原本绑定的 Provider，除非用户显式切换。
- 同一工作区内两个对话可以分别使用不同 Provider/model，并且 usage、trace 和 UI 都能准确显示。
- 自动审批可以使用不同于主模型的 Provider，失败时不会暴露密钥，也不会绕过人工审批。
- Provider 不可用、凭据缺失、模型列表过期和 fallback 触发都有可解释错误和测试覆盖。
- OpenAI-compatible 的 DeepSeek profile 与 generic profile 都能通过同一 provider adapter 流程运行。

## 9. Deferred / Later

原 R7 暂缓到后续阶段：

- 内置隔离浏览器工具。
- 浏览器 Comments/Annotations。
- 生产可选 Chrome/Edge 扩展。
- 多模态 content parts：图片、截图、剪贴板、拖拽文件。
- token 热力图、模型用量折线图、缓存命中率趋势。
- 高级 trace/usage 查询。

其他暂缓项：

- Provider stream 未结束前提前执行工具。
- 直接控制用户 Chrome 默认 profile。
- 浏览器 Cookie、密码、Local Storage 读取工具。
- 云端同步和团队共享项目。
- 完整插件市场。

## 10. 阶段门禁

每个实现阶段至少通过：

- `npm run lint`
- `npm run format:check`
- `npm run typecheck`
- `npm test`

涉及 Electron UI、文件树、审批、终端、设置、浏览器或 MCP 进程生命周期的阶段，还必须补充对应 E2E 或集成测试。真实 Provider 和外部 Serena/LSP 测试继续保持 opt-in，不能进入默认单测链路。
