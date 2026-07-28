# Road Map · Zch Coding Agent

本文件只记录尚未实现、仍需要排期和评审的产品方向。已经落地的实现细节和已经确认的目标架构进入 `architecture.md`，并由文档状态明确区分；release notes 或 git history 保存版本事实。不要在路线图正文里继续维护“当前实现”长段落。

Backend Architecture v2.1 的详细实施顺序、切流点和删除门禁见 [`backend-refactor-plan.md`](./backend-refactor-plan.md)。

通用只读子 Agent、模型池与 Swarm Tool 的已确认产品语义和分阶段计划见 [`subagent-swarm-roadmap.md`](./subagent-swarm-roadmap.md)。

当前基线：基础桌面 Agent、Backend Architecture v2.1 P0–P12、Durable SQLite 单一真相源、Project/Session renderer replica、用户消息 retry/edit/rewind、Prompt Harness v1、compact/goal/plan 编排、live interjection v1、一写多读并发会话、NMessage 操作通知、segmented trace capture、单一 `npm run verify` 发布门禁、ProjectModel vertical slice、Code Intelligence Facade v1、Serena MCP 只读 adapter v1、Generic MCP v1、单一 Node Agent Runtime 边界、固定 Yolo Headless API/CLI、Electron/Headless parity、扁平 ModelProvider、Generic Responses/Anthropic 与完整 Session transcript 查看/导出已经落地。下一阶段优先推进 Subagent/Swarm，再按需求增加 Google 和具体厂商 Provider；P3 review 建议、N-3/N-4 与 201+ Electron E2E 按主题分块讨论和实现。

原内置评估系统已于 2026-07-27 从产品代码移除，完整快照保留在 `archive/integrated-benchmark` 分支。如未来重启评估，应放在独立仓库，仅通过稳定 Headless CLI/API 对本体做黑盒调用。

## 0. 未完成概览

| 优先级 | 领域                           | 目标                                                     | 主要风险                              |
| ------ | ------------------------------ | -------------------------------------------------------- | ------------------------------------- |
| P2     | Project / Code Intelligence UX | 完整 module 编辑、backend routing、Serena 托管与诊断体验 | 项目元数据误改、后端不可诊断          |
| P2     | Provider Routing               | Session selection、Active Run route 与用途路由           | 全局 active provider 静默影响已有会话 |
| P2     | Subagent / Swarm               | 通用只读子 Agent、模型池和 `/swarm` 批量委派 Tool        | 递归调用、费用失控、并发与上下文膨胀  |
| P3     | Later Expansion                | 插件加载器、浏览器、多模态、高级统计                     | 基础并发与扩展边界未稳时过早扩张      |

## 3. M3 · Project And Code Intelligence UX

目标：把已落地的 ProjectModel、Code Intelligence Facade 和 Serena v1 从“可用 vertical slice”推进到可配置、可诊断、可维护。

### 3.1 ProjectModel 编辑器

- Project tab 支持完整手动编辑：module root、languages、sourceRoots、testRoots、excludedRoots、default module、来源说明。
- module metadata 更新写入 trace/change history 摘要，便于审计和回滚。
- `.zch/` 继续只提示是否加入 `.gitignore`，不自动修改；可增加复制建议或打开 `.gitignore`。
- 评估接入受维护 project detector，避免核心长期膨胀语言规则。

验收：

- UI 可创建、编辑、删除 module，并保持 schema 校验。
- agent 工具和 UI 编辑不会互相覆盖未保存更改。
- 多 module 路径归属错误返回明确提示。

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

## 6. Later

- Durable Session Markdown import/export：重新定义基于 canonical Message/attachment/reference 的格式、冲突策略、可见性与 compact 语义；完成前 UI 按钮保持禁用，Trace transcript export 不受影响。
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

每个实现阶段完成时运行唯一完整门禁 `npm run verify`；开发中可以按失败领域运行单项命令，但不要在完整门禁后重复执行已包含的底层检查。

涉及 Electron UI、文件树、审批、终端、设置、浏览器、MCP 进程生命周期、并发 run 或 provider routing 的阶段，还必须补充对应 E2E 或集成测试。

真实 Provider、外部 Serena/LSP 和外部 MCP server 继续保持显式 opt-in，不能进入 `npm run verify`。
