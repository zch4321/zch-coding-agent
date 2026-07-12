# 架构设计文档 · Zch Coding Agent

> 状态：当前实现同步版 · 最后更新 2026-07-11
>
> 配套文档：[`requirements.md`](./requirements.md) 说明产品能力，`frontend-spec.md`](./frontend-spec.md) 说明前端信息架构。本文只记录当前代码实际架构和关键边界，不再保留早期设计稿内容或未实现方案。

---

## 1. 总览

Zch Coding Agent 是 Electron + Vue 3 桌面 coding agent。实现采用主进程编排、渲染进程展示、preload 白名单桥接的结构：

```text
Renderer (Vue + Pinia, sandboxed)
  └─ window.agentApi / AgentEvent / TerminalEvent

Preload
  └─ contextBridge 暴露冻结的 AgentApi，不暴露 ipcRenderer

Main process
  ├─ IPC handlers / sender validation / payload validation
  ├─ Electron Runtime Event adapter
  ├─ AgentRuntime composition root
  │   ├─ SessionManager and session collaborators
  │   ├─ LLM providers
  │   ├─ Tool registry, permission pipeline, terminal pool
  │   └─ prompt resources and prompt harness
  ├─ config, secrets, logging, workbench, skills
  └─ project metadata and code-intelligence backends
```

核心边界：

- `shared/` 只放跨进程类型、schema 和纯数据契约，不导入 Electron、Node.js 或 Vue。
- `electron/` 拥有主进程权限，负责 secrets、文件系统、进程、PTY、网络、LLM、工具执行和 IPC。
- `src/` 是 sandboxed renderer，只通过 `window.agentApi` 调用主进程，不直接访问 Node/Electron。
- `resources/prompts/` 是模型可见 prompt 资源，由 `PromptRegistry` 加载并带版本/hash 进入 trace。

---

## 2. 目录结构

当前主要目录：

```text
shared/
  agent-api.ts              # preload 暴露给 renderer 的 API 形状
  ipc-contract.ts           # IPC 请求/响应 runtime schema
  agent-events.ts           # AgentEvent 和 UI timeline 事件
  config.ts                 # PublicConfig、配置请求 schema
  project-model.ts          # ProjectModel / Code Intelligence contracts
  trace.ts                  # promptBuild / trace 辅助 schema
  workbench.ts              # 项目、会话、消息、工具活动持久化模型

electron/
  main.ts                   # app bootstrap、安全策略、依赖装配
  preload.ts                # 冻结 window.agentApi
  headless/                 # 固定 Yolo API/CLI、JSONL、result/patch 和自动 Plan driver
  ipc/                      # IPC 注册、sender/payload/result 校验
  runtime/                  # Node-only AgentRuntime 组装、事件总线和 Electron host adapter
  session/                  # SessionManager、run loop、prompt harness、compact/interjection/orchestration
  tools/                    # 内置工具定义和 ToolRegistry/ToolExecutor
  permission/               # policy engine、approval pipeline、auto approver
  providers/                # OpenAI-compatible provider adapter
  prompts/                  # PromptRegistry
  logging/                  # JSONL trace、replay、stats、cleanup
  config/                   # config store、secret store、migration、atomic write
  project/                  # .zch/project-model.json 存储和模块检测
  code-intelligence/        # CodeBackendManager、Serena MCP adapter
  terminal/                 # node-pty pool 和 bounded scrollback
  skills/                   # skill 扫描、安装、启用和 SSRF 边界
  net/                      # HTTP transport、proxy、SSRF guard
  workbench/                # main-process workbench persistence

src/
  App.vue
  components/               # chat、settings、artifacts、terminal 等 UI
  stores/
    agent.ts                # 兼容门面，转发到领域 store
    agent-runtime.ts        # session/run/AgentEvent runtime
    agent-workbench.ts      # projects/conversations persistence
    agent-timeline.ts       # messages/tools/context/plan/goal timeline
    agent-settings.ts       # providers、permissions、logging、skills settings
    agent-changes.ts        # change history/revert
    agent-shell.ts          # bridge/bootstrap state
```

---

## 3. 应用启动与 IPC

`electron/main.ts` 负责：

- 注册自定义 app scheme，开发环境使用 Vite dev server，生产环境从 `dist/` 读取资源。
- 安装 CSP、导航拦截、权限拒绝、webview/window-open 禁用等安全策略。
- 初始化 `ConfigStore`、Electron `safeStorage` adapter、HTTP transport 和 `WorkbenchStore`，再通过唯一的 `createAgentRuntime()` 创建 Agent 服务。
- 通过 `registerIpcHandlers` 绑定所有 `shared/ipc-contract.ts` 中声明的 channel。

`createAgentRuntime()` 是 Agent 依赖的唯一生产组装入口，创建 `SkillsManager`、`TraceService`、`ChangeHistoryStore`、`ProjectMetadataStore`、`CodeBackendManager`、`McpManager`、`PromptRegistry` 和 `SessionManager`。这些服务不由 Electron 或 Headless host 重复组装。配置存储、网络 transport、Workbench、窗口和 IPC 仍是 host 职责。

IPC 调用链：

1. renderer 调用 `window.agentApi.*`。
2. preload 把调用转成固定 channel 的 `ipcRenderer.invoke`。
3. `electron/ipc/index.ts` 校验 sender、payload size、payload schema。
4. `electron/ipc/app-handlers.ts` 执行业务 handler。
5. 返回值再次按 result schema 校验后返回 renderer。

主进程向 renderer 推送两类事件：

- `AGENT_EVENT_CHANNEL`：run、assistant、tool、approval、goal/plan、interjection、usage 等事件。
- `TERMINAL_EVENT_CHANNEL`：PTY 输出、状态和快照相关事件。

`SessionEventEmitter` 只产生与 Electron 无关的 `AgentEvent` / `TerminalEvent`，交给 `RuntimeEventBus` 校验和发布。EventBus 即使没有 renderer subscriber 也会有界保存 terminal run completion，供程序化 `AgentRuntime.run()` 等待；Electron adapter 只负责包装 IPC envelope 并转发给当前 `WebContents`。单个 host listener 失败会记录诊断，不能中断 Agent loop。

### 3.1 Headless host

`electron/headless/` 提供内部 `zch-agent-headless run` 和可直接调用的 `runHeadlessAgent()`。它把受信任的 headless config 转换为普通 v8 `AppConfig`，通过 provider-scoped 环境凭据创建同一个 `createAgentRuntime()`，并强制 session 使用 Yolo；task 无法修改权限模式或运行配置。Headless 不注册额外工具，也不复制 Provider/tool/compact/Skills/MCP loop。

stdout 是带 `schemaVersion/seq/ts` 的 JSONL，stderr 只接收 host 诊断；`result.json` 使用原子写入。host listener 汇总 usage、工具执行、最终回复和结构化 Goal/Plan 状态，补丁通过临时 Git index 生成，不修改真实 index。结果状态区分 `completed`、`failed`、`cancelled`、`timed_out` 和 `needs_human_input`，不把 Agent 正常结束误写成 hidden grader 通过。

Plan 进入 `awaiting_review` 后，driver 先等待共享 run controller 完全 settle，再用 `headless:auto-plan-approval` 更新状态并追加版本化 `<autonomous_plan_approval>` harness layer。该消息记录为 `orchestrator.message` 和 `harness.auto_action`，不是 `user.message`。自动批准达到配置上限或 Goal blocked 时返回 `needs_human_input`。SIGINT、SIGTERM 和 wall timeout 都复用 Runtime interrupt/disposer。

### 3.2 Runtime identity 与 host parity

每次 Headless run 会在 artifacts 中原子写入 `identity.json`。identity 包含构建时注入的 source commit、runtime image digest、case/config digest、全部 prompt resource hash、精确 Provider tool definitions 的 `toolsHash`、provider/model/profile/reasoning、核心预算，以及 platform/arch/Node/Skills/MCP/tool capability snapshot。比较器默认比较完整 identity；任一字段不同都会返回 `RUNTIME_IDENTITY_MISMATCH` 和具体字段路径，不允许把不可比 run group 混合统计。

`runtime-parity.test.ts` 使用同一 fake-provider trajectory 分别通过真实 Electron IPC handler/event adapter 和 Headless API 运行。fixture 覆盖 read、patch、process、Plan 人工/自动恢复、compact 和 generic MCP canonical call，比较 Provider messages、稳定 prompt layer hashes、prompt resources、`toolsHash`、工具参数/结果和最终 Git patch。规范化只处理显式 host 差异：随机 ID、时间、绝对路径、PID/耗时、自动 Plan 消息位置，以及由时间生成的 runtime-context hash；不使用宽泛 snapshot，也不忽略工具、模型消息或 patch 的结构差异。

### 3.3 Linux Docker worker

`benchmarks/docker/headless.Dockerfile` 从固定 digest 的 Node 24 bookworm-slim 构建 Linux x64/glibc OCI image，在 build stage 重新编译 Linux `node-pty`，再把 `dist-headless/zch-agent-headless.mjs`、版本化 prompt resources 和运行时依赖复制到非 root runtime stage。镜像标签记录 source commit/tree、platform、libc 和 Node major；Headless identity 另记录实际 image ID/digest。Docker worker 没有第二份 Agent loop 或工具注册。

`benchmarks/worker/coordinator.ts` 在创建资源前检查 Linux/amd64 daemon、seccomp、CPU/内存/PID capability 和镜像标签。Agent container 固定使用只读 rootfs、UID/GID 10001、`cap-drop=ALL`、`no-new-privileges`、默认 seccomp、CPU/内存/PID/tmpfs/wall/disk budgets；只挂载一个临时 workspace、独立 artifacts、只读 config/task 和单次 credential file。Docker socket、宿主 home、git credential、hidden grader 和任意额外挂载均不进入该接口。

默认 credential 模式创建每次 run 独立的 internal network。Agent 只连接该网络并只持有随机 proxy token；Provider proxy 是唯一双网络容器，真实 key 只通过 coordinator 私有临时文件挂载给 proxy，且有请求体和请求次数上限。显式 direct 模式只用于受控开发 fallback。所有终态都执行 stop、有限等待、kill fallback、bounded logs/artifact 收集、container/network 删除和 secret directory 删除，并把清理结果写入 `worker-result.json`。

### 3.4 BenchmarkCase 与 workspace preparation

`benchmarks/cases/contracts.ts` 定义 native BenchmarkCase、suite index、源码 archive 和 private evaluator spec 的 v1 TypeBox schema。公开 manifest 固定 repository provenance、raw archive/tree SHA-256、case image OCI digest、setup/public checks、acceptance groups、feedback policy、修改范围和资源预算；grader 公开部分只有 adapter/protocol 和 private spec 内容摘要。Suite index固定每个manifest hash，统一adapter revision再与suite hash组合成最终suite identity。Core manifest保留的review record只说明确定性self-check，不构成prompt/test语义审核或人工批准流程。

Oracle patch、mutant patch 与隐藏命令只位于 `benchmarks/private/`，该目录不进入 Docker build context。`toAgentCaseDescriptor()` 不返回 grader digest、内部绝对路径或任何 private spec 字段。Loader 在 workspace 或 Agent run 创建之前完成 schema、raw checksum、tree checksum、路径 containment、重复 ID、group reference、budget 和 OCI pin 校验；文件在首次 load 后变化还会被二次 checksum 拒绝。

源码 archive 使用确定性的 `zch-case-archive-v1` JSON 文件，按 path、mode、byte length 和原始内容计算 tree hash。准备器只向空目录写普通文件，创建一个新的 baseline-only Git repository，然后删除 reflog、hooks、remote/tag refs，并检查不存在不可达历史。Agent 可见文件表必须与 archive 完全一致，且会扫描 hidden/grader/oracle/mutant 路径和 evaluator-only 字段。

Native self-check 从 pristine archive 分别运行 baseline、oracle 和每个 mutant，检查修改范围与 `git diff --check`。普通case要求baseline失败；abstain case支持通过baseline和显式`no-change` oracle。Mutant必须先通过全部公开检查，再被声明的隐藏acceptance group拒绝；每个case完整重复三次并比较baseline commit与证据签名。`core-harness-8`固定为8项：slug normalization、chunk partitioning、retry backoff、config precedence、workspace routing、API compatibility refactor、diagnostic tail和no-change contract。

`benchmarks/adapters/external-datasets.ts` 负责解析最新或固定commit的Monthly-SWEBench与SWE-rebench leaderboard。最新只在run开始时解析；`benchmarks/cohort/selection.ts`用seed执行无放回抽样，固定Monthly 4 bugfix + 4 non-bug、SWE-rebench按patch规模分层8项，并跨来源限制同仓库最多一项。`cohort.json`记录dataset release/commit、adapter revision、case hash、官方任务image digest、派生Agent image digest和排除原因；case identity再包含cohort hash，所以A/B使用不同cohort会在现有逐字段identity比较中被拒绝。上游数据质量被直接信任，不运行prompt/test alignment、审核Agent或人工批准。

`benchmarks/adapters/external-docker-runtime.ts` 为外部任务实现机器兼容和执行边界。Monthly Harbor `environment/Dockerfile`构建任务image，SWE-rebench拉取行内声明的官方image；随后使用multi-stage overlay只复制当前ZCH Node Headless bundle，不复制Agent loop。任务原生workspace通过Docker named volume挂载，因而不经过Windows bind语义并保留symlink、执行位和依赖环境。Agent只看到problem statement、公开范围与预算；solution、gold/test patch、测试ID和verifier配置保留在`.dockerignore`排除的私有cache与grader挂载。每个case/image digest首次运行baseline未解决、oracle已解决的可缓存兼容检查；失败只标为infrastructure incompatible并递补，不评价数据集语义质量。

### 3.5 Benchmark runner 与 repair control

`benchmarks/runner/runner.ts` 编排 trial，但不实现第二份 Agent loop。默认 `strict` 在 Headless container 完成后收集 Git patch，再调用独立 grader coordinator；repair-once的首评和终评也走同一 grader协议。Agent container只挂载自己的 workspace和 artifacts，private spec与 evaluator workspace始终留在 grader边界。

Runner把经过schema校验的公开Agent case descriptor写入独立只读文件，由Headless以 `<benchmark_case>` user-role Harness层注入首次run；真实task仍单独记录为 `user.message`。Descriptor只含公开检查、allowed/denied modification scope和资源预算，不含private spec、oracle或mutant。Base Harness明确该tag是应用生成的任务约束，不是另一条用户消息。

`repair-once` 通过固定的 `benchmark.phase_ready` JSONL 事件和 `docker start --attach --interactive` stdin 决策通道协调。runner 首评失败后只返回一次经过清洗的 public/diagnostic feedback；Headless 用同一个 `SessionManager` 追加 `<benchmark_feedback>` harness message并启动一个 repair run，因此该消息在 trace 中是 orchestrator message，不伪装成 user message。无论首评还是终评，grader 都使用新准备的 workspace。

每个 pass@k trial 都创建独立 workspace、container、proxy token 和 artifact staging。runner 在 resume 前解析当前 OCI image digest并把它和 grader revision/digest纳入 trial identity；final trial 通过目录级 checksum和 identity hash封存。Resume 只读 complete final，不恢复 workspace、container 或 Provider continuation，遗留 `.incomplete-*` 仅作未完成证据。完成前删除 workspace并扫描所有 artifacts中的真实 Provider credential，命中时删除 staging。

### 3.6 Isolated grader 与分级评分

`benchmarks/grader/coordinator.ts` 从冻结 archive创建一次性 workspace并执行 patch apply、modification scope和 `git diff --check` preflight；通过后才启动独立 grader container。Container固定使用 `network=none`、UID/GID 10001、只读 rootfs、`cap-drop=ALL`、no-new-privileges和资源限制，只挂载 evaluator workspace、只读 private input及 output。Private input执行前后校验 hash，output校验 TypeBox schema、case/input/image identity和逐项命令计划，所有 container与临时目录在终态清理。

`benchmarks/grader/service.ts` 在 container内顺序执行 setup、public和private命令。原始 stdout/stderr不写入 report，只保存 bounded执行状态、失败类别和内容 hash。Restricted report保留私有 check ID用于本地复核；shareable `evaluation.json` 只暴露公开检查与 acceptance-group聚合，并由 `redaction.json` 声明省略字段。

`benchmarks/grader/scoring.ts` 区分 unsupported、invalid、attempted和 graded，先应用 patch、sandbox、identity、cleanup、credential等硬门禁，再计算 L0–L5。L4/L5按 manifest行为组而非测试数量计算，`groupMacroScore`对组做宏平均；全部 critical组与公开回归通过才可 L5，且任何硬门禁失败都不能 resolved。仓库内 native evaluator仅保留为 deterministic单元测试 adapter，不再产生正式 runner结果。

### 3.7 Benchmark 指标、成本与配对比较

`SessionToolRunner` 在每次工具终态写入 `tool.attempt`，记录 canonical tool、validation/permission/execution stage、outcome、effects、duration、输入输出字节、截断和错误码；`tool.call` 继续保留实际参数与结果。`llm.request` 额外标记 main/compression scope，approval 调用可由 approval trace 与 usage 对齐，因此缺失 Provider usage 的 request 会明确形成 unknown，而不是按文本长度估算或累加成零。

`benchmarks/metrics/aggregate.ts` 从 trace、Agent JSONL、patch 和 Headless duration 生成 trial metrics：按 scope 汇总 token，按 tool/effect 汇总工具终态，计算重复 canonical 参数签名、首次编辑/测试、最终验证后空转、patch 规模及 trajectory 计数。只有显式固定的 `priceSnapshot` 才计算成本；snapshot 原文、来源 revision 和 hash 一同进入 artifacts/identity，任何被定价字段缺失都会使相应成本保持 unknown。

测试命令识别先从结构化tool参数恢复命令文本，覆盖package runner、常见语言测试器以及 `node test/...`等直接执行测试文件的形式；只有已settle成功的 `run_command` 才可作为最终验证时间，terminal input被接受不能冒充测试通过。

`benchmarks/metrics/compare.ts` 使用全部 trial 成本计算 `costPerResolvedUsd`，同时保留 unresolved 的 token/成本消耗。A/B先逐trial校验case/cohort、runtime/case/grader image、Provider/model/profile/reasoning、预算、protocol、trial index和price snapshot，再输出paired delta、win/loss/tie、总体resolve delta与95%区间。排序固定按hard-gate safety、correctness、efficiency的词典序，效率不参与correctness得分。

### 3.8 Benchmark CLI、运行档位与 artifacts

`benchmarks/cli/main.ts` 构建为独立 Node 24 bundle，不依赖 Electron renderer 或 IPC。四个opt-in npm命令分别固定smoke、daily、full和external preset：Core默认3×1、8×3、8×5，external为Monthly 8 + SWE-rebench 8且每项3 trials。CLI最多接受8个suite、64个case和每项5 trials，从Headless config声明的环境变量读取Provider key，并默认只把真实key交给受限Provider proxy。External支持`--seed`创建cohort或`--cohort`复用，不允许同时指定。

`benchmarks/runner/group-runner.ts` 串行复用 `runBenchmarkTrials()`，只增加 run-group编排，不复制 Agent、worker或 grader实现。Artifact层级固定为 run-group → suite/case → trial → attempt；group保存不可变 identity、Headless config和可选 price snapshot，case保存 manifest/Agent descriptor/task，trial继续保存 worker trace/JSONL/stderr、metrics和泄漏扫描，attempt保存 patch/evaluation/grader证据。同一输出目录只有 identity完全一致时才能恢复，具体 trial仍由已有 complete marker和整树 hash验证。

本地 `case-result.restricted.json`、raw worker/grader artifacts和 config snapshot不进入分享报告。`shareable-report.json`仅组合公开evaluation、聚合metrics和comparison identity；外部报告另外分列Monthly、SWE-rebench、两来源50/50 macro与总体结果。`redaction.json`同时列出restricted globs和被删除字段。Run-group `summary.json`区分unresolved与artifact/metrics incomplete，避免把trace缺失伪装成有效零成本结果。

每个有完整trace的trial通过共享 `conversationToMarkdown()` 生成可导入消息语义的 `conversation.restricted.md`，并通过桌面端同一transcript normalizer生成 `session-transcript.restricted.md`。后者包含工具、审批、内部编排、明文reasoning和Provider消息快照，不取代raw trace；它进入artifact hash和restricted清单、从shareable report隐藏，并作为唯一精确路径例外不进入credential scan。

---

## 4. 配置、凭据与模型

配置由 `electron/config/store.ts` 管理，schema 在 `electron/config/schema.ts` 和 `shared/config.ts` 中定义。当前 schema version 为 8；v8 增加通用 MCP server 配置，旧配置迁移时自动补默认值。并发配置不包含独立 provider call 上限，也不允许调整同 workspace writer 数。

持久化位置：

- 非敏感配置：`userData/config.json`。
- 凭据：`userData/secrets.json`，通用 `SecretStore` 通过 host 提供的 adapter 加密；桌面 host 使用 Electron `safeStorage` adapter。
- workbench：`userData/workbench.json`。
- trace：`userData/traces/*.jsonl`。
- change history：`userData/change-history.json`。
- skills：`userData/skills/`。
- project metadata：每个 workspace 下的 `.zch/project-model.json`。

配置要点：

- provider 是数组结构，支持 `deepseek` 和 generic OpenAI-compatible profile。
- `DEEPSEEK_API_KEY` 只作为开发 fallback，renderer 永远只能看到 credential configured/source 状态。
- web search 当前支持 Brave provider 配置。
- HTTP proxy 通过 `createHttpTransport` 装配，配置变化后刷新 transport。
- 模型目录刷新由主进程带凭据请求 provider，renderer 不接触 API key。
- assistant preferences 是用户可编辑偏好，不替换 base harness prompt。

---

## 5. Session 与 Run

`AgentRuntime` 是 Node-only 生命周期和控制门面，拥有共享事件总线、Agent 服务以及幂等 dispose。它提供程序化 create session、run completion、interrupt 和 close；Electron IPC 使用同一 runtime services。`SessionManager` 负责 session map、run 生命周期、trace logger 所有权和 terminal facade，长流程被拆到 session-scoped collaborators：

| 模块                             | 职责                                                                     |
| -------------------------------- | ------------------------------------------------------------------------ |
| `SessionRunController`           | 单 run 状态机、用户轮入栈、provider/tool 循环、取消和结束。              |
| `SessionUserTurnPreparer`        | runtime/AGENTS 更新、slash command 解析、run context attachment 准备。   |
| `SessionProviderTurnRunner`      | prompt selection、plugin beforeLLMCall、provider 调用、LLM trace/usage。 |
| `SessionToolRunner`              | 工具 inspect、权限管线、审批、执行、tool result 入栈和 trace。           |
| `SessionCompactCoordinator`      | 手动 `/compact` 和自动 compact，重写 provider history。                  |
| `SessionInterjectionCoordinator` | 运行中用户插话排队、注入、carryover、supersede。                         |
| `SessionOrchestrationPlanner`    | goal/plan continuation 和 warning。                                      |
| `SessionOrchestratorMessages`    | orchestration prompt 解析、事件和 history 注入。                         |
| `SessionEventEmitter`            | AgentEvent 发射和 session 归属检查。                                     |
| `SessionTerminalController`      | session-scoped terminal facade。                                         |
| `WorkspaceAccessCoordinator`     | 全局 active run 配额与 canonical workspace 唯一 writer 所有权。          |

Run 流程概要：

- 每个 session 同时最多一个 active run。
- `startRun` 创建 `AbortController` 和 `ActiveRun`，重复 `clientRequestId` 幂等返回已有 run。
- 普通用户消息先经 `SessionUserTurnPreparer`，再把 app-authored context layers 和用户原文追加到 `session.history`。
- `/compact` 是特殊命令，由 compact coordinator 直接处理，不进入普通 provider/tool loop；重写后的 `<compact_history>` 会追加 compact 时刻的 Goal/Plan 状态快照，避免摘要模型漏写编排状态。
- 每步 provider 调用前会 drain queued interjections、检查自动 compact、重新注入最新 runtime/AGENTS context。
- provider 返回 assistant turn 后写入 history；若有 tool calls，则进入工具执行；若没有 tool calls，则检查 goal/plan continuation 或结束 run。
- 中断通过 `AbortSignal` 协作传递给 provider、工具、审批等待和长进程。

并发与 workspace 访问采用“一写多读”模型：

- 全应用最多同时存在 `maxConcurrentRuns` 个 active run，默认 4；第 5 个 run 直接以 `CONFLICT / max_concurrent_runs` 拒绝，不排队。每个 run 同时最多一个 provider call，因此该配置也构成理论 provider call 上限。
- `readonly` run 只占全局 run slot，不获取 writer；`auto`、`confirm`、`yolo` run 必须原子获取 canonical workspace 的唯一 writer。不同 workspace 可以各有一个 writer，同一 workspace 的第二个非只读 run 以 `CONFLICT / workspace_writer_active` 拒绝。
- writer 从 run 启动覆盖 provider 调用、工具执行、等待人工审批、interjection continuation 和 cancelling；不会在单个 tool batch 后释放。若取消或超时时存在 `supportsAbort: false` 的副作用工具，terminal 状态可以先完成，但 writer 必须继续持有到该工具底层 Promise settle，不能仅因包装层返回 cancelled/timeout 就开放第二个 writer。
- terminal run status 对 renderer 可见前先幂等释放全局 run slot；没有残留副作用时同时释放 writer，否则延迟到残留副作用 settle。`finally`、session close 超时与 manager dispose 使用同一幂等路径兜底。carryover 可立即使用全局容量，但同 workspace 的非只读 carryover 会等待 writer 真正释放后重试。
- idle session 改为 `readonly` 始终允许；改为非只读模式时主进程重新检查 writer。active run 期间任何 mode 修改都拒绝。
- `workspace.writer.changed` 向 renderer 发布 acquired/released owner；trace 记录 `workspace.writer` 的 acquired/released/rejected、结构化 `run.rejected`，且 `session.start` 包含 conversationId。
- ReadOnly 对所有副作用生效，包括 filesystem/VCS/project metadata 写入、process spawn、terminal write、network side effect 和 unknown external effect；只读文件、代码、VCS、terminal 与 instruction 读取仍可用。

---

## 6. Prompt Harness

Prompt harness 当前由 `electron/session/prompt-harness.ts`、`electron/prompts/registry.ts` 和 `resources/prompts/` 组成。

资源加载：

- `PromptRegistry.load(resources/prompts)` 加载 harness、approval、orchestration prompt。
- 每个资源记录 `id/version/path/sha256`。
- 默认资源引用定义在 `shared/prompt-resources.ts`。

会话层：

- 初始 session 会追加 base instructions、runtime context、assistant preferences、AGENTS 和 skills summary。
- runtime context 来自 `resources/prompts/harness/runtime-context.*.md` 模板，变量由 TypeScript collector 提供；动态快照包含当前日期、时间、timezone、workspace、permission mode、provider/model、git summary、project tree、module context 和 workspace writer 状态。
- `<workspace_concurrency>` 固定为 `available`、`writer` 或 `readonly_locked`。其他 writer 存在时，trusted harness 会写入 writer conversation/run ID，明确禁止当前 readonly session 调用副作用工具，并要求 writer 结束后重读相关文件。该状态参与 runtime-context hash，因此获取和释放 writer 都只在下一次 provider call 追加新快照，不改写已存历史。
- `AGENTS.md` / `AGENTS.override.md` 通过 `agents-context.ts` 从 workspace 和 selected attachments 的目录链读取，格式化为 `<agents ...>` tagged context；tag 会记录 path、kind、depth、priority、hash、bytes 和 truncated，越深目录和 override 文件具有更高优先级。
- run attachments 由 `context-attachments.ts` 生成 `<context_file>` 和 `<context_directory>`，再包进 `<selected_context>`。
- slash command、skills、compact、goal/plan 等 app-authored context 以 user-role provider message 追加，但其来源、trusted/editable、hash 和 token 估算记录在 prompt ledger。

选择与 trace：

- `selectPromptMessages` 保留 ledger-pinned layers，并按完整用户轮次裁剪普通历史。
- 每次 provider request 记录 `promptBuild`，包含 layer kind/source/hash/included 等摘要。
- `promptResources(session)` 把被使用的 prompt resource id/version/path/hash 写入 `llm.request` trace。
- 除 compact 重写外，`session.history` 按 append-only 处理。

---

## 7. Slash Commands、Goals 和 Plans

`electron/session/slash-commands.ts` 解析当前支持的命令：

| 命令                | 行为                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `/skill <name> ...` | 读取已启用 skill 的完整正文，注入 `<skill_request>` 和 `<skill>` selected context。        |
| `/compact ...`      | 触发手动 history compaction，使用 orchestration compact prompt。                           |
| `/prompt ...`       | 注入 app-authored orchestration request。                                                  |
| `/goal ...`         | 创建 active goal，注入 localized `goal-started` orchestration prompt。                     |
| `/plan ...`         | 注入 localized `plan-started` orchestration prompt；实际 Plan 由模型调用 `plan_set` 创建。 |

Goal/Plan 状态存放在 `SessionState` 中，并通过 `goal.updated` / `plan.updated` 事件同步到 renderer。模型可通过 `orchestration-tools.ts` 暴露的 goal/plan 工具读取和更新状态。`plan_set` 创建或替换 Plan，并默认进入 `awaiting_review`；Plan review 是编排状态，不是权限模式，副作用工具仍由 permission pipeline 审批和执行。用户明确批准后，UI 先把 Plan 标记为 `active` 并写入 `plan.status` trace event，再启动下一轮；自然语言批准可由模型通过 `plan_status({ status: "active" })` 记录状态并继续。所有 item 完成或取消后，运行时会把 active 顶层 Plan 收口为 `completed`；completed item 必须有 result/evidence，cancelled item 必须有 cancelReason。

---

## 8. LLM Provider

Provider 抽象在 `electron/providers/provider.ts`：

- 输入是 normalized `ProviderMessage[]`、tool schemas、responseFormat、providerRequestOverride 和 AbortSignal。
- 输出是 `ProviderEvent` async iterable：文本 delta、reasoning delta、tool delta、usage、completed。
- completed event 携带 normalized assistant turn、解析后的 `ToolCall[]`、provider raw response、usage、timing 和 providerState。

当前实现的实际 provider 是 `OpenAICompatibleProvider`：

- 支持 DeepSeek profile 和 generic OpenAI-compatible profile。
- DeepSeek reasoning 参数、stream usage、tool call delta 聚合和 provider request snapshot 在 adapter 内处理。
- Auto approval 复用同一 provider 抽象，并可请求 JSON object response format。

Provider request snapshot 会记录 normalized messages、provider wire request、request bytes、prefix hash 和 prefix fingerprints。传输层 Authorization 不写入 trace。

---

## 9. 工具系统

工具由 `createSessionTooling` 注册到 `ToolRegistry`，再由 `ToolExecutor` 执行。当前内置工具类别：

- read-only workspace tools：`read_file`、`list_dir`、`glob`、`grep`。
- file mutation tools：`create_file`、`apply_patch`、`delete_file`。
- process tools：`run_command`、`delay`。
- terminal tools：`terminal_open`、`terminal_send`、`terminal_read`、`terminal_list`、`terminal_resize`、`terminal_close`。
- git tools：`git_status`、`git_diff`、`git_log`、`git_show`、`git_add`、`git_commit`、`git_restore`。
- network tools：`fetch`、`web_search`。
- skills：`read_skill`。
- project metadata：`project_get_modules`、`project_detect_modules`、`project_set_modules` 等。
- code intelligence：`code_symbol_overview`、`code_find_definition`、`code_find_references`、`code_workspace_symbols`、`code_diagnostics`。
- orchestration：goal/plan 状态工具。

Tool contract：

- 每个 tool 定义 id、description、TypeBox input schema、effects、defaultRisk、timeout、输出上限和 `execute`。
- 发给 provider 的 schema 会自动加入 `_agent_intent` 字段；解析 tool call 后提升为 `ToolCall.reason` 并从业务 args 删除。
- `ToolExecutor.inspectCall` 先做 tool id 和 schema/自定义参数校验。
- `ToolExecutor.execute` 要求传入 `ApprovedToolCall`，执行前 revalidate session/run/tool/args hash/resource preconditions。
- 所有 tool result 都经过字节上限裁剪，再进入 provider history 和 trace。

---

## 10. 权限与审批

权限管线由 `PermissionPipeline`、`policy-engine.ts`、`session-approval.ts` 和 `auto-approver.ts` 组成。

决策输入包括：

- 当前 permission mode：`readonly`、`auto`、`confirm`、`yolo`。
- tool effects、defaultRisk 和 policy signals。
- remembered rules。
- plugin `beforeToolCall` hook 风险提升。
- file tools 的 resource plan、diff 和 preconditions。
- Auto 模式下的 approval provider 判断。

模式语义：

- `readonly`：只允许只读/低风险工具。
- `confirm`：有副作用或 review-risk 工具进入人工审批。
- `auto`：策略可 fast-path 低风险操作，其他场景可调用审批模型；危险或模型失败会进入人工审批。
- `yolo`：跳过普通审批策略，但仍保留 schema、workspace、sender、resource precondition 等执行不变量。

人工审批由主进程发出 `approval.requested` 事件，renderer 决策后调用 `approval:decide`。审批绑定 `sessionId/runId/callId`，过期、中断、重复决策和错误归属都被拒绝。

---

## 11. 文件、进程、终端与 Git

文件边界：

- `PathGuard` 负责 workspace 根、真实路径、路径逃逸、symlink/junction、大小和 bounded read/write。
- `create_file` 只创建不存在文件，可创建缺失父目录。
- `apply_patch` 对已有 UTF-8 文件应用严格 text patch，不做 fuzzy apply。
- `delete_file` 独立高风险工具。
- `ChangeHistoryStore` 记录 agent 文件变更，支持 UI revert。

进程边界：

- `run_command` 支持 `process` 和 `shell` 两种模式。
- 子进程环境使用 allowlist 构造，不继承 provider API key 等应用秘密。
- 输出由 bounded output 保留 head/tail、totalBytes、truncated 和 discarded hash。
- 超时/取消会终止进程树。

终端：

- `TerminalPool` 基于 `node-pty`，PTY 生命周期归属 session，不随单个 run 自动销毁。
- 输出以 terminal event 推送到 renderer；model-facing `terminal_read` 返回 ANSI-free bounded text。
- renderer 端用 xterm.js 展示，`terminal-sequence.ts` 处理事件序列缺口恢复。

Git：

- read tools 默认低风险。
- write tools 通过权限管线；`git_commit` 使用 `--no-verify`，`git_restore` 视为 discard 类高风险。
- 参数做 option injection 防护，pathspec 和 ref 均按白名单处理。

---

## 12. ProjectModel 与 Code Intelligence

Project metadata 存在 workspace 的 `.zch/project-model.json`，由 `ProjectMetadataStore` 管理。默认模型包含：

- modules。
- defaultModuleId。
- Serena backend config。
- code backend bindings。
- `.zch` 是否建议加入 gitignore 的提示。

`ProjectModuleDetector` 根据 manifests 检测多模块结构。renderer 的 Project tab 可查看/保存模块、Serena 配置和 backend 状态。

Code intelligence facade：

- 模型只看到稳定 `code_*` 工具，不直接看到原始 Serena MCP tools。
- `CodeBackendManager` 根据 ProjectModel、module、language、path 和 capability 路由查询。
- 当前实际 backend 是 `SerenaMcpAdapter`，通过 MCP stdio 启动 Serena 并只允许一组只读工具。
- 支持符号概览、定义、引用、workspace symbols 和 diagnostics。
- 当 backend 未配置、capability 不支持、路径不在 module 内或需要 file path 但传了目录时，返回结构化 unsupported result，而不是抛给模型。

Generic MCP gateway：

- `McpManager` 管理手写 stdio server 配置、启动信任、global/workspace 生命周期、目录 revision、退避重启、draining 和关闭；`McpStdioConnection` 同时供通用 MCP 与 Serena adapter 复用。
- Provider 工具定义固定为 `list_mcp_servers`、`read_mcp_server`、`call_mcp_tool`。前两者只读取本地缓存目录；`read_mcp_server` 使用绑定 server/revision/offset 的不透明 cursor，并受页大小与总输出大小双重边界约束。
- Session 保存每个 server 已披露的 revision 和工具名。通用 wrapper 在产生 proposed event 前解析为 `mcp:<serverId>:<toolName>` 的临时 `ToolDefinition`，所以权限、审批、plugin hook、trace 和 writer 协调看到的是实际 server、tool、arguments 与 annotations。
- 动态 MCP tool 固定分类为 `external.unknown`、风险 `review`、不可记忆审批、不可自动重试。ReadOnly 拒绝，Auto 进入审批模型，Confirm 进入人工审批，Yolo 跳过 MCP 审批。
- `tools/list` 最多 100 页、1,000 个工具和 4 MiB 原始目录；单个规范化工具最多 32 KiB。重复 cursor、重复名称、无效 schema 与过大定义形成诊断且不可调用。
- `structuredContent` 与文本内容优先保留；图片、音频和 blob 的原始 base64 不进入模型上下文。输出继续受公共字节/token 和敏感内容边界约束。

---

## 13. Skills 与网络

`SkillsManager` 负责：

- 扫描 `userData/skills`。
- 解析 bounded YAML front matter。
- 跳过 malformed、重复、超大、symlinked skill。
- 管理 enablement。
- 安装本地文件和 HTTPS URL skill。

网络安全：

- skill URL 安装和 fetch/web_search 走 SSRF guard。
- 私网、loopback、link-local、带 credentials 的 URL 被拒绝。
- redirect 重新校验目标，跨源 redirect 会剥离敏感 header。
- HTTP proxy 由配置驱动，通过 main-process transport 注入。

---

## 14. 插件事件总线

`PluginEventBus` 是主进程内的 hook/event 机制，不是插件 sandbox。当前用于：

- `onSessionStart` / `onSessionEnd` observation。
- `beforeLLMCall` 可返回 message patch。
- `afterLLMCall` observation。
- `beforeToolCall` 可提升风险或阻断。
- `afterToolCall` observation。

Hook context/result 都是版本化对象。Hook 超时和错误隔离由 event bus 处理；安全相关 hook 失败按保守策略处理。当前代码提供事件总线和 tool registration port，但没有实现外部 JS 插件加载器。

---

## 15. 日志、Trace 与回放

Trace 默认关闭。开启 logging 前必须接受 trace notice。

`JsonlTraceLogger` 写入 `userData/traces/{sessionId}.jsonl`，每行是一个 schemaVersion 1 的 trace event，并带单调 `seq` 和 `eventId`。`NullTraceLogger` 在关闭时不创建文件。

主要事件：

- session/run lifecycle：`session.start`、`session.end`、`session.mode`、`run.start`、`run.end`、`run.rejected`、`workspace.writer`。
- LLM：`llm.request`、`llm.response`、`llm.usage`。
- tool/approval：`approval`、`tool.call`。
- UI-visible content：`user.message`、`agent.message`、`orchestrator.message`、`interjection.message`。
- orchestration audit：`plan.status` 记录 UI plan review 导致的顶层 Plan 状态变化。
- terminal：`terminal.event`。

Trace request 记录：

- normalized messages。
- provider request body。
- request bytes、prefix hash、prefix fingerprints。
- prompt resources。
- prompt build layer summary。

`TraceService` 提供 list、replay、stats、fork、cleanup与session transcript。Transcript normalizer按seq生成稳定快照，把同一callId的proposed/approval/attempt/call合并为工具项，final message替代重复stream delta，中断delta标记partial；Provider消息快照单独分页。Timeline cursor绑定trace revision，活动trace追加后旧cursor变stale，renderer只能读取2 MiB有界页面。Fork仍从某个 `llm.request` 恢复provider request override，不重放历史副作用。

`zch-session-transcript` 是不可导入的restricted审计格式，与可导入且不含工具的 `zch-conversation` 分离。Electron主进程每次导出前显示风险警告并原子保存，既不扫描也不脱敏；多模态载荷和opaque reasoning不写入。查看器可从conversation或Trace Debug进入，按run分组并过滤用户、Assistant、reasoning、internal、tool/approval、Provider、runtime和terminal事件。

隐私边界：

- Authorization/API key/safeStorage 密文不写 trace。
- 工作区文件、tool output、模型消息本身如果包含秘密，启用完整 trace 后会被原样保存；UI 以 notice 和清理入口提示用户。

---

## 16. Renderer 架构

Renderer 是 Vue 3 + Pinia 应用，主要职责是展示和收集用户操作。

状态分层：

- `agent-shell`：bridge/bootstrap 状态。
- `agent-settings`：provider、permission、logging、assistant、skills settings。
- `agent-workbench`：projects、conversations、markdown import/export、persistence。
- `agent-runtime`：session/run 生命周期、IPC 调用、AgentEvent 分发。
- `agent-timeline`：messages、tools、usage、context attachments、goal/plan。
- `agent-changes`：agent 文件变更和 revert。
- `agent.ts`：兼容旧组件的 facade，新代码应直接使用领域 store。

并发路由规则：

- `conversationRuntimes` 是 sessionId、activeRunId、runStatus、startPending、pending approval/carryover、error、event seq、diagnostics 和 timeline counter 的唯一运行时来源；active facade 值由当前 conversation 派生。
- 每个 `ConversationRecord` 还持久化自己的 composer draft 与 context attachments；切换 conversation 时先写回来源 record，再从目标 record 恢复，未发送内容不会在后台 run 或 workspace 切换时串线或丢失。
- create session、start run、approval、interrupt、plan 和 trace fork 在 `await` 前捕获 conversationId，IPC 返回后只更新发起方；后台事件通过 `conversationIdBySessionId` 路由。
- 当前 timeline 使用 `agent-timeline`；后台 timeline adapter 直接绑定目标 `ConversationRecord`，内存立即更新。所有 conversation 共用 250ms workbench debounce，dispose 前 flush；事件诊断最多保留 100 条。
- `workspaceWriters` 索引只保存主进程事件快照。writer 获取时不批量改 inactive conversation；用户切换到同 workspace 的其他 conversation 时才持久化为 readonly 并同步其 idle session。writer 结束后 selector 解锁但保持 readonly，必须由用户手动选择其他模式。
- 后台 approval、carryover、错误和 completed/failed 状态保留在目标 runtime；sidebar/search badge 优先级为 awaiting approval、writer、readonly locked、cancelling、running、failed、completed。

UI 主要区域：

- Chat timeline：用户、assistant、tool rows、approval、interjection、orchestration、goal/plan。
- Composer：普通消息、slash commands、`@path` context attachments、run 中 interjection。
- Settings：provider、model catalog、permissions、logging、assistant preferences、skills。
- Artifact sidebar：workspace explorer、Project tab、changes/trace 等工具面板。
- Terminal panel：persistent PTY tabs。

Renderer 不执行工具、不读 secrets、不直接访问文件系统。所有文件树、文件内容、terminal、trace、project metadata 都通过 `agentApi` 调用主进程。

---

## 17. 安全边界

已实现的主要安全边界：

- Renderer sandbox + contextIsolation。
- 冻结 `window.agentApi`，不暴露 `ipcRenderer`。
- IPC sender、frame、origin 和 payload/result schema 校验。
- CSP、navigation/window/webview/permission 禁用。
- `PathGuard` 限制 workspace 文件访问。
- secret store 不向 renderer 返回密文或 apiKeyRef。
- 子进程环境 allowlist，避免泄露 provider credentials。
- tool permission pipeline 和 per-call approval。
- output bounding 和 context budget。
- SSRF guard 和 redirect revalidation。
- trace notice gate 和 trace cleanup。

非目标：

- `run_command`、PTY、git hooks 和项目脚本不是 sandbox。用户批准后它们仍可访问主机环境。
- 完整 trace 不是脱敏日志。它用于调试和回放，默认关闭。
- 插件事件总线不是执行任意第三方 JS 的隔离环境。

---

## 18. 测试与质量门禁

常用命令：

- `npm test`：Vitest deterministic tests。
- `npm run typecheck`：Vue/Node TypeScript type checks。
- `npm run lint`、`npm run format:check`：静态质量。
- `npm run test:e2e`：先 `npm run build:app`，再 Playwright Electron e2e。
- `npm run test:native`：node-pty native smoke。
- `npm run test:ripgrep`：bundled ripgrep smoke。
- `npm run test:real`：显式 live provider 测试，需要 `DEEPSEEK_API_KEY`。
- `npm run test:docker-worker`：显式构建 Linux worker image，运行 fake-provider proxy smoke 和强制超时清理；不进入默认测试链路。
- `npm run test:benchmark-cases`：校验冻结 manifest/archive/private-spec，并对 3 个 bootstrap case 重复运行 baseline/oracle/mutant 自检。

当前测试分布：

- `electron/**/*.test.ts`：主进程业务、Node-only AgentRuntime、工具、权限、provider、session、prompt、logging、project/code intelligence。
- `shared/**/*.test.ts`：contract、markdown import/export、titles。
- `src/**/*.test.ts`：Pinia stores、Vue components、terminal sequence。
- `e2e/*.spec.ts`：Electron 安全基线、设置/工作台/UI、fake provider 功能流、审批、interjection、terminal。

设计约束：

- `npm test` 必须离线、确定性，不依赖真实付费 provider。
- Live provider 测试只走 `npm run test:real`。
- 安全敏感分支需要单测覆盖：IPC、path guard、permission、secrets、SSRF、tool resource preconditions。
- Renderer 回归优先用组件/store 测试；跨 renderer-main-provider 的关键路径用 Playwright。

---

## 19. 当前限制

- 桌面产品仍把 Node-only AgentRuntime 实例化在 Electron 主进程，而不是 utility process；未捕获的主进程宿主错误仍可能影响窗口。外部benchmark已支持Harbor/SWE-rebench声明的Linux任务环境，但上游image体积、registry可用性和跨平台Docker实现仍会产生infrastructure incompatible样本；这类失败不计为模型任务失败。
- Provider 层当前是 OpenAI-compatible/DeepSeek 为主，没有多厂商完整矩阵。
- Code intelligence backend 当前实际实现为 Serena MCP 只读 adapter，rename/edit capability 只在 schema 中预留。
- 插件系统只有事件总线和 hook 点，没有本地 JS 插件加载器。
- 完整 trace 默认关闭，开启后可能保存源码和工具输出中的敏感内容。
- 命令/终端/git 写操作依赖权限和审批，不提供 OS/container 级隔离。
