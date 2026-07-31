# Subagent 与 Swarm Roadmap

> 状态：P13 已完成 S1 · Subagent Execution Foundation 与 S2 · Generic `subagent_run`；下一阶段是 S3 · Model Pool，Swarm 尚未实现。ProjectModel/Serena/code intelligence 已临时关闭，其 SQLite 迁移排在 Swarm 完成之后。
>
> 已实现的稳定契约见 [`architecture.md`](./architecture.md) 与 [`requirements.md`](./requirements.md)。本文只保留尚未完成的演进方向，避免同时维护两套事实来源。

---

## 1. 已完成基线

P13 已提供默认关闭的单子 Agent 能力：

- `subagent_run` 的公开输入固定为 `{ name, task }`；`task` 作为子 Session 的普通 canonical `user_input`，不复制父 Session 历史。
- 子 Agent 复用唯一 Session/Run/Provider loop，精确继承父 Run 已冻结的 main/compression route。
- 每次执行读取 workspace 外的稳定文件/Git snapshot，只能使用明确列出的只读工具。
- Tool batch 在任何调用、审批或插件 hook 前统一预检；`subagent_run` 必须是本批最后一个调用。
- 隐藏 Session 与 execution 使用 SQLite durable ownership；不进入普通 bootstrap、分页、搜索、导出或 Renderer 事件。
- 父 Run 取消、30 分钟默认 worker timeout、Provider failure 与应用退出都会中断子 Run 并清理 snapshot。
- 子 Agent 沿用全局 `maxStepsPerRun`、模型最大输出和通用 Tool context 限制，没有专属 step/token/result 预算。
- Execution 内部保留 `results/meta`；父模型的 canonical Tool Result 只接收 `results[name]` 最终文本，Provider/model/usage 不重复进入上下文。
- Desktop 与 Headless 共用相同实现；父对话继续显示普通 ToolCallCard。

这些约束是后续 Model Pool 和 Swarm 的底座，不在后续阶段复制第二套 Session、Provider、snapshot、Tool executor 或恢复逻辑。

## 2. S3 · Model Pool（下一阶段）

### 2.1 目标

允许用户建立只引用现有 Provider 配置的命名模型池，为未来 Swarm 的多模型调度提供确定性 route assignment。模型池不复制 API key，也不改变当前 `subagent_run({ name, task })` 的公开输入。

建议的 pool entry 至少包含：

```json
{
  "id": "strong-coder",
  "providerId": "provider-b",
  "model": "model-y",
  "reasoning": "high",
  "capability": "strong",
  "maxParallel": 2
}
```

能力等级第一版固定为 `light | standard | strong`，由用户显式标注。系统不根据模型名、价格或未经用户确认的外部评估自动推断能力。

### 2.2 调度规则

- Job 创建时冻结 pool 顺序、Provider revision、模型、reasoning、credential reference 与安全 route snapshot；配置热变更不影响已排队或运行的 assignment。
- 相同能力等级内按稳定顺序 round-robin；需要更强能力时不得静默降级。
- 每个 Agent 整个 Run 固定一条 route，不能在 React loop 或 continuation 中途轮换模型。
- 某个 assignment 失败时保留原模型信息，不自动切换 Provider 重跑，避免重复费用和不可审计结果。
- `maxParallel` 只约束对应 pool entry；实际执行还必须取得全局 Run slot。

### 2.3 配置与 UI

- Agents 设置页增加 pool entry 的增删、排序、启停、Provider/model/reasoning、能力等级与并发配置。
- 保存前一次性校验 Provider、credential reference、模型和 revision；无效配置不能部分生效。
- UI 明确展示每个模型会接收 workspace snapshot 内容并产生额外 Provider 请求。
- Runtime Identity 记录模型池 digest 和调度能力，方便 Headless 结果比较。

### 2.4 验收

- 五个同等级模型、十个任务可确定性分配为每个模型两次。
- `strong` 任务在没有可用强模型时于启动任何 Agent 前失败，不交给 `light`。
- queued 期间修改配置不会改变既有 assignment。
- API key 仍只在主进程内存中解析，不进入 pool 配置、execution、trace 或 Tool Result。

## 3. S4 · `/swarm` 与 `swarm_run`

### 3.1 产品语义

`/swarm <目标>` 为当前 Run 创建一次性 orchestration capability。只有持有该 capability 的主 Agent 才能看到和调用 `swarm_run`；历史消息、普通 Run 和子 Agent 不能继承或重放它。

`swarm_run` 接收一组具名、自包含的只读调查任务。主 Agent负责拆分任务；Backend 负责校验、冻结 assignment、共享 snapshot、排队、取消和聚合结果。SwarmCoordinator 直接并发调用现有 `SubagentExecutionPort.runOne` 原语，不通过循环调用公开 `subagent_run` Tool 实现。

### 3.2 运行边界

- 同一 Swarm 的 Agent 共享一次稳定 snapshot 和 source identity。
- 调度使用有界队列，受全局 Run slot、pool entry `maxParallel` 和 Job 最大 Agent 数约束；不能直接无界 `Promise.all`。
- 全局 `maxConcurrentRuns = 1` 时在启动前拒绝，避免父 Run 占满唯一 slot。
- 父 Run 取消或应用退出时停止 queued assignment，并中断所有 active child Run。
- 每个 child 继续沿用全局 `maxStepsPerRun`、对应模型的最大输出和通用 Tool 输出限制；不增加重复的 per-agent step/token/result 配置。
- Job 可以返回 partial result；单个 Provider 失败不丢弃其他成功结果，也不自动重试。

### 3.3 结果契约

Swarm 结果沿用单子 Agent 的 `results/meta` 思路：

- `results` 按声明顺序保存每个具名 Agent 的最终文本或失败状态。
- `meta` 保存 Job 状态、实际 Provider/model、耗时、标准化 usage、截断和有界错误。
- 不返回 reasoning、endpoint、凭据、子 Session ID、trace 路径、临时绝对路径或完整工具轨迹。
- 主 Agent 在原 Run 中消费一个标准 Tool Result 并向用户汇总，不启动第二个聚合 Run。

具体多 Agent JSON schema、失败值表示和 Job 级上限在 S4 实现计划中冻结；不提前改变 P13 的单 Agent contract。

### 3.4 验收

- 未启用、非 `/swarm` Run、重复调用和 capability 重放均在 Provider/Tool 执行前被拒绝。
- 十个只读 Agent 可在有界并发下完成，主 Session 只出现一个 Swarm Tool call/result 和最终 Assistant 回复。
- 所有 Agent 读取相同 source identity；部分失败保留成功结果，全部失败返回明确 Tool error。
- Renderer reload 不暴露隐藏 Session，也不影响后台 Job 收敛。

## 4. S5 · Hardening 与体验

- 在现有 ToolCallCard 内展示 queued/running/completed/failed 汇总、模型 assignment、部分失败和截断；不新增普通 Session 入口。
- 完善大仓库 snapshot 复用、orphan retention、父 call 到 child usage 的诊断关联和成本汇总。
- 覆盖慢 Provider、排队取消、应用崩溃、Renderer reload 与长结果的压力测试。
- 评估只读 transcript 诊断入口，但 child Session 仍不可继续聊天。

## 5. S6 · ProjectModel SQLite 与 Serena 恢复（Swarm 之后）

### 5.1 当前暂停边界

- Desktop 与 Headless 的生产 runtime 不装配 ProjectMetadataStore 或 CodeBackendManager，不注册 `project_*`/`code_*` Tool，也不启动 Serena。
- ProjectModel/Serena artifact UI 暂停；保留的旧 IPC contract 只返回 `NOT_AVAILABLE`，用于让旧 renderer 明确失败，而不是退回 workspace 文件。
- 普通 Session 仅在内存中做有界、只读的 module marker 探测；应用不得读取、创建或改写 `.zch/project-model.json`。用户已有 `.zch` 保持原样。

这段暂停状态持续到 S3 Model Pool、S4 Swarm 和 S5 hardening 完成，避免在并发编排期间同时重做项目状态所有权。

### 5.2 迁移目标

- 在 `userData/agent.db` 增加由稳定 `projectId` 归属的 versioned ProjectModel record；revision、schema 校验和更新走现有 Backend coordinator/transaction，不在 Session 或 Renderer 自行落盘。
- ProjectModel query/command 经共享 schema 和 IPC boundary 暴露；Renderer 重建 Project tab 时只消费 backend public record，不能直接接触 workspace metadata 文件。
- Serena/其他 code backend 的配置引用 SQLite ProjectModel；backend process、status 和 stderr tail 仍是主进程 live state，不把 pid 或原始日志当成 durable ProjectModel。
- legacy `.zch/project-model.json` 仅支持用户显式触发的一次性导入：先有界读取和完整校验，再用事务写入 SQLite；冲突时要求用户选择，不能静默覆盖。
- 成功导入后不删除、不改名、不续写旧 `.zch`。可提示用户自行归档或删除，但 Application 不自动修改 workspace 或 `.gitignore`。
- 只有 SQLite service、迁移/导入、IPC、UI 和 Tool 双重校验全部完成后，才重新注册 `project_*`/`code_*` 和启动 Serena；不能恢复半套路径。

### 5.3 验收

- 新建项目、打开 Session、运行 main/child/swarm 均不会创建 `.zch`；未恢复前所有 Provider catalog 都不含 `project_*`/`code_*`。
- SQLite ProjectModel 与 Project 删除级联、目录重关联、revision 冲突、备份/恢复和 Renderer reload 行为有持久化回归测试。
- 合法 legacy 文件可显式导入一次；损坏、超限、workspace 不匹配和 revision 冲突均无部分写入，原文件始终不变。
- Serena 恢复后只能读取 SQLite 配置；禁用/不可用时 catalog 与 executor 都拒绝伪造的 `code_*` 调用。

## 6. 持续不变量与发布门禁

后续阶段必须持续覆盖：

- write/process/terminal/network/MCP/code intelligence/递归 Agent Tool 对 child 不可见，伪造调用也由 executor 拒绝。
- 特殊 Tool batch 的非法位置在任何前置调用、审批或插件 hook 前拒绝整批。
- route、source identity、assignment、usage 和终态可审计，但凭据、reasoning 与临时路径不落盘、不回传。
- 隐藏 Session 不进入 bootstrap、分页、搜索、导出、普通事件或侧栏；父/Project 删除级联清理，归档保留。
- 重启只把遗留 active execution 标记为 `interrupted`，不恢复 stream、不自动重试 Provider。
- Desktop 与 Headless 继续复用唯一 runtime，并用 fake-provider trajectory 验证一致性。

每阶段完成后只运行常规完整门禁 `npm run verify`。真实 Provider、benchmark、Docker worker 和其他付费测试保持显式 opt-in。

## 7. 明确延后

- `subagent_continue` 与对子 Agent 的多轮追问。
- 子 Agent 之间通信、递归委派、投票、辩论或自动应用修改。
- 允许 child 运行测试、终端、命令、网络或只读 MCP 的隔离 sandbox profile。
- 自定义 child 工具列表；当前 `subagents.enabled` 仅保留功能开关。
- 共享结果索引、跨 Job snapshot cache 和自动能力评估。
- 多机器 Worker、claim lease、heartbeat、远程 artifact/trace 上传和断线恢复。
