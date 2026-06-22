# Road Map · Zch Coding Agent

本文件承接 `feature-backlog.md`，用于记录已确认的产品方向、实现顺序和关键约束。它不是一次性实现清单；每个阶段都应保持可独立评审、可测试、可回滚。

## 0. 已确认决策

- Prompt 不应散落在代码中。系统、审批、续跑、命令模板等默认 Prompt 需要放入独立资源文件，由 `PromptRegistry` 加载、校验、版本化和记录 hash。
- 自动审批 Prompt 不允许用户编辑。它可以被查看版本/hash，但不能通过设置页面覆盖。
- 用户系统 Prompt 继续允许配置；默认值来自资源文件，用户配置仅作为 override。
- Goal 允许多次自动续跑，直到 Agent 显式调用结束 Goal 的工具，或者进入暂停、阻塞、取消、资源上限状态。
- Goal 续跑 Prompt 必须作为可见的编排消息出现在对话中，不能隐藏在系统层。
- Plan 只允许一次自动续跑。续跑后仍有未完成计划项时，不再自动运行，必须显式警告用户并等待用户确认。
- 浏览器能力优先做隔离的内置浏览器；用户 Chrome 登录态与扩展集成延后。
- 流式输出未结束前提前执行工具暂缓实现，除非 Provider 明确提供 finalized tool-call 事件。

## 1. 基础原则

### 1.1 模块边界优先

当前最主要的工程风险不是缺功能，而是职责集中。新功能进入前，必须先拆分主进程、Agent runtime、前端 store 和文件工具。

目标不是机械追求 500 行以下，而是让每个文件只承担一个清晰职责，并能独立测试。

### 1.2 配置是软限制，代码保留硬上限

读文件、写文件、补丁、diff、工具输出、审批超时、终端超时、上下文预算等都应配置化；但配置值必须被不可绕过的硬上限夹住，防止资源耗尽、过大 IPC 和无界等待。

### 1.3 对话状态归主进程管理

当前 renderer `localStorage` 不足以支撑分支、导入导出、统计、回滚和大量历史。后续应引入主进程 WorkbenchStore，renderer 只持有 UI draft 和当前投影。

### 1.4 可见编排

任何由系统代替用户追加给模型的续跑、压缩、计划检查、Goal 检查 Prompt，都必须在对话中可见，并标记为 `orchestrator` 来源。Provider 不支持该角色时，内部可映射为 user message，但持久化和 UI 不能伪装成用户输入。

## 2. 关键设计

### 2.1 PromptRegistry

建议资源结构：

```text
resources/prompts/
├─ system/
│  ├─ zh-CN.md
│  └─ en-US.md
├─ approval/
│  └─ classify-risk.md
├─ orchestration/
│  ├─ goal-continue.zh-CN.md
│  ├─ goal-continue.en-US.md
│  ├─ plan-continue.zh-CN.md
│  └─ plan-continue.en-US.md
└─ commands/
   └─ ...
```

实现要求：

- Prompt ID、locale、version/hash 必须可追踪。
- 模板变量必须有 schema，渲染后不得留下未替换变量。
- 安全 Prompt 只读打包，用户不能覆盖。
- Trace 记录 Prompt ID 与 hash，不重复记录不可编辑 Prompt 全文。

### 2.2 Goal

Goal 是 conversation 级持久目标，只允许一个 active goal。

建议状态：

```text
active -> paused -> active
active -> blocked -> active
active -> completed
active -> cancelled
```

模型工具：

- `goal_get`
- `goal_complete({ summary, evidence, remainingRisks })`
- `goal_block({ reason, requiredInput })`

用户入口：

- `/goal <objective>` 创建或替换目标并立即开始执行。
- UI 提供暂停、恢复、编辑、取消、查看状态。
- Goal 文本应包含可验证完成标准；长目标应允许引用文件。

续跑策略：

- 每轮结束后，如果 Goal 仍为 active 且未调用 `goal_complete` 或 `goal_block`，插入可见 `goal-continuation` 消息并继续。
- Goal 续跑受最大轮数、最大 token、最大持续时间和连续失败次数限制。
- 达到上限时进入 paused，不得标记完成。
- Goal active 时，如果存在未完成 plan 项，不允许直接完成 Goal，除非明确取消这些计划项并说明原因。

### 2.3 Plan

Plan 是任务分解和进度可视化，不等同于 Goal。

计划项状态：

```text
pending | in_progress | completed | blocked | cancelled
```

实现要求：

- 完成计划项必须提供 result/evidence，不能只打勾。
- Plan 显示在右侧 Tasks 面板。
- 独立 Plan 在 run 结束后仍未清空时，最多自动续跑一次。
- 自动续跑 Prompt 必须出现在对话中。
- 续跑后仍未清空时，显示警告并等待用户确认。
- 如果 Plan 属于 active Goal，则 Goal 续跑策略接管，不应用 Plan 的一次续跑限制。

### 2.4 浏览器能力

分两层实现。

第一阶段：内置隔离浏览器。

- 使用 Electron `WebContentsView`，不启用 `<webview>`。
- 单独 session partition，默认非持久化。
- `sandbox: true`、`nodeIntegration: false`，无 preload bridge。
- 使用 `webContents.debugger` 对指定 browser view 走 CDP，不开放全局 remote debugging port。
- 支持本地开发服务、公开网页、截图、Accessibility/DOM snapshot、点击、输入、控制台与网络错误。
- 不支持用户 Chrome cookie、扩展、已登录状态。

第二阶段：Chrome/Edge 扩展。

- 通过浏览器扩展 + Native Messaging Host 获取用户浏览器上下文。
- 每个 host 单独审批，支持会话允许、永久允许、拒绝。
- 不提供 cookie、password、localStorage 的直接读取工具。
- 不通过 Playwright 或远程调试端口直接接管用户默认 profile。

浏览器工具输出一律视为不可信上下文。跨站导航、表单提交、下载、会产生外部副作用的点击必须经过权限管线。

## 3. 阶段路线图

### R0 · 稳定性与问题收口

目标：先修复当前影响使用的 UI 和状态问题。

- 修复工具调用 block 导致自动滚动不到底。
- 工具卡折叠态改成单行摘要，参数和结果延迟到展开后渲染。
- 验证删除工作区功能 UI 与行为。
- 验证 `write_file` 只创建新文件的行为已经满足需求。
- 梳理当前已完成项，避免重复开发。

验收：

- 添加自动滚动和工具卡回归测试。
- 手工验证长工具结果、折叠/展开、对话切换、新建对话。

### R1 · 模块拆分

目标：降低后续功能进入成本。

- `electron/main.ts` 拆成 app bootstrap、window、安全策略、service assembly、IPC handlers。
- `electron/agent/session-manager.ts` 拆成 session facade、run loop、provider turn、tool runner、approval coordinator、context builder。
- `src/stores/agent.ts` 拆成 workbench、conversation、runtime、approval、provider-config、artifacts stores。
- `electron/agent/file-tools.ts` 拆成 schemas、mutation planner、precondition、atomic writer、diff。

约束：

- 机械迁移和行为变更分开提交。
- 每次拆分后必须通过 lint、typecheck、unit tests。

### R2 · 主进程工作台与配置 v2

目标：为分支、统计、导入导出和大历史做数据基础。

- 新增主进程 WorkbenchStore，管理 projects、conversations、messages、tools、orchestrator entries。
- 空对话改成 transient draft，第一次 run accepted 后才持久化。
- 配置 schema 升级，新增文件限制、审批超时、Prompt 资源版本、HTTP proxy。
- 引入 PromptRegistry。
- Provider 请求通过统一 HttpTransport，支持 off/system/manual proxy。

验收：

- 迁移旧 localStorage 历史。
- 对话切换、项目切换、文件树路径必须完全由当前 conversation/workspace 决定。
- 配置迁移有回归测试。

### R3 · Provider 与用量统计

目标：支持 OpenAI-compatible 多 Provider，并建立真实 usage ledger。

- 配置模型从固定 DeepSeek 改为 ProviderConfig 列表。
- 先实现通用 OpenAI-compatible Provider。
- DeepSeek 变成一个 Provider profile。
- 审批模型单独配置 provider/model。
- 标准化 `llm.usage` 事件，主模型、审批模型、标题模型、压缩模型都记录。
- UI 显示上次请求真实 prompt/context tokens、本轮与总 token、模型上下文上限来源。
- 增加文件变更行数标签，点击进入 Diff。
- 设置界面改成独立 settings view，不再使用大型 modal 承载全部配置。

说明：

- “当前输入即将消耗的 token”只能估算；真实值只能在 Provider 返回 usage 后显示。
- 模型最大上下文只有 Provider 明确返回时才算真实，否则标记为内置资料或用户覆盖。

### R4 · 上下文输入与命令系统

目标：实现 `@` 文件引用、`/` 命令、AGENTS 注入、压缩、Goal 和 Plan。

- `@path` 解析为结构化附件，由主进程重新校验和读取。
- Composer 增加 “+” 按钮添加文件、目录、图片等上下文。
- AGENTS.md 按层级发现、大小限制、hash 缓存，并以低于 system/user 的层级注入。
- Slash command registry：`/prompt`、`/skill`、`/compact`、`/goal`、`/plan`。
- `/skill` 显式加载 Skill 正文，跳过模型自行探索 Skill 的步骤。
- `/compact` 生成可追溯摘要，不静默删除历史。
- Goal/Plan 按本路线图 §2.2、§2.3 实现。

验收：

- 附件内容不直接渲染给用户，只显示 chip 和元数据。
- 续跑 Prompt 在对话中可见。
- Goal 可多轮自动续跑并显式完成。
- Plan 只自动续跑一次，失败后显式警告。

### R5 · 开发工具增强

目标：补齐代码代理常用工具。

- 打包 ripgrep，内置 grep 作为 fallback。
- `read_file` 输出带行号内容。
- Git 只读工具：`git_status`、`git_diff`、`git_log`、`git_show`。
- Git 写工具：`git_add`、`git_commit`、`git_restore`。
- Fetch/Search 工具初版。

Git 约束：

- 所有 git 命令禁用 pager。
- diff/show 禁用外部 diff。
- commit hooks 默认不静默运行；需要清晰风险策略。
- 写入 index、restore、commit 都进入权限管线。

Fetch/Search 约束：

- URL scheme、redirect、私网地址、响应大小、超时、MIME 都要校验。
- 搜索 API Key 存 safeStorage。
- 网络内容一律不可信。

### R6 · 会话图谱与回滚

目标：让用户可靠查看、导出、分支和回退历史。

- Markdown 导入/导出，使用带版本 front matter 的格式。
- 导入历史不伪造工具执行或 Provider continuation。
- Agent 自动起名：保留本地截断 fallback，可选后台标题模型。
- Conversation branch：复制历史到新 conversation，保留 parent/fork metadata。
- 回退对话：默认创建新分支，不直接破坏原历史。
- 回退文件：基于 change history 逆序恢复，必须通过 hash precondition。
- Diff/changes 视图支持按 run、文件、状态过滤。

### R7 · 浏览器、多模态与高级统计

目标：扩展到视觉验证、网页交互和长期用量分析。

- 内置隔离浏览器工具。
- 浏览器 Comments/Annotations。
- 生产可选 Chrome/Edge 扩展。
- 多模态 content parts：图片、截图、剪贴板、拖拽文件。
- token 热力图、模型用量折线图、缓存命中率趋势。
- 高级 trace/usage 查询。

## 4. 暂缓项

- Provider stream 未结束前提前执行工具。
- 直接控制用户 Chrome 默认 profile。
- 浏览器 Cookie、密码、Local Storage 读取工具。
- 云端同步和团队共享项目。
- 完整插件市场。

## 5. 阶段门禁

每一阶段至少通过：

- `npm run lint`
- `npm run format:check`
- `npm run typecheck`
- `npm test`

涉及 Electron UI、文件树、审批、终端、设置、浏览器的阶段还必须补充 E2E。真实 Provider 测试继续保持 opt-in，不能进入默认单测链路。
