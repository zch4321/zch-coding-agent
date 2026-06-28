# Road Map · Zch Coding Agent

本文件承接 `feature-backlog.md`，只记录下一阶段和仍未实现的产品方向。已完成的 R0-R6 不再保留在路线图正文中；历史背景以 git history、PR 说明和 release notes 为准。

每个阶段都应保持可独立评审、可测试、可回滚。当前优先级从大功能扩张转向影响可用性的基础能力：工具调用紧凑 UI、Prompt Harness、ReAct 编排、项目模块建模、语义代码工具、IDE 后端适配、Serena/MCP 适配，以及真实长程 Agent Benchmark。

## 0. 当前结论

- Prompt 不能继续作为一整块系统提示词拼接。需要改成可审计的 layer model，并把工具 schema、运行时策略、仓库规则、环境信息和会话上下文分开处理。
- 工具调用卡片当前占用过多对话空间，应优先改成一行灰色摘要；参数、结果和自动审批输出放入右侧展开面板或行内展开详情。
- ReAct run 进行中允许用户发送补充信息，但不能打断当前工具调用链。补充信息应排队到下一个安全 checkpoint，并以明确 tag 注入给模型。
- 安全策略、权限边界、路径约束、审批要求和凭据保护属于只读 `runtime_policy`，以非系统上下文注入但不能被用户可编辑 Prompt 覆盖。
- 用户可编辑 Prompt 应降级为个人偏好、语气和工作方式补充，优先级低于系统基础指令、运行时策略和仓库指令。
- 项目上下文需要显式建模。多语言仓库不应靠模型每轮临时猜测，而应维护一个可追踪的 `ProjectModel / ModuleGraph`。
- 如果项目没有已配置模块，模型和用户都可以通过工具设置 module 根目录；自动检测只能作为可替换组件提供建议，检测结果必须带来源、hash/时间和可覆盖机制。
- Module 配置保存为当前 workspace 的 `.zch/project-model.json` 项目元数据；应用可自动创建 `.zch/`，但不自动修改 `.gitignore`，只在 Project tab 提示用户是否忽略。
- 如果项目已有模块，Prompt Harness 应把简洁 module 摘要注入上下文，供模型选择工具和判断代码边界。
- 当语义代码工具可用时，Harness 应从提示词和工具描述层面鼓励模型优先使用 `code_symbol_overview`、`code_find_definition`、`code_find_references`、`code_diagnostics` 等 IDE 级工具，再读取局部文件内容。
- Serena、JetBrains、VS Code、LSP、ast-grep 等后端不应直接暴露成一堆原始工具给模型；模型应看到稳定的 Code Intelligence Facade。每种语言使用哪个后端由用户配置，不在同一语言上自动并行混用多个后端。
- R4-R7 的第一条 vertical slice 已落地：`.zch` ProjectModel、Project tab、Project 工具、Code Intelligence Facade、Serena MCP 只读 adapter 和 Serena v1 稳定化。当前仍是 v1：没有完整 LSP 后端、没有多后端矩阵、没有写入类 IDE 重构能力。
- Serena v1 已验证可通过 stdio MCP 启动并映射只读能力，Project tab 已提供结构化启动配置和启动命令预览，dashboard 默认保留但不自动打开。当前仍依赖用户本机安装或 command 绝对路径；托管安装、完整 module 编辑器、多后端配置和写入类 IDE 重构能力是下一步。
- 真实 LLM 端到端能力不应继续伪装成普通测试。需要独立 Benchmark Harness，用真实仓库任务、官方 evaluator、Playwright 前端操作和 trace 指标评估 coding agent harness 是否有效。
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
- 基础指令保持稳定 system 前缀；运行时策略和环境上下文作为非系统动态层注入，尽量保持稳定顺序以减少 prompt cache miss。
- 工具 schema 不混入 Prompt 正文，仍由 provider tools 字段传递。
- `runtime_policy` 包含权限、审批、路径、凭据、工具输出不可信、外部内容不可信等硬规则。
- `environment_context` 每轮动态生成，包含 cwd、shell、当前日期、时区、工作区、git repo、branch、HEAD、dirty summary、主要 manifest 和 top-level structure。
- `project_context` 注入当前 workspace 的 modules、语言、manifest、每种语言配置的 code intelligence backend 和 module 来源；模型设置或检测得到的 module 也必须带来源和更新时间。
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

目标：让多语言、多子项目仓库有明确的 module 边界，为 Prompt Harness、IDE 工具路由和语义代码工具提供基础。核心只定义数据模型、存储、工具接口和路由约定；自动检测、语言理解和 IDE 后端实现都应作为可替换组件接入。

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
  backendHints: string[]
  source: 'detected' | 'agent-set' | 'user-set' | 'imported'
  confidence: number
  fingerprint: string
  updatedAt: string
}

interface ProjectModel {
  schemaVersion: 1
  workspaceRoot: string
  modules: ProjectModule[]
  defaultModuleId?: string
  storage: 'project-local'
  backendBindings: CodeBackendBinding[]
  serena: SerenaBackendConfig
  updatedAt: string
}
```

当前实现：

- 已新增 `shared/project-model.ts`，定义 `ProjectModel`、`ProjectModule`、`CodeBackendBinding`、`CodeBackendStatus` 和 code intelligence 结果结构。
- 已新增 `ProjectMetadataStore`，默认读写 `<workspace>/.zch/project-model.json`；该文件不存 API key、大 trace 或原始工具输出。
- 已新增轻量 `ProjectModuleDetector`，按 manifest 检测单模块、多模块和常见语言线索；检测结果来源为 `detected`。
- 已新增 agent 工具：`project_get_modules`、`project_detect_modules`、`project_set_modules`、`project_update_module`。
- 已新增 Artifact Panel 的 Project tab，展示 modules、检测结果、结构化 Serena 配置、启动命令预览、backend status 和 `.zch/` gitignore 建议。
- Prompt Harness 已优先使用 ProjectModel 摘要注入 module/backend context；没有 metadata store 时才退回旧的临时 manifest 检测。

实现要求：

- `project_set_modules` 和 `project_update_module` 只写入 `.zch/project-model.json` 项目元数据，不修改源码文件或 git 历史；该受控 metadata 写入在所有权限模式下允许自动执行。
- `.zch/project-model.json` 不存 API key、大 trace 或原始工具输出；应用不自动写 `.gitignore`，Project tab 只显示建议。
- 模型可以在没有 module 配置时自行调用工具设置 module 根目录，也可以在发现配置不合适时自行修正；Prompt 和 UI 必须能展示当前 module 来源，避免用户误以为这是仓库事实。
- 自动检测通过 `ProjectModuleDetector` 接口接入，核心不内置不断膨胀的语言生态规则。当前内置检测器只做轻量 manifest 扫描；后续检测器可以由插件、MCP server 或受维护的开源工具提供。
- 内置检测器只做低风险的 manifest/workspace 线索聚合；复杂语言规则优先委托给持续维护的工具或插件，而不是在核心里长期维护。
- 一个 workspace 可以有多个 module；同一个文件请求按路径归属路由到对应 module。
- 对 `node_modules`、`dist`、`build`、`target`、`.venv`、`.git` 等目录默认排除，避免污染索引和 Prompt。
- Prompt Harness 在存在模块时注入精简摘要；没有模块时提示模型先建立模块边界，再进行大范围代码探索。

下一步：

- Project tab 增加完整手动编辑能力：module root、languages、sourceRoots、testRoots、excludedRoots、default module 和来源说明。当前 UI 只能查看、重新检测并保存检测结果；agent 已可通过 `project_set_modules` / `project_update_module` 设置 module。
- 为 module metadata 更新补 trace/change history 摘要，便于审计和回滚。
- 明确 `.zch/` 文件的 Git 噪音处理：继续只提示，不自动改 `.gitignore`；可增加复制建议或一键打开 `.gitignore`。
- 评估是否把内置 detector 替换为或接入受维护的 project detector，而不是继续在核心里扩展语言规则。

验收：

- 单仓库单模块、前后端双模块、monorepo workspace、脚本目录混合项目都有测试样例。
- 模块配置不会因为模型误判而静默污染源码或 git 历史；`.zch/` 只保存本应用项目元数据，并在未被 `.gitignore` 忽略时提示用户。
- 当文件路径命中多个或零个 module 时，工具返回明确的歧义或缺失信息。
- Prompt Harness 能把当前 module 摘要和来源注入上下文，模型能据此选择后续 IDE 级工具。

## 5. Code Intelligence Facade

目标：先定义模型可见的稳定 IDE 级语义代码工具，让 Harness 从工具描述和提示词层面鼓励 agent 优先使用它们；后端可以替换为 LSP、Serena、JetBrains、VS Code、ast-grep、索引器或 MCP server，但不直接暴露后端原始工具给模型。

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
- 每种语言在同一 workspace/module 中只使用一个用户配置的首选后端；不要对同一语言自动并行查询多个后端。第一版不静默 fallback；后端不可用或能力缺失时返回结构化 `code`、`precision` 和 `message`。
- Prompt 和工具描述中明确鼓励模型先用语义工具定位范围，再读取相关文件片段。
- `read_file` 仍保留，用于小文件、配置文件、最终确认和语义工具无法覆盖的场景。
- 写入类重构工具暂缓，先保证 read-only code intelligence 稳定。
- 后续 IDE 级编辑能力单独设计，不在第一批实现。候选能力包括 `code_rename_symbol`、`code_replace_symbol_body`、`code_update_definition`、`code_apply_refactor_preview` 和项目问题反馈；所有写入都必须进入现有文件变更、diff、审批和 trace 管线。

当前实现：

- 已新增模型可见的只读 facade 工具：`code_symbol_overview`、`code_find_definition`、`code_find_references`、`code_workspace_symbols`、`code_diagnostics`。
- 输出已统一包含 `backendId`、`capability`、`precision`、`source`、`truncated`、`items`，错误路径返回结构化 `code` 和 `message`。
- 工具和 base prompt 已提醒模型优先使用 ProjectModel 与 `code_*` 工具定位范围，再读局部文件。
- `code_symbol_overview` 已收紧为文件级工具；目录输入会返回结构化 `PATH_NOT_FILE`，目录场景应改用 `code_workspace_symbols`、`rg` 或后续独立 `code_directory_overview`。
- `code_diagnostics` 已映射 Serena `get_diagnostics_for_file`，先支持文件级 diagnostics；如果 Serena 不暴露该 raw tool，则返回 `UNSUPPORTED_CAPABILITY`。

下一步：

- 设计目录级 overview/diagnostics 的有界能力，避免把大目录一次性塞给后端或上下文。
- 扩展 diagnostics 结果缓存、过期标记和 UI 展示，避免每次查询都重新触发昂贵后端扫描。
- 在 benchmark trace 中记录 facade 命中率、读文件 token、首次定位正确文件耗时和 fallback/unsupported 原因。

验收：

- 模型可以在不知道具体后端的情况下完成 definition、references、diagnostics 查询。
- 大文件场景下不会默认把全文塞进上下文。
- 所有外部后端输出都按不可信内容处理，并做大小、数量和时间限制。
- 在支持 IDE 后端的项目中，Benchmark 和 trace 能看到 agent 优先使用 Code Intelligence Facade，而不是直接退回大范围全文读取。

## 6. Code Intelligence Backend Routing

目标：为 Code Intelligence Facade 提供后端配置、能力发现和路由层。核心只管理“哪个 module/语言 使用哪个后端”的选择，不自研语言服务后端，也不把同一语言自动分发给多个后端。

建议模型：

```ts
interface CodeBackendBinding {
  id: string
  moduleId?: string
  language: string
  backendId: string
  enabled: boolean
  capabilities: Array<
    | 'symbol_overview'
    | 'definition'
    | 'references'
    | 'workspace_symbols'
    | 'diagnostics'
    | 'rename'
    | 'edit'
  >
  configuredBy: 'user' | 'imported'
  updatedAt: string
}
```

实现要求：

- 新增 Code Intelligence 后端管理/路由层，根据 workspace、module、语言、文件路径和用户配置选择一个后端。
- 用户可在 Artifact Panel 的项目配置 tab 中为每种语言选择后端，例如内置 LSP 插件、JetBrains/WebStorm MCP、Serena MCP、VS Code adapter 或通用 fallback。
- 路由层必须返回明确错误：未配置、后端不可用、能力不支持、路径无法归属 module、后端超时。
- 后端能力通过统一接口暴露，不把 LSP、MCP 或 IDE 的原始协议细节泄露给模型。
- 诊断结果允许缓存，但必须带生成时间、后端、moduleId、语言和是否可能过期。
- 后端进程或外部连接的生命周期、超时、输出大小、日志和信任边界必须受主进程控制或由对应插件声明并接受统一约束。

当前实现：

- 已新增 `CodeBackendManager`，按 ProjectModel、module、language 和 enabled binding 路由到 Serena adapter。
- 当前只支持一个 Serena backend；数据模型预留了按语言和 module 绑定，但 UI 只提供全局 Serena 开关、结构化启动配置、启动命令预览和 backend status。
- 当前没有自研 `LanguageServerManager`，也没有 TypeScript/Go/Python LSP 进程管理；语言理解能力来自 Serena 自己的 backend。
- 后端不可用、module 不匹配、path 不属于 module、文件级工具传入目录、能力不支持都会返回结构化 unsupported 结果。
- Serena ready 后会根据实际 `tools/list` 计算 capabilities；启动失败状态会保留到下一次 restart，并在 status message 中包含受控启动摘要和 stderr 尾部。

下一步：

- Project tab 增加按 module/language 的 backend 选择和能力展示，而不是只有全局 Serena 开关。
- 增加 backend startup/restart/stop 的持久 trace event，包含 command、cwd、argv 摘要、pid、stderr 尾部和错误 code；当前这些信息只体现在 backend status message 中。
- 后续再评估是否接入 JetBrains/WebStorm MCP、VS Code adapter 或插件化 LSP；核心不直接维护多语言 LSP 生态。

验收：

- 在当前 TS/Vue 项目内，能通过 facade 查询符号、定义、引用和诊断，具体后端由用户配置决定。
- 多 module 项目中，前端文件不会误用后端语言的 code backend，后端文件不会误用前端语言的 code backend。
- 配置缺失或后端不可用时，Agent 仍能退回现有 grep/read-file 工作流，并在 trace 中记录降级原因。

## 7. IDE / MCP Backend Adapters

目标：接入 Serena、JetBrains/WebStorm、VS Code、LSP 插件等 IDE 级后端，但对模型保持稳定的 Code Intelligence Facade。MCP 或 IDE 后端是能力来源，不是模型直接调用的一组默认工具。

第一阶段：Serena MCP 只读 backend v1。

- 当前已通过官方 MCP TypeScript SDK 接入 Serena stdio server，没有直接暴露 raw `mcp__serena__*` 工具给模型。
- 当前映射 Serena raw tools：`get_symbols_overview`、`find_symbol`、`find_referencing_symbols`、`get_diagnostics_for_file`。
- 当前禁止 memory、shell、edit、rename、insert、replace 等 raw MCP 工具进入模型 tool schema。
- 当前 Serena 使用结构化项目配置生成 argv：`command`、`context`、`projectMode`、`languageBackend`、`enableWebDashboard`、`openWebDashboard`、`logLevel`、`startupTimeoutMs`、`toolTimeoutMs` 和 `extraArgs` 保存在 `.zch/project-model.json`。旧 raw `args` 会在读取时迁移到结构化字段。
- Dashboard 默认保留但不自动打开：默认生成 `--open-web-dashboard false`，`enableWebDashboard` 不强制关闭。
- 后端 ready capabilities 根据 Serena `tools/list` 动态生成；启动失败 status 会保留错误摘要、argv preview 和 stderr tail。
- 当前依赖用户本机安装 Serena，且应用进程能通过 PATH 或绝对路径找到 command；尚未实现托管安装。

下一步：

- 实现 Serena 托管安装 resolver：优先 managed Serena，其次 custom command；提供安装、修复、版本、license notice 和 sha256 校验。
- 增加 backend 持久日志/trace，解决 PATH、spawn、startup timeout、tool list 缺失等问题的可诊断性；当前只有 Project tab status 展示受控摘要。
- 明确是否在 adapter 内部消费 Serena `initial_instructions` / `onboarding`；默认不要把 Serena 自身 agent prompt 混入本应用 Prompt Harness。
- MCP 工具列表不在会话中途静默改变；新增、删除或变更工具应下轮生效或要求重连。

第二阶段：写入和重构。

- rename、replace、insert、safe delete、实现替换、定义更新等 IDE 级编辑能力映射到现有文件写入、diff、审批、trace 和回滚管线。
- 写入类后端调用应优先返回 preview/diff，只有用户或权限管线允许后才落盘。
- 修改后提供项目问题反馈：自动刷新相关 diagnostics、展示新增/消失的问题，并把问题摘要写入 run timeline。
- shell 执行映射到现有进程权限模型，默认高风险。
- Serena memory 写入单独审批，并在 UI 中可见。
- 所有 MCP 输出标记为 untrusted，并受大小、时间和 schema 校验限制。

验收：

- 不直接把原始 `mcp__serena__*`、`mcp__jetbrains__*`、`mcp__vscode__*` 等工具暴露给模型作为默认能力。
- IDE/MCP 后端不可用时，Code Intelligence Facade 仍然可用或能给出明确降级信息。
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

## 9. Agent Benchmark Harness

目标：建立独立于 `npm test` / `npm run test:e2e` 的真实 coding-agent benchmark，用来评估“当前 harness + 前端 UI + 工具系统 + 真实 LLM”能否完成复杂长程工程任务。它不是常规测试门禁，也不是 provider 连通性 demo；它应能暴露 Prompt Harness、工具选择、审批、上下文管理、测试迭代、trace 和安全边界的真实问题。

建议目录：

```text
benchmarks/
├─ README.md
├─ playwright.benchmark.config.ts
├─ run-benchmark.cjs
├─ lib/
│  ├─ app.ts
│  ├─ case-runner.ts
│  ├─ dataset.ts
│  ├─ approvals.ts
│  ├─ scoring.ts
│  ├─ artifacts.ts
│  └─ redaction.ts
├─ cases/
│  ├─ swe-bench-pro/
│  ├─ swe-evo/
│  ├─ swe-marathon/
│  └─ harness-stress/
└─ results/
```

数据集策略：

- 第一优先级接入 SWE-bench Pro：使用其任务数据作为 agent 输入，用官方 Docker evaluator 作为最终裁判。Agent 只看到 `problem_statement`、仓库 `base_commit`、公开约束和工作区；不得看到 gold patch、`test_patch`、`fail_to_pass` 或 `pass_to_pass`。
- 评测时从 SWE-bench Pro instance 取出 Docker image 中的 `/app` 到临时 workspace，reset 到 `base_commit`，交给本应用打开；agent 完成后导出 `git diff --binary base_commit`，再提交给官方 evaluator 判定 resolved。
- 后续接入 SWE-EVO / SWE-Chain 类软件演进任务，用于验证跨版本升级、长程上下文和反复测试修复。
- SWE-Marathon 作为高成本 full/nightly 旗舰 benchmark，只用于少量多小时任务，不进入日常开发循环。
- 自建 `harness-stress` 只覆盖外部 benchmark 不关心的产品语义：confirm 审批、运行中插话、workspace path guard、trace/key 泄漏、终端长输出、中断与恢复。

执行模型：

- 新增 `npm run benchmark:smoke`、`npm run benchmark`、`npm run benchmark:full`，全部 opt-in，不进入默认 `npm test`、`npm run test:e2e` 或 release build 门禁。
- Benchmark runner 负责准备临时 workspace、启动 Electron、通过 Playwright 在真实前端发送任务、点击审批、发送插话、等待 run 完成，并收集最终 patch、trace、截图、workbench、日志和用量。
- Setup 可以通过受控 IPC 写入 workspace、provider、privacy notice 和 logging 配置，避免 native file picker 与密钥输入影响稳定性；被评估的核心行为必须走前端 UI：发消息、审批、插话、计划批准和结果查看。
- API Key 只通过主进程环境变量注入，例如 `DEEPSEEK_API_KEY`；renderer 只能看到 `credentialConfigured` / `credentialSource`。Benchmark 不在 UI 中输入真实 key，结束后必须扫描 trace、workbench、日志、终端输出和 artifacts，确认没有密钥明文。
- 每个 case 都在独立临时目录运行，初始 workspace 必须 git-clean。最终 patch 必须能在干净 evaluator 环境中从 `base_commit` 独立应用。

评分口径：

- `resolved` 使用对应数据集官方 evaluator；对 SWE-bench Pro，核心是官方脚本在干净 Docker 中应用 patch、运行 instance 的 `run_script.sh`，解析测试输出，并要求 `fail_to_pass ∪ pass_to_pass` 全部通过。
- 自建 case 必须有隐藏 evaluator，并提供 oracle patch 自检：baseline 必须失败，应用 oracle patch 后必须通过，no-op 不能通过。
- 单个 case 先过硬门禁：run 未崩溃/超时、patch 可应用、隐藏或官方 evaluator 通过、无 workspace 外写入、无密钥泄漏、权限模式未被绕过。硬门禁失败则该 case 记 0 分。
- 通过硬门禁后计算加权分：功能正确性、harness 覆盖度、安全与边界、迭代效率、UI/trace 完整性。Harness 覆盖度由 trace 和 UI 证明，包括是否发生真实工具调用、provider continuation、测试失败后再修复、审批卡决策、interjection 注入、plan 状态流转和 usage 记录。
- 输出 `summary.json`、`summary.md` 和每个 case 的 artifacts：`workspace.patch`、evaluator log、agent trace、Playwright trace、截图、token/cost/duration/tool-call metrics。

验收：

- 可以从 SWE-bench Pro 中选择单个 instance，自动准备临时 workspace，经由本应用前端完成任务，再用官方 evaluator 得到 resolved/unresolved。
- `benchmark:smoke` 能跑一个小规模真实任务并产出完整 artifacts；失败时能看出是 agent 解题失败、harness 失败、evaluator 失败还是环境失败。
- `benchmark` 至少覆盖 10 个中等复杂任务，包含多文件修改、测试失败迭代、命令执行、读写工具和审批。
- `benchmark:full` 至少包含 1 个长程任务，要求模型制定计划、跨多轮运行测试、根据失败反复修改，并记录完整 trace。
- Benchmark 结果不阻塞普通开发测试，但可作为 Prompt Harness、语义工具、Provider routing 和权限策略改动的回归对比指标。

## 10. Deferred / Later

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

## 11. 阶段门禁

每个实现阶段至少通过：

- `npm run lint`
- `npm run format:check`
- `npm run typecheck`
- `npm test`

涉及 Electron UI、文件树、审批、终端、设置、浏览器或 MCP 进程生命周期的阶段，还必须补充对应 E2E 或集成测试。真实 Provider 和外部 Serena/LSP 测试继续保持 opt-in，不能进入默认单测链路。
