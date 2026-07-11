# Road Map · Zch Coding Agent

本文件只记录尚未实现、仍需要排期和评审的产品方向。已经落地的实现细节进入 `architecture.md`、release notes 或 git history；不要在路线图正文里继续维护“当前实现”长段落。

当前基线：基础桌面 Agent、Prompt Harness v1、Harness/Plan/Goal M0 hardening、compact/goal/plan 编排、live interjection v1、M1 一写多读并发会话、ProjectModel vertical slice、Code Intelligence Facade v1、Serena MCP 只读 adapter v1、Generic MCP v1、工具紧凑 UI v1 已经落地。下一阶段重点是继续推进扩展、路由、可观测与评估能力。

## 0. 未完成概览

| 优先级 | 领域                           | 目标                                                     | 主要风险                              |
| ------ | ------------------------------ | -------------------------------------------------------- | ------------------------------------- |
| P1     | Project / Code Intelligence UX | 完整 module 编辑、backend routing、Serena 托管与诊断体验 | 项目元数据误改、后端不可诊断          |
| P1     | Provider Routing               | 会话级 provider/model 快照与用途路由                     | 全局 active provider 静默影响已有会话 |
| P2     | Benchmark Harness              | 用真实任务评估 harness、工具、上下文和权限策略           | 成本高、环境复杂、指标不可比较        |
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
- Benchmark trace 记录 facade 命中率、读文件 token、首次定位正确文件耗时和 fallback/unsupported 原因。
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

### 4.1 Session Provider Snapshot

- 会话创建时记录 provider/model/profile/capability snapshot。
- `SessionProviderTurnRunner` 按 session snapshot 选择主模型，不能继续直接使用全局 active provider。
- 修改全局默认 provider 只影响新会话或用户显式切换后的下一轮。
- `ConversationRecord` 保存 providerId、model、profile、模型能力摘要。

验收：

- 已存在对话不因全局默认 provider 变化而静默换模型。
- 两个对话可以使用不同 provider/model 并同时运行。
- trace 和 usage 显示准确 providerId/model/profile。

### 4.2 Role Binding

- 第一阶段支持 `main` 与 `approval` 两种 role。
- 后续支持 `planner`、`summarizer`、`code_review`。
- Provider fallback 必须显式配置；失败后是否切换必须进入 trace，不能静默换服务商。
- 不同 provider 的 tools/schema、reasoning、streaming、tool call 格式差异由 provider adapter 处理。

验收：

- approval 模型可与 main 模型不同。
- approval provider 失败时不绕过人工审批。
- fallback 触发可在 UI 和 trace 中解释。

### 4.3 Trace / Replay 增强

- trace 记录并发 run 的 conversationId、sessionId、runId、provider role、workspace writer ownership、prompt resource、prompt build。
- 支持从任一 `llm.request` fork/replay 当前 provider request。
- 增加 prompt cache 指标、usage 趋势、tool timing、compact 前后 token 变化。
- 后端、MCP、Serena、provider retry、approval model 的关键事件进入统一 trace。

验收：

- 能从 trace 判断一次失败是 provider、tool、审批、上下文、MCP 还是 UI 路由问题。
- replay 不执行工具副作用。
- 敏感信息扫描覆盖 trace、workbench、terminal output 和 artifacts。

## 5. M5 · Agent Benchmark Harness

目标：建立独立于 `npm test` / `npm run test:e2e` 的真实 coding-agent benchmark，用来评估 harness、并发、工具选择、审批、上下文管理、测试迭代、trace 和安全边界。

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

### 5.1 数据集

- 第一优先级接入 SWE-bench Pro：agent 只看到 `problem_statement`、仓库 `base_commit`、公开约束和 workspace。
- 不允许 agent 看到 gold patch、`test_patch`、`fail_to_pass` 或 `pass_to_pass`。
- 后续接入 SWE-EVO / SWE-Chain 类软件演进任务。
- SWE-Marathon 只用于少量高成本 full/nightly 任务。
- 自建 `harness-stress` 覆盖外部 benchmark 不关心的产品语义：审批、并发 run、运行中插话、workspace writer 冲突、trace/key 泄漏、终端长输出、中断与恢复。

### 5.2 执行

- 新增 `npm run benchmark:smoke`、`npm run benchmark`、`npm run benchmark:full`，全部 opt-in。
- runner 准备临时 workspace、启动 Electron、通过 Playwright 真实前端发送任务、审批、插话、等待 run 完成。
- 收集 patch、trace、截图、workbench、日志、usage、tool metrics。
- API key 只通过主进程环境变量或 safe storage 注入，benchmark 后扫描泄漏。

### 5.3 评分

- 官方数据集用官方 evaluator。
- 自建 case 必须有隐藏 evaluator 和 oracle patch 自检。
- 硬门禁：run 未崩溃/超时、patch 可应用、evaluator 通过、无 workspace 外写入、无密钥泄漏、权限未绕过。
- 通过硬门禁后计算功能正确性、harness 覆盖度、安全边界、迭代效率、UI/trace 完整性。

验收：

- `benchmark:smoke` 能跑一个小规模真实任务并产出完整 artifacts。
- `benchmark` 至少覆盖 10 个中等复杂任务。
- `benchmark:full` 至少包含 1 个长程任务。
- 结果可用于比较 Prompt Harness、Code Intelligence、Provider Routing、Concurrent Sessions 和 MCP 改动。

## 6. Later

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

每个实现阶段至少通过：

- `npm run lint`
- `npm run format:check`
- `npm run typecheck`
- `npm test`

涉及 Electron UI、文件树、审批、终端、设置、浏览器、MCP 进程生命周期、并发 run 或 provider routing 的阶段，还必须补充对应 E2E 或集成测试。

真实 Provider、外部 Serena/LSP、外部 MCP server 和 benchmark 测试继续保持 opt-in，不能进入默认单测链路。
