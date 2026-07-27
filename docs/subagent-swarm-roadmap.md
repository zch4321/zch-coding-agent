# Subagent 与 Swarm Roadmap

> 状态：设计已确认，尚未实现。
>
> 本文定义通用只读子 Agent 和 Swarm Tool 的产品语义、后端边界与实施顺序。已落地后的稳定事实应迁入 `architecture.md` 和 `requirements.md`，本文继续只保留未完成阶段与后续扩展。

## 1. 目标与范围

本方向先建立一个可复用的单子 Agent 执行原语，再在其上实现可配置的 Swarm 调度。主 Agent 负责描述任务、给子 Agent 命名、选择所需模型能力，并在收到 Tool Result 后自行总结；Renderer 不直接创建或驱动子 Run。

第一阶段目标：

- 主 Agent 可通过 `subagent_run` 委派一个只读代码理解任务。
- 用户启用 Swarm 后，可用 `/swarm` 显式授权主 Agent 在本次 Run 中调用一次 `swarm_run`。
- `swarm_run` 可一次声明多个具名子 Agent，并从跨 Provider 模型池中按能力和并发约束分配模型。
- 每个子 Agent 使用独立、隐藏的 Durable Session 和冻结的模型路由，只能读取同一份稳定 workspace snapshot。
- 子 Agent 以自由文本返回，Tool Result 仅用 JSON 区分 Agent 名称、结果和必要元数据。
- 主 Agent 在原 Run 中读取标准 `tool` role 结果并向用户汇总，不启动额外聚合 Agent 或第二个主 Run。

第一阶段不包括：

- 多机器分布式 Worker、远程任务租约和网络调度。
- 子 Agent 之间通信、递归创建子 Agent 或多轮跟进。
- 运行测试、终端、命令、网络请求或任意写入操作。
- 自动修改代码或把多个子 Agent 的建议直接应用到 workspace。
- 单独的 Swarm 任务中心或普通 Session 侧栏入口。

## 2. 产品调用语义

### 2.1 通用子 Agent

`subagent_run` 是底层能力的第一个公开 Tool。功能开关默认关闭；用户启用后，主 Agent 可以在普通 Run 中将适合独立读取代码的任务委派给一个子 Agent。

建议输入：

```json
{
  "name": "结构分析员",
  "task": "阅读项目目录、入口和模块边界，向主 Agent 解释代码结构",
  "modelClass": "standard"
}
```

约束：

- `name` 在一次调用内唯一，长度有界，不能包含控制字符或危险保留键。
- `task` 必须自包含；默认不复制主 Session 的完整历史。
- `modelClass` 可选，取值为 `light | standard | strong`；未指定时使用配置的默认子 Agent 路由，模型池尚未配置时可回退到父 Session 当前 selection。
- 每次只创建一个子 Agent；需要批量并发时必须使用 `swarm_run`。
- 子 Agent 不能看到 `subagent_run` 或 `swarm_run`，因此不能递归委派。

### 2.2 Swarm Slash Command

`/swarm <目标>` 是一次性的高成本操作授权，不直接由 Renderer 展开固定任务。

处理流程：

1. Backend 检查 `swarm.enabled`、模型池、隐私 notice、并发和预算配置。
2. 当前 Active Run 获得绑定到 `sessionId/runId` 的一次性 Swarm capability；旧历史中的 `/swarm` 不能授权未来 Run。
3. Prompt Harness 注入版本化 `orchestration_request`，说明用户目标、可用模型能力和 Tool 约束。
4. 仅本次 Run 向主 Agent 暴露 `swarm_run`。
5. 主 Agent 拆分任务、命名 Agent、指定模型能力等级，然后调用 Tool。
6. `swarm_run` 返回标准 Tool Result，主 Agent 在同一 Run 中总结并回复用户。

Swarm 未启用或配置无效时，`/swarm` 在请求 Provider 前返回明确错误并指向设置页。

建议输入：

```json
{
  "objective": "审查当前项目的持久化、并发和测试边界",
  "agents": [
    {
      "name": "事务审查员",
      "task": "检查 SQLite 事务、migration 和 repository 边界",
      "modelClass": "strong"
    },
    {
      "name": "并发审查员",
      "task": "检查 Session 生命周期、取消和并发竞态",
      "modelClass": "strong"
    },
    {
      "name": "测试审查员",
      "task": "检查现有测试缺口和容易遗漏的边界",
      "modelClass": "light"
    }
  ]
}
```

若多个 Agent 需要执行相同任务，主 Agent 应声明多个具名条目。第一版不增加 `count`、`replicas` 或多形输入 schema。

## 3. JSON Tool Result

Tool 内部结果继续使用现有 `ToolResult = { status, content: JsonValue }`。子 Agent 正文是自由文本；JSON 只负责标识来源、失败状态和有界诊断。

单子 Agent 与 Swarm 共用同一种结果形状，前者只有一个字典条目：

```json
{
  "status": "ok",
  "content": {
    "results": {
      "结构分析员": "这是一个 Electron + Vue 项目，主要模块边界包括……",
      "并发审查员": "我检查了 Session 生命周期，主要发现是……",
      "测试审查员": null
    },
    "meta": {
      "job": {
        "status": "partial",
        "requested": 3,
        "completed": 2,
        "failed": 1,
        "durationMs": 125000
      },
      "agents": {
        "结构分析员": {
          "ordinal": 0,
          "status": "completed",
          "task": "分析代码结构",
          "poolEntryId": "standard-coder",
          "providerId": "provider-a",
          "model": "model-x",
          "capability": "standard",
          "durationMs": 42000,
          "truncated": false
        },
        "并发审查员": {
          "ordinal": 1,
          "status": "completed",
          "task": "审查并发边界",
          "poolEntryId": "strong-coder",
          "providerId": "provider-b",
          "model": "model-y",
          "capability": "strong",
          "durationMs": 87000,
          "truncated": false
        },
        "测试审查员": {
          "ordinal": 2,
          "status": "failed",
          "task": "检查测试覆盖",
          "poolEntryId": "light-coder",
          "providerId": "provider-a",
          "model": "model-z",
          "capability": "light",
          "error": {
            "code": "PROVIDER_FAILURE",
            "message": "Provider request failed"
          }
        }
      }
    }
  }
}
```

结果规则：

- `results` 的 key 是用户可读 Agent 名，value 是自由文本或失败时的 `null`。
- Agent 名必须唯一；实现使用安全字典构造并拒绝 `__proto__`、`prototype`、`constructor` 等保留键。
- `meta.agents` 使用相同 key，保存任务、实际模型、能力等级、状态、耗时和截断信息。
- 不返回 reasoning、Provider 原始响应、endpoint、凭据、完整工具轨迹或内部绝对路径。
- 输出顺序按主 Agent 声明的 ordinal，而不是完成顺序。
- 至少一个 Agent 成功时，外层 Tool Result 为 `ok`，Job 可标记为 `partial`；全部失败时外层返回 Tool error。
- 每个 Agent 和整个 Tool Result 都有 token/byte 上限。超限时公平分配结果预算并明确标记 `truncated`，不能让先完成的 Agent 占满全部上下文。

JSON 是 canonical contract；不增加 XML 包装。Renderer、trace 和测试可以直接消费相同结构，主 Agent 仍只把 `results[name]` 当作自然语言消息阅读。

## 4. 内部执行架构

### 4.1 共用执行原语

新增进程内 `SubagentExecutionService`：

```text
SubagentExecutionService.runOne(spec, parentContext)
        ▲                              ▲
        │                              │
  subagent_run Tool          SwarmCoordinator.runMany(specs)
                                       ▲
                                       │
                                 swarm_run Tool
```

`swarm_run` 不能通过反复调用公开的 `subagent_run` Tool 实现；当前 Tool Runner 按 Tool call 顺序串行执行，公开 Tool 嵌套既无法并发，也会重复权限和结果包装。SwarmCoordinator 应直接并发调用相同的内部 `runOne` 原语。

### 4.2 Backend-private Execution

一次嵌套 Agent 调用至少有一个 backend-private execution record：

```text
Subagent/Swarm Execution
  id（可从父 tool callId 派生）
  parentSessionId / parentRunId / parentCallId
  status
  source snapshot identity
  agent specs and frozen route assignments
  active child session/run handles
  cancellation controller
  token/time/concurrency totals
```

“一等后端任务”只表示它拥有稳定身份、生命周期、预算、取消和清理边界；不要求第一版增加公开 Job API、普通 Session 列表或独立任务中心。

轻量 Durable 记录用于：

- 关联隐藏子 Session 与父 Tool call。
- 应用退出或崩溃后识别 orphan，并将未完成 execution 标记为 `interrupted`。
- 汇总实际 route、usage、超时和安全错误。
- 保证父 Tool Result 已提交后再执行 retention 清理。

Active provider stream 仍不恢复；重启后不自动重试，以免产生不可见的重复费用。

### 4.3 隐藏 Durable Session

每个子 Agent 复用唯一生产 Session/Run loop，但其 Session 是内部成员：

- 不出现在普通 bootstrap、Session 分页、搜索或侧栏。
- 普通 domain/stream event 不直接灌入 Renderer replica；父 Tool card 只接收有界进度摘要。
- 可在 trace 或后续诊断入口检查，但不会成为可继续聊天的普通 Session。
- 父 Session 删除或 retention 到期时一并清理。
- 子 Session 固定 `permissionMode='readonly'`，Renderer、主 Agent 和 Tool 参数均不能覆盖。

Tool 层通过专用 port 调用执行服务，避免 `SessionToolRunner` 直接依赖 application service 或形成 runtime 构造循环。

## 5. 只读工具 Profile

普通 `readonly` Session 当前仍会向 Provider 描述全部工具，再在权限层拒绝副作用调用。子 Agent 应使用独立的 provider-visible 工具视图，只暴露明确 allowlist：

- `read_file`
- `list_dir`
- `glob`
- `grep`
- `git_status`
- `git_diff`
- `git_log`
- `git_show`
- Code Intelligence 读取能力
- Project get/detect
- `read_skill`
- 有界 `delay`

默认不暴露：

- 文件创建、修改、删除和 git write 工具。
- terminal、`run_command`、外部进程和持久后台任务。
- fetch、web search 和网络请求。
- MCP Tool，即使某个 MCP 自称只读。
- Goal/Plan 修改工具。
- `subagent_run` 和 `swarm_run`。

这一定义的是静态只读代码理解。运行 lint/test 即使理论上只读源码，也可能生成缓存、临时文件或启动子进程，后续必须作为单独的 sandbox review 模式设计。

## 6. Workspace Snapshot

所有子 Agent 必须读取 Tool 开始执行时的同一份稳定 snapshot：

- Snapshot 在当前 Tool batch 中此前的普通工具全部 settle 后创建。
- 同一 Swarm 的所有 Agent 共享一个 snapshot，不各自复制 workspace。
- Snapshot 位于 workspace 之外并受路径、文件数、字节和排除目录限制保护。
- Job 记录 HEAD、working tree diff/untracked digest 或等价 source identity。
- Snapshot 创建失败时，不启动任何子 Agent。
- 子 Agent 的文件工具只解析 snapshot 根目录；不能回退到 live workspace。

后续可增加“只审查 Git ref”和复用 snapshot cache，但第一版不允许十个 Agent 在可能变化的 live working tree 上各自读取不同状态。

## 7. 模型池与能力调度

设置保存命名模型池项，只引用现有 Provider 配置，不复制凭据：

```json
{
  "id": "strong-coder",
  "providerId": "provider-b",
  "model": "model-y",
  "reasoning": "high",
  "capability": "strong",
  "tags": ["reasoning", "large-context"],
  "maxParallel": 2
}
```

第一版能力等级固定为：

- `light`
- `standard`
- `strong`

能力由用户标注，系统不能根据模型名、价格或未经用户选择的 benchmark 自动判断。任务指定的是最低等级；Backend 只在满足条件的池项中 round-robin：

- 未指定等级时，在全部启用池项中轮换。
- 指定等级时，不静默降级到更弱模型。
- 同一等级没有可用模型时，在启动任何 Agent 前返回验证错误。
- 每个 Agent 整个 Run 固定一个 route；不能在 React loop 或 continuation 中途轮换模型。
- Job 创建时冻结 pool order、selection、Provider revision 和安全 route snapshot；配置热变更不改变已创建任务。
- 某个 Agent 失败时保留原 assignment，不自动换 Provider 重跑；Swarm 返回 partial result。

例如五个池项、十个没有等级偏好的 Agent，确定性分配为 A/B/C/D/E/A/B/C/D/E。

`tags` 第一版只用于展示和未来扩展；若要让主 Agent 按 `security`、`frontend`、`large-context` 等标签选择，需要另行扩充 Tool contract。

## 8. 并发、预算与 Tool Batch

### 8.1 全局并发

计划将新配置的 `maxConcurrentRuns` 默认值从 4 调整为 16，schema 硬上限继续保留 32。父 Run 本身占一个 slot，因此默认最多有 15 个子 Run 同时运行，足以支持十 Agent Swarm。

已有配置不能因为升级而静默把用户选择的 4 改为 16。启用 Swarm 时，设置页应在用户确认后把该值调整到推荐的 16。

SwarmCoordinator 使用有界队列而不是直接 `Promise.all`：

- `agentCount` 表示声明的 Agent 总数。
- `maxParallel` 表示同时运行的子 Agent 数。
- 实际并发还受全局剩余 slot 和每个 pool entry 的 `maxParallel` 限制。
- 全局上限为 1 时拒绝嵌套 Agent Tool，避免父 Run 占满唯一 slot 后死锁。
- 父 Run 取消时停止调度 queued Agent，并中断所有 active child Run。

### 8.2 Swarm 专用预算

普通主 Run 可不限 React 步数，但嵌套 Agent 必须有独立硬限制：

- 最大 Agent 数，第一版建议默认 5、可配置到 16。
- 每 Agent 最大步骤、墙钟时间、工具输出和结果 token。
- 整个 Tool 的总 prompt/completion token 与总墙钟上限。
- 聚合到父上下文的总 byte/token 上限。
- 超限、取消和 Provider failure 都进入对应 Agent meta。

### 8.3 `must_run_last` Batch Policy

新增通用 Tool 定义元数据：

```ts
batchPolicy?: 'normal' | 'must_run_last' | 'exclusive'
```

`subagent_run` 和 `swarm_run` 使用 `must_run_last`。Tool Runner 当前已经按 Provider 顺序串行执行，因此不需要并行执行重构，只需在执行任何 Tool 前增加批次预检：

- 一个 batch 最多包含一个非 `normal` Tool。
- `must_run_last` 必须是最后一个 Tool call。
- 不满足时整批不执行，为所有 call 生成有界 `INVALID_TOOL_BATCH` 结果，让模型重新发起。
- Backend 不自动重排 Provider 声明的 Tool call/result 顺序。
- Tool description 和 `/swarm` orchestration prompt 同时要求模型正确排序，后端校验是安全兜底。

允许：

```text
read_file → git_diff → swarm_run
```

拒绝：

```text
swarm_run → apply_patch
```

Snapshot 在 `swarm_run` 真正执行时创建，因此会包含本批次中此前已完成工具的结果。

## 9. 配置、隐私与 UI

建议配置项：

```text
subagents.enabled            默认 false
swarm.enabled                默认 false
swarm.maxAgents              默认 5，最大 16
swarm.maxParallel            默认受全局 slot 限制
swarm.workerTimeoutMs
swarm.maxStepsPerAgent
swarm.maxResultTokens
swarm.modelPool[]
```

设置页需要：

- 明确说明启用子 Agent 会产生额外 Provider 请求和费用。
- 展示模型池实际 Provider、模型、能力等级和并发限制。
- Swarm 启用时列出会接收 workspace 内容的所有 Provider，并要求现有 Provider privacy notice 已接受。
- 提示把全局并发调整为 16，但必须由用户确认保存。

第一版 UI 只需要：

- 设置页的 Subagent/Swarm 开关、预算和模型池。
- `/swarm` 自动补全与禁用提示。
- 父 ToolCallCard 中显示 queued/running/completed/failed 数量、取消入口和最终 JSON 结果投影。
- NMessage 只报告后台降级或失败，不承载持续任务状态。

子 Agent 详细 Session 不进入普通会话列表。后续确有诊断需求时，可在 ToolCallCard 内增加只读 transcript 查看入口。

## 10. 实施阶段

### S1 · Subagent Execution Foundation

- 定义 shared Tool contract、结果 schema、能力等级和 backend-private execution 类型。
- 增加隐藏 Durable Session 归属关系与 retention。
- 实现稳定 workspace snapshot。
- 实现 `SubagentExecutionService.runOne`、取消传播和只读工具 profile。
- 隔离子 Session event，父 Run 只接收有界进度。

验收：

- 一个子 Agent 可使用父 Session 当前模型读取 snapshot 并返回自由文本。
- 任何写入、process、terminal、network、MCP 或递归 Agent Tool 都不可见且不可执行。
- 父 Run 取消、应用 dispose、Provider failure 后没有 active child handle 或泄漏 Session。

### S2 · Generic `subagent_run`

- 注册默认关闭的 `subagent_run` Tool。
- 增加 `must_run_last` 通用批次预检。
- 返回单条目的 `results/meta` JSON envelope。
- 增加每调用的 timeout、step、token、结果大小和 usage 统计。
- 将新配置默认并发调整为 16，保留硬上限 32。

验收：

- 普通主 Agent 可委派代码结构、文件定位或局部审查任务，并继续消费标准 tool role。
- 非末位调用在任何其他 Tool 执行前被稳定拒绝。
- 子 Agent 名称、JSON 注入、超长结果、取消和失败分支有回归覆盖。

### S3 · Model Pool

- 设置页支持 pool entry、Provider/model/reasoning、能力等级和并发限制。
- Job preflight 原子验证 Provider、credential、model 和 revision。
- 实现确定性 round-robin、route freeze 和 usage attribution。
- 启用 Swarm 时提供全局并发调整确认。

验收：

- 五个模型、十个同等级 Agent 精确分配为每个模型两次。
- strong 任务不降级给 light 模型。
- 配置在 queued 期间变化不会静默改变 assignment。

### S4 · `/swarm` 与 `swarm_run`

- 增加 `/swarm` 解析、单 Run capability 和版本化 prompt resource。
- `swarm_run` 接收具名 Agent 数组并并发调用 `runOne`。
- 实现全局/per-model 并发队列、partial result、总预算和公平截断。
- 返回多条目的 `results/meta` JSON envelope，由主 Agent 在原 Run 汇总。

验收：

- 未启用、非 `/swarm` Run、重复调用和 capability 重放均被 Backend 拒绝。
- 十个只读 Agent 可在有界并发下完成，主 Session 只出现一个 Tool call/result 和最终 Assistant 回复。
- 一个或部分 Provider 失败不丢失其他 Agent 结果；全部失败返回 Tool error。

### S5 · Hardening 与体验

- 完善退出、崩溃、interrupted execution 和 orphan retention。
- ToolCallCard 展示汇总进度、模型分配、部分失败和截断信息。
- 增加 source identity、trace correlation、usage/cost 汇总和敏感信息检查。
- 验证大仓库 snapshot、长结果、慢 Provider、并发取消和 Renderer reload。

验收：

- 子 Session 永不污染普通 bootstrap、搜索、侧栏和 run overlay。
- Renderer reload 不影响 Tool 执行；应用重启不自动重复产生 Provider 费用。
- trace 可以从父 call 定位所有子 route、usage 和安全终态，但不包含凭据或 reasoning。

## 11. 测试与发布门禁

至少覆盖：

- `subagent_run` 成功、失败、取消、超时和结果截断。
- 子 Agent write/process/terminal/network/MCP/递归 Tool 不可见且后端拒绝绕过。
- `must_run_last` 合法与非法批次，非法批次不得产生任何前置副作用。
- 父 Run slot、全局 16 默认、per-model 并发和 limit=1 防死锁。
- 五模型十 Agent round-robin、能力不足、credential 缺失和 revision 变化。
- 稳定 snapshot、dirty working tree、snapshot 失败和所有 Agent 读取相同 source identity。
- JSON 名称去重、保留键、Unicode 名称、partial/all-failed 和公平结果预算。
- 父取消传播、Renderer reload、app dispose、crash 后 interrupted 清理。
- 普通 Session bootstrap/search 不返回隐藏子 Session，普通 agent event 不泄漏到 renderer replica。
- `/swarm` capability 只能使用一次且不能从历史或子 Agent 继承。

每阶段完成后执行 `npm run verify`。真实 Provider、benchmark、Docker worker 和外部集群测试保持显式 opt-in，不进入默认门禁。

## 12. 后续扩展

以下方向在本阶段明确延后：

- 主 Agent 对指定子 Agent 继续追问的 `subagent_continue`。
- 共享缓存、snapshot 复用和跨 Job 结果索引。
- 模型能力 tag 自动选择与经过用户批准的 benchmark 辅助标注。
- 允许只读 MCP 的独立 trust/capability 协议。
- 可运行测试的隔离 sandbox reviewer。
- 多机器 Worker、claim lease、heartbeat、远程 trace/artifact 上传和断线重试。
- Swarm 模板、角色市场、投票、模型间辩论或自动应用修改。

如果未来扩展到多机器，继续复用 `SubagentExecutionSpec`、Job/Agent ID、route snapshot 和 JSON result contract；远程 Worker 只替换执行 transport，不能复制 Agent loop、Prompt Harness、权限或 ModelProvider。
