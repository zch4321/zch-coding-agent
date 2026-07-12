# Road Map · Zch Coding Agent

本文件只记录尚未实现、仍需要排期和评审的产品方向。已经落地的实现细节进入 `architecture.md`、release notes 或 git history；不要在路线图正文里继续维护“当前实现”长段落。

当前基线：基础桌面 Agent、Prompt Harness v1、Harness/Plan/Goal M0 hardening、compact/goal/plan 编排、live interjection v1、M1 一写多读并发会话、ProjectModel vertical slice、Code Intelligence Facade v1、Serena MCP 只读 adapter v1、Generic MCP v1、单一 Node Agent Runtime 边界、固定 Yolo Headless API/CLI、Electron/Headless parity 与 runtime identity、Linux Docker worker、BenchmarkCase v1/native adapter/3 项 core smoke、strict/repair-once runner、隔离 grader、硬门禁和 L0–L5 评分，以及 trace/tool/usage/cost/paired comparison 已经落地。下一阶段继续推进正式 benchmark 命令面，再用真实任务信号指导 Project / Code Intelligence 和 Provider Routing 的后续改动。

## 0. 未完成概览

| 优先级 | 领域                           | 目标                                                     | 主要风险                              |
| ------ | ------------------------------ | -------------------------------------------------------- | ------------------------------------- |
| P1     | Benchmark Harness              | 用同一 Agent Runtime 在 Linux Docker 评估真实任务        | 双实现漂移、环境复杂、grader 信号失真 |
| P2     | Project / Code Intelligence UX | 完整 module 编辑、backend routing、Serena 托管与诊断体验 | 项目元数据误改、后端不可诊断          |
| P2     | Provider Routing               | 会话级 provider/model 快照与用途路由                     | 全局 active provider 静默影响已有会话 |
| P3     | Later Expansion                | 插件加载器、浏览器、多模态、高级统计                     | 基础并发与扩展边界未稳时过早扩张      |

## 5. M5 · Headless Agent Runtime And Benchmark Harness

目标：先建立独立于 renderer、IPC、`npm test` 和 `npm run test:e2e` 的真实 coding-agent benchmark。Electron 与 Headless 必须调用同一份 Agent Runtime；Linux Docker 只替换宿主交互和部署方式，不得复制 Prompt Harness、工具注册、Provider loop、权限、compact、Skills、MCP 或 trace 实现。

M5 保留原编号以维持已有文档和历史引用，但从本阶段起提前为首要里程碑。它首先评估 harness 工程本身，不把 Electron UI 性能混入 coding correctness；UI/IPC 继续由 E2E 覆盖，并通过 parity 测试证明两个宿主没有语义漂移。

### 5.9 命令、Artifacts 与运行档位

- 新增 `npm run benchmark:smoke`、`npm run benchmark`、`npm run benchmark:full`，全部 opt-in，不进入默认 `npm test`、build 或 E2E。
- `benchmark:smoke` 默认 3 个自建 case、每项 1 trial，用于验证完整链路。
- `benchmark` 默认 12 个 `core-24` case、每项 3 trials，用于日常 harness A/B。
- `benchmark:full` 默认完整 `core-24`、每项最多 5 trials，并按显式参数加入 `fresh-12` 或高成本外部 suite。
- artifacts 以 run-group/case/trial/attempt 分层，保存 manifest snapshot、identity、config、task、patch、grader report、trace、JSONL、stderr tail、usage、tool metrics、泄漏扫描和汇总报告。
- 原始敏感 artifacts 只保存在本地受限目录；可分享报告先经过 redaction，并标明删除或聚合了哪些字段。

建议目录：

```text
benchmarks/
├─ README.md
├─ manifests/
│  ├─ core-24/
│  └─ fresh-12/
├─ adapters/
│  ├─ native.ts
│  ├─ swe-rebench.ts
│  ├─ swe-bench.ts
│  └─ swe-lancer.ts
├─ runner/
│  ├─ coordinator.ts
│  ├─ prepare-case.ts
│  ├─ run-headless.ts
│  ├─ grade.ts
│  ├─ feedback.ts
│  ├─ scoring.ts
│  ├─ artifacts.ts
│  └─ redaction.ts
├─ docker/
│  ├─ headless.Dockerfile
│  └─ fixtures/
└─ results/
```

验收：

- `benchmark:smoke` 能从空缓存完成 prepare → Agent → patch → hidden grader → report → cleanup。
- artifacts 足以离线复核等级、成本、工具轨迹和失败类别，但不泄漏真实密钥。
- 汇总报告能同时展示 strict、repair-once 和独立多 trial，标签不会混淆。
- 默认测试链路在没有 Docker、外部 dataset 或真实 Provider key 时仍保持确定性通过。

后续数据集扩展：

- 把已冻结的 3 项 bootstrap case 扩展为人工编写的 `core-24`：6 个 bug fix、6 个 feature、3 个 refactor/compatibility、3 个正确 abstain/no-change、6 个 harness-stress。普通 case 要求失败 baseline，abstain case 要求通过 baseline 与 no-change oracle；新增每项还需至少两个 mutant、三次无 flaky 和独立 prompt/test 对齐复核。
- 自建 case 优先 `FROM zch-agent-headless:<commit>` 安装任务依赖；Agent 可见 image 不含 private spec。Evaluator 使用另一容器，从 pristine base 应用 patch 后运行 hidden tests，且无 Provider credential、默认 `network=none`。
- 第一外部套件为 `fresh-12`：从最新 SWE-rebench 时间窗选取 12 项，人工审核并冻结 revision。SWE-bench Pro/Verified 只作为 compatibility adapter；SWE-bench-Live、SWE-Lancer 和长期演进任务留给 `benchmark:full`。
- 外部 adapter 只归一化公开 BenchmarkCase；gold/test patch、`fail_to_pass`、`pass_to_pass` 和 evaluator 私有字段始终停留在 grader 面。许可证、镜像来源、digest 和运行限制必须记录。

### 5.10 按提交粒度的实施顺序

| 步骤  | 具体实现                                           | 完成标志                        |
| ----- | -------------------------------------------------- | ------------------------------- |
| M5.9  | 接入 smoke/日常/full 命令和分层 artifacts          | 完整 vertical slice 通过        |
| M5.10 | 扩展到 12/24 个 core case                          | `benchmark` 可产出稳定 A/B 报告 |
| M5.11 | 接 SWE-rebench `fresh-12` 和外部镜像兼容检查       | Linux worker 跑通冻结 revision  |
| M5.12 | 增加 SWE-bench compatibility 与高成本 full adapter | 不影响主套件且保持 opt-in       |

单一 Runtime、固定 Yolo Headless host、runtime identity、Electron/Headless parity、受限 Linux Docker worker、3 项冻结 native smoke case、strict/repair-once runner、隔离 grader、L0–L5评分和可比较指标已经落地；M5.9 完成后补齐正式命令面，不必等待全部 24 个 case 才开始为 M3/M4 提供 A/B 信号。

总体验收：

- Headless 和 Electron 共用唯一 Agent Runtime，没有 Prompt、tool 或 loop 副本。
- Linux Docker 中可用真实 Provider 在固定 Yolo、无人审批模式完成任务，并由隔离 grader 评分。
- `benchmark:smoke`、`benchmark` 和 `benchmark:full` 具备明确成本与运行边界。
- 结果可比较 Prompt Harness、Code Intelligence、Provider Routing、Concurrent Sessions、Skills 和 MCP 改动。
- 任何结果都可追溯、可重放、可解释，并通过 workspace、权限、credential 和 artifact 安全检查。

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
