# Road Map · Zch Coding Agent

本文件只记录尚未实现、仍需要排期和评审的产品方向。已经落地的实现细节和已经确认的目标架构进入 `architecture.md`，并由文档状态明确区分；release notes 或 git history 保存版本事实。不要在路线图正文里继续维护“当前实现”长段落。

Backend Architecture v2.1 的详细实施顺序、切流点和删除门禁见 [`backend-refactor-plan.md`](./backend-refactor-plan.md)。

通用只读子 Agent、模型池、Desktop Swarm 与后续 hardening 计划见 [`subagent-swarm-roadmap.md`](./subagent-swarm-roadmap.md)。

当前基线：基础桌面 Agent、Backend Architecture v2.1 P0–P13、Durable SQLite 单一真相源、Project/Session renderer replica、用户消息 retry/edit/rewind、Prompt Harness v1、Provider-anchored compact 与跨 route 字面历史迁移、`zch-conversation-markdown` 单向导出、goal/plan 编排、live interjection v1、一写多读并发会话、NMessage 操作通知、segmented trace capture、`check` 日常门禁与 `verify` 合并/发布门禁、Generic MCP v1、单一 Node Agent Runtime 边界、固定 Yolo Headless API/CLI、Electron/Headless parity、扁平 ModelProvider、Generic Responses/Anthropic、只读 `subagent_run`、Model Pool、Run-scoped Desktop Swarm、两级 Agents 状态视图与完整 Trace transcript 查看/导出已经落地。旧 ProjectModel/Code Intelligence/Serena vertical slice 已临时从生产入口关闭且不再读写 `.zch`；下一阶段先完成 Swarm hardening，再迁移 ProjectModel 到 SQLite 并恢复代码智能。

原内置评估系统已于 2026-07-27 从产品代码移除，完整快照保留在 `archive/integrated-benchmark` 分支。如未来重启评估，应放在独立仓库，仅通过稳定 Headless CLI/API 对本体做黑盒调用。

## 0. 未完成概览

| 优先级 | 领域                           | 目标                                                  | 主要风险                              |
| ------ | ------------------------------ | ----------------------------------------------------- | ------------------------------------- |
| P2     | Provider Routing               | Session selection、Active Run route 与用途路由        | 全局 active provider 静默影响已有会话 |
| P2     | Swarm Hardening                | 取消体验、压力测试、诊断与成本汇总                    | 费用失控、取消竞态与上下文膨胀        |
| P3     | Project / Code Intelligence UX | SQLite ProjectModel 迁移后恢复 routing、Serena 与诊断 | 项目元数据误改、后端不可诊断          |
| P3     | Terminal / Command Environment | Windows Shell 自动发现及终端、命令解释器独立配置      | Shell 参数差异、路径漂移与回退语义    |
| P3     | Later Expansion                | 插件加载器、浏览器、多模态、高级统计                  | 基础并发与扩展边界未稳时过早扩张      |

## 3. M3 · Project And Code Intelligence UX

依赖：只在 Desktop Swarm hardening 完成后启动。本阶段先把已暂停的 ProjectModel 从 workspace `.zch` 迁入 SQLite，再恢复 Code Intelligence Facade 和 Serena；迁移完成前 UI、Tool、IPC 可用路径和 backend process 都保持关闭。

### 3.1 ProjectModel SQLite 迁移与编辑器

- 以稳定 `projectId` 在 `userData/agent.db` 中持久化 versioned ProjectModel，由 Backend transaction 和 revision 控制更新。
- 旧 `.zch/project-model.json` 只允许用户显式、一次性、有界导入；成功后不删除、不改写、不续写源文件，也不自动修改 `.gitignore`。
- Project tab 支持完整手动编辑：module root、languages、sourceRoots、testRoots、excludedRoots、default module、来源说明。
- module metadata 更新写入 trace/change history 摘要，便于审计和回滚。
- 评估接入受维护 project detector，避免核心长期膨胀语言规则。

验收：

- UI 可创建、编辑、删除 module，并保持 schema 校验。
- agent 工具和 UI 编辑不会互相覆盖未保存更改。
- 多 module 路径归属错误返回明确提示。
- 新项目与正常 Session 永不创建 `.zch`；损坏或冲突的 legacy 导入不产生部分 SQLite 写入且原文件不变。

### 3.2 Backend Routing UI

- Project tab 增加按 module/language 的 backend 选择和 capability 展示。
- 不再只有全局 Serena 开关。
- 后端状态展示 ready/stopped/error、pid、capabilities、last error、stderr tail。
- 后端 startup/restart/stop 写入持久 trace event。

验收：

- 同一 workspace 中前端 TS 和后端 Java 可配置不同 backend。
- 后端不可用时 facade 返回明确降级原因。
- trace 能定位 PATH、spawn、startup timeout、tool list 缺失等问题。

### 3.3 Code Intelligence Facade 增强

- 设计目录级 overview/diagnostics 的有界能力。
- diagnostics 支持缓存、过期标记和 UI 展示。
- Trace 记录 facade 命中率、读文件 token、首次定位正确文件耗时和 fallback/unsupported 原因。
- 后续 IDE 级编辑能力单独设计：rename、replace body、update definition、refactor preview、diagnostics refresh。
- 所有写入类 IDE 能力必须进入现有 diff、审批、change history 和 trace 管线。

验收：

- 大目录不会一次性塞入后端或上下文。
- diagnostics UI 能显示来源、时间和 stale 状态。
- IDE 写入能力不能绕过文件工具保护。

### 3.4 Serena Managed

- 实现 Serena 托管安装 resolver：优先 managed Serena，其次 custom command。
- 提供安装、修复、版本、license notice、sha256 校验。
- 明确不把 Serena `initial_instructions` / onboarding prompt 混入本应用 Prompt Harness。
- Serena memory 写入后续如支持，必须单独审批并在 UI 可见。

验收：

- 新机器不依赖用户手动配置 PATH 即可安装或修复 Serena。
- managed/custom 两种模式状态清晰。
- Serena prompt/onboarding 不进入系统 prompt 或 base instructions。

## 4. M4 · Provider Routing And Observability

目标：让 provider/model 从全局设置变成可审计的会话级和用途级选择，同时增强 trace/replay 对 prompt、工具和并发运行的解释能力。

### 4.1 Session Selection 与 Active Run Route Snapshot

- Session 持久化当前 provider/model/reasoning selection；renderer 下拉框必须通过 backend command 更新它，不能只修改本地 form。
- 每个 Active Run 启动时从 Session selection 解析不可变 `ModelRouteSnapshot`，至少冻结 `providerType/providerId/model/reasoning/config revision`；它保存在 backend memory，完成的 assistant message 记录实际 route。Provider turn 不能直接使用全局 active provider。
- 修改全局默认 provider 只影响新 Session，或用户显式恢复默认后的后续 Run。
- 不再使用独立 `ConversationRecord` 或持久化 Run 保存模型状态；Session selection、active route 和 Message metadata 使用 `shared/` canonical schema。

验收：

- 已存在 Session 不因全局默认 provider 变化而静默换模型。
- 两个对话可以使用不同 provider/model 并同时运行。
- trace 和 usage 显示准确 providerType/providerId/model/reasoning。

### 4.2 Provider Purpose Binding

- 第一阶段支持 `main` 与 `approval` 两种 purpose；这里的 purpose 表示模型用途，不是 Provider wire role。
- 后续支持 `planner`、`summarizer`、`code_review`。
- Provider fallback 必须显式配置；失败后是否切换必须进入 trace，不能静默换服务商。
- 不同 API 的 tools/schema、reasoning、streaming、tool call 格式差异由具体 `ModelProvider` 处理。Provider 消费完整 `CompiledCanonicalHistory`、生成目标 wire DTO 并解码 canonical completion，Core 不维护 Chat-Completions-shaped `ProviderMessage`。

验收：

- approval 模型可与 main 模型不同。
- approval provider 失败时不绕过人工审批。
- fallback 触发可在 UI 和 trace 中解释。

### 4.3 Trace / Replay 增强

- trace 记录并发 Run 的 sessionId、runId、provider purpose、providerType、workspace writer ownership、prompt resource、prompt build 和不可变 route snapshot。
- 保留离线 replay、Prompt Inspector、导出和统计；不提供 trace fork 或在线重放 provider request。
- 增加 prompt cache 指标、usage 趋势、tool timing、compact 前后 token 变化。
- 后端、MCP、Serena、provider retry、approval model 的关键事件进入统一 trace。

验收：

- 能从 trace 判断一次失败是 provider、tool、审批、上下文、MCP 还是 UI 路由问题。
- replay 不执行工具副作用。
- 敏感信息扫描覆盖需要自动分享或判定安全门禁的artifacts；用户明确导出的本地restricted session transcript只做逐次风险警告，不扫描或脱敏。

## 5. M5 · Configurable Terminal And Command Environment

目标：在不改变直接进程执行和内部 Git 命令语义的前提下，自动发现 Windows 上可用的 Shell，并允许用户分别选择交互终端与命令字符串解释器。

状态：第一阶段已完成 `run_command.shell` 的内置 profile 发现、选择、失效回退、Prompt 注入、显式解释器启动与 UTF-8/fallback 解码；`run_command` 仍是一次性 Tool，不在前端 Terminal 展示。以下交互 Terminal 复用、自定义 profile、版本探测、WSL 与完整打包 E2E 仍待实现。

- Main process 已有界扫描 `pwsh.exe`、`powershell.exe`、`cmd.exe`、Git Bash 和 Nushell；后续增加 WSL adapter、版本展示以及经过校验的自定义可执行文件和启动参数。
- 分别持久化交互式 terminal profile 与 `run_command.shell` profile。已配置程序消失时显示可诊断警告并回退到安全默认值，不静默改写用户配置。
- `run_command.process` 已继续以 `shell: false` 直接执行，`run_command.shell` 已显式启动所选解释器及其固定参数，不再依赖 Node 在 Windows 上隐式选择 `%COMSPEC%`；后续让 `terminal_open` 通过独立的所选 profile 启动可见 PTY。
- WSL 使用独立 adapter 处理发行版、工作目录映射和参数边界，不把它伪装成普通 Windows 可执行 Shell。
- Prompt Harness 已报告实际 command shell；后续再独立报告 terminal shell。Subagent、Git/File 工具和其他内部能力继续使用各自既定执行路径，不受用户 Shell 选择影响。

验收：

- 未安装 PowerShell 7、仅有 Windows PowerShell/CMD、安装 Git Bash/Nushell 及配置失效等环境都有确定性发现与回退测试。
- 同一工作区可以用 PowerShell 交互终端和 Git Bash 命令解释器；切换 profile 不影响 `run_command.process` 或内部 Git 命令。
- quoting、空格路径、Unicode、取消、超时和进程树终止在各受支持 profile 下有集成覆盖；打包后的 Windows 应用至少覆盖一次发现、保存、重启恢复和实际执行 E2E。

## 6. Later

- Durable Session Markdown import：定义从 `zch-conversation-markdown` 新建 Session 时的 attachment/reference 恢复、冲突策略与可信边界；当前导出文件只用于阅读和模型 route 迁移，不能导入或重放。Trace transcript export 继续保持独立。
- 外部 JS 插件加载器：签名、来源、隔离、权限声明、工具注册。
- 内置隔离浏览器工具。
- 浏览器 Comments/Annotations。
- 生产可选 Chrome/Edge 扩展。
- 多模态 content parts：图片、截图、剪贴板、拖拽文件。
- token 热力图、模型用量折线图、缓存命中率趋势。
- 高级 trace/usage 查询。
- Provider stream 未结束前提前执行工具。
- 直接控制用户 Chrome 默认 profile。
- 浏览器 Cookie、密码、Local Storage 读取工具。
- 云端同步和团队共享项目。
- 完整插件市场。

## 7. 阶段门禁

每个实现阶段完成时运行日常门禁 `npm run check`；准备合并或发布时运行完整门禁 `npm run verify`。定位失败时可以运行对应底层命令，但不要在所选门禁通过后重复执行其已包含的检查。

涉及 Electron UI、文件树、审批、终端、设置、浏览器、MCP 进程生命周期、并发 run 或 provider routing 的阶段，还必须补充对应 E2E 或集成测试。

真实 Provider、外部 Serena/LSP 和外部 MCP server 继续保持显式 opt-in，不能进入 `npm run verify`。
