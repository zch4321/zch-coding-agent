# Road Map · Zch Coding Agent

本文件只记录尚未实现、仍需要排期和评审的产品方向。已经落地的实现细节进入 `architecture.md`、release notes 或 git history；不要在路线图正文里继续维护“当前实现”长段落。

当前基线：基础桌面 Agent、Prompt Harness v1、Harness/Plan/Goal M0 hardening、compact/goal/plan 编排、live interjection v1、M1 一写多读并发会话、ProjectModel vertical slice、Code Intelligence Facade v1、Serena MCP 只读 adapter v1、Generic MCP v1、单一 Node Agent Runtime 边界、工具紧凑 UI v1 已经落地。下一阶段继续推进 M5 Headless CLI 和真实任务评估基线，再用它指导 Project / Code Intelligence 和 Provider Routing 的后续改动。

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

### 5.2 Headless API 与固定 Yolo CLI

- 新增内部二进制 `zch-agent-headless`，v1 只支持 `run` 子命令和固定 `mode: yolo`；不提供 Confirm/Auto，也不出现人工工具审批等待态。
- CLI 接受受信任的 harness config、独立 task 文件、workspace、artifact 目录和预算。task 内容不能覆盖 Provider、工具、MCP、Skills、网络或输出限制。
- stdout 只输出有版本的 JSONL 事件；诊断写 stderr；最终结果写原子 JSON。退出码区分正常结束、Agent/Provider 失败、超时、配置错误和外部中断，但退出码不代表 hidden grader 通过。
- CLI 输出并保存 session/run id、最终回复、patch 路径、trace 路径、usage、工具统计、终态与未完成原因。SIGINT/SIGTERM 必须进入现有 abort/disposer 管线。
- Yolo 只跳过工具和 MCP 权限审批。另设 `AutonomousInteractionDriver` 处理人类交互语义：Plan 进入 `awaiting_review` 时，在当前 run settle 后自动批准一次并追加带标签的 harness 消息；Goal blocked 或需求澄清不得捏造用户答案，标记为 `needs_human_input`。
- 自动消息使用版本化 prompt resource，例如 `<autonomous_plan_approval>`，按 append-only 规则进入历史和 trace，并记录 `harness.auto_action`，不能伪装成用户原创消息。
- Headless 不新增 benchmark 专用工具，不删减桌面 Agent 可见工具。若平台不支持某工具，case 必须在准备阶段失败为 unsupported，而不是运行中静默换实现。

建议命令：

```text
zch-agent-headless run
  --workspace /workspace
  --task-file /run/task.md
  --config /run/harness.json
  --artifacts /artifacts
  --timeout-ms 1800000
```

验收：

- CLI 能在纯 Node Linux 环境完成 smoke task，并持续输出可校验 JSONL。
- CLI 参数、task、stdout、stderr、trace 和 patch 都不包含真实 Provider key。
- 自动 Plan 审批最多触发配置上限次数，且 token、工具和 wall time 继续累计到同一 trial。
- 正常结束但功能未通过时 CLI 仍返回 Agent 完成状态，由 grader 另行给出 correctness。

### 5.3 Electron / Headless Parity

- 建立共享 fake provider trajectory，分别通过 Electron IPC host 与 Headless API 运行。
- 规范化随机 ID、时间戳、平台绝对路径和 UI-only 事件后，比较 Provider messages、prompt layer hashes、`toolsHash`、工具参数与结果、compact、Goal/Plan continuation、MCP 披露状态和最终 patch。
- parity fixture 覆盖只读、写入、命令、一次 compact、一次 Plan 自动/人工恢复和一个通用 MCP call；不要求两个宿主拥有相同 UI 事件。
- 每次构建在 artifact 中写入 source commit、runtime image digest、prompt resource hashes、tools hash、config hash、provider/model/profile 和 capability snapshot。
- CI 禁止 Electron 和 Headless 从不同入口自行装配 runtime；parity 差异必须显式更新 fixture 原因，不能使用宽泛 snapshot 覆盖。

验收：

- 同一 harness revision 下，除声明的 host interaction 外，两个入口产生相同 Provider 请求和工具语义。
- 修改 Prompt、tools、compact、Skills 或 MCP 后，桌面和 Headless parity 同时变化；不存在仅更新 benchmark 副本的路径。
- benchmark 报告能拒绝比较 source commit、case digest、模型配置或核心预算不一致的 run group。

### 5.4 Linux Docker Worker

- 构建与桌面端来自同一 source commit 的 `zch-agent-headless:<commit>` OCI image。v1 明确支持 Linux x64、Node LTS 和 glibc 基础镜像；musl、其他架构或 native addon ABI 不匹配返回 unsupported。
- 自建 case 优先 `FROM zch-agent-headless:<commit>` 安装任务依赖；外部 benchmark 后续支持从固定 case image digest 注入同一 headless bundle。
- Agent container 包含 runtime、workspace、编译器和公开测试，不包含 gold patch、test patch、hidden grader、`fail_to_pass` 或 `pass_to_pass` 元数据。
- Evaluator 使用另一容器，从 pristine base 应用 agent patch 后运行 hidden tests；grader 无 Provider credential，默认 `network=none`。
- Agent container 使用非 root 用户、`--cap-drop=ALL`、默认 seccomp、PID/CPU/内存/磁盘/wall-time 限制、临时 volume；禁止 Docker socket、宿主 home、宿主 git credential 和任意宿主目录挂载。
- Provider key 保留在 coordinator。推荐通过限额、单 trial、可撤销 token 的本地 Provider proxy 访问真实 API；Agent container 网络只允许该 proxy。直接环境密钥仅作为受控开发 fallback，仍必须通过现有子进程环境 allowlist。
- coordinator 在超时、取消和异常退出时按顺序终止 Agent、等待有限清理、强制 kill、收集诊断并销毁 container/volume，不能留下后台进程。

验收：

- Agent 只能修改临时 workspace；容器内越界破坏不能影响宿主或 grader。
- Agent 无法读取 hidden tests、gold patch、真实 Provider key 或 Docker daemon。
- 同一 image digest 和 case revision 连续准备三次，baseline 与 oracle evaluator 结果一致。
- container 被强制终止后没有残留进程、网络、volume writer 或泄漏的 credential token。

### 5.5 Case Manifest 与数据集策略

- 定义版本化 `BenchmarkCase` schema，至少包含 case id、suite、task、repository source/revision/archive hash、platform、case image digest、setup、公开检查、grader、验收行为组、feedback policy、修改范围和资源预算。
- dataset adapter 只把外部格式归一化为 `BenchmarkCase`；gold/test patch 和 evaluator 私有字段停留在 coordinator/grader，绝不进入 renderer、Headless config、Agent trace 或 workspace。
- workspace 从固定 archive 创建，并移除可恢复未来提交的 git history、tag、remote、reflog 和缓存。保留任务需要的当前源码信息，但不能通过仓库历史直接找到答案。
- 第一主套件为人工编写的 `core-24`：6 个 bug fix、6 个 feature、3 个 refactor/compatibility、3 个正确 abstain/no-change、6 个 harness-stress。
- 第一外部套件为 `fresh-12`：从最新 SWE-rebench 时间窗选取 12 项，再人工审核 prompt/test 对齐并冻结 revision。SWE-bench Pro/Verified 只作为兼容 adapter，不作为 M5 主分数。
- SWE-bench-Live、SWE-Lancer、长期软件演进任务留给 `benchmark:full`；外部许可证、镜像来源、digest 和运行限制必须记录。
- 每个自建或人工筛选 case 必须通过：baseline 触发预期失败、oracle 全部通过、至少两个合理但错误的 mutant 被拒绝、无关回归保持通过、三次重复无 flaky、独立 prompt/test 对齐复核。

验收：

- manifest 在执行前经过 schema、checksum、路径和预算校验；失败时不创建 Agent run。
- Agent 可见 bundle 的自动扫描确认不存在 evaluator 私有字段和未来 git 历史。
- `core-24` 每项都有 acceptance group、baseline/oracle/mutant 证据和审核记录。
- 外部 adapter 更新不会静默改变已冻结 suite；新 revision 产生新的 suite identity。

### 5.6 Runner、严格首轮与一次修复

- runner 负责准备临时 workspace、启动 Headless container、发送 task、等待 run、收集 patch/trace/JSONL/stderr、调用 grader、扫描泄漏和清理资源。
- `strict` 是默认协议：Agent 结束后直接隐藏评判，不把 grader 反馈给 Agent；它产生主指标 `resolved_initial`。
- `repair-once` 是独立协议：首次失败后，在同一 workspace 和 session 追加一次 `<benchmark_feedback>`，允许一个有预算的修复阶段，再用干净 grader 重评。
- feedback 分为 `public` 和 `diagnostic`。`public` 只包含构建、lint 和公开测试摘要；`diagnostic` 可包含失败的验收组名和清理后的错误类别。两者都不能包含隐藏测试源码、精确隐藏期望值、oracle 路径或 gold diff。
- repair 不是 `pass@2`。报告分别保存 initial、after-feedback、recovery rate 以及第二阶段增量和累计成本；不得用修复成功回填首次通过率。
- `pass@k` 仅用于从 pristine workspace 开始的 k 个独立 trial；每个 trial 使用独立 session、container、credential token 和 artifact 目录。
- runner 支持安全 resume：只复用完整且 identity 匹配的 immutable artifact；不复用活跃 container、半写 trace、Provider continuation state 或 workspace。

验收：

- strict 模式下 Agent 永远看不到 evaluator 输出。
- repair-once 恰好最多追加一次反馈，历史保持 append-only，第二次 grader 使用最终 patch 和干净环境。
- 中途 kill runner 后重新执行，不会把半成品计为失败样本或覆盖已有完整 trial。
- 同一任务多 trial 之间没有 workspace、session、MCP disclosure、terminal 或 provider state 串扰。

### 5.7 分级评分与硬门禁

- 先区分 `invalid`、`unsupported`、`attempted` 和 `graded`。环境、镜像、grader 或 coordinator 故障记为 invalid/unsupported，不混入模型失败率。
- 硬门禁包括：run 未越权、patch 可应用、无 workspace 外写入、无密钥泄漏、权限未绕过、grader 未被修改、资源预算未被规避。违反后即使功能测试通过也不能 resolved。
- 完成级别固定为：L0 无有效改动；L1 patch 合法可应用；L2 build/type/static 通过；L3 原有回归通过；L4 部分 acceptance groups 通过；L5 所有关键功能组与回归门禁通过。
- partial correctness 按 manifest 中行为组做 macro-average，不直接按测试函数或断言数量平均。关键组必须全部通过才可 L5；grader 输出每组证据和失败类别。
- 外部官方数据集保留其官方 binary evaluator 为主结果；本地多级评分只作为诊断，不宣称替代官方 leaderboard 协议。
- LLM reviewer 只允许用于失败分类、可维护性注释或人工审核辅助，不能覆盖 deterministic grader，也不能单独决定 resolved。

验收：

- no-op、build-only、破坏回归、只完成部分行为和完整修复分别落入预期等级。
- 改变单个测试数量不会改变行为组权重。
- grader 自身错误能从 Agent 失败中分离，并保留可重放证据。
- 每个 resolved 结果都能追溯到 case revision、patch hash、grader digest 和逐组结果。

### 5.8 Trace、工具、Token、成本与比较

- 复用现有 run、`llm.usage`、`tool.call`、approval、prompt build 和 terminal trace。补充 validation/schema/permission 阶段就失败的 `tool.attempt`，避免只统计实际执行成功的工具。
- 每个 trial 汇总 main/approval/compression 等 scope 的 prompt、completion、reasoning、cache hit/miss token；Provider 未提供的指标保持 unknown，不能和估算值混算。
- 工具指标包括 proposed/executed/succeeded/failed/denied、按工具分类、duration、输入输出字节、截断、重复参数签名、首次有效编辑时间、首次测试时间和最终验证后的空转。
- patch 指标包括修改文件、增删行、测试改动、二进制改动和 workspace 外写入尝试。记录 LLM request 数、continuation、compact、Plan/Goal、MCP 披露与调用次数。
- 成本使用 run group 固定的 `priceSnapshot` 计算并保存来源版本。主要效率指标为 total tokens/cost/tool calls per resolved、median time to resolve，以及 unresolved 对预算的消耗。
- 排序和回归判断按安全门禁、正确性、效率的词典序进行。不能把工具少或 token 少直接加进 correctness，否则空操作会得到虚假高分。
- A/B 必须使用同一 case identity、runtime/case image、provider/model/profile、reasoning、预算和 trial index。输出逐任务 paired delta、总体 resolve delta 和置信区间，不只比较两个总百分比。

验收：

- 一个 schema 无效、一个被权限拒绝、一个执行失败和一个成功工具都被准确计数。
- Provider usage 缺失时报告 unknown，不从文本长度伪造“精确 token”。
- `cost_per_resolved` 使用全部 trial 总成本除以 resolved 数，失败成本不会消失。
- 比较器拒绝 identity 不匹配的 run group，并解释不匹配字段。

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

### 5.10 按提交粒度的实施顺序

| 步骤  | 具体实现                                                     | 完成标志                        |
| ----- | ------------------------------------------------------------ | ------------------------------- |
| M5.5  | 实现固定 Yolo CLI、JSONL、原子 result 和自动 Plan driver     | Linux 本机 headless smoke 通过  |
| M5.6  | 建 Electron/Headless parity fixture 与 identity 记录         | CI 可检测 prompt/tool/loop 漂移 |
| M5.7  | 构建受限 Linux OCI image、coordinator 和清理器               | 容器 smoke 无残留资源           |
| M5.8  | 实现 manifest loader、native adapter 和 3 个 core smoke case | baseline/oracle/mutant 自检通过 |
| M5.9  | 实现隔离 grader、L0-L5、硬门禁和 artifact/redaction          | 评分回归与泄漏测试通过          |
| M5.10 | 补 tool attempt、usage/cost/paired comparison                | 指标 golden tests 通过          |
| M5.11 | 实现 strict、repair-once、resume 和多 trial                  | append-only、隔离与恢复测试通过 |
| M5.12 | 扩展到 12/24 个 core case                                    | `benchmark` 可产出稳定 A/B 报告 |
| M5.13 | 接 SWE-rebench `fresh-12` 和外部镜像兼容检查                 | Linux worker 跑通冻结 revision  |
| M5.14 | 增加 SWE-bench compatibility 与高成本 full adapter           | 不影响主套件且保持 opt-in       |

单一 Runtime 已可用 fake provider 验证“同一 harness”；M5.5–M5.6 完成 Headless host 与 parity，M5.7–M5.11 构成第一个可用的 Docker benchmark vertical slice；不必等待全部 24 个 case 才开始为 M3/M4 提供 A/B 信号。

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
