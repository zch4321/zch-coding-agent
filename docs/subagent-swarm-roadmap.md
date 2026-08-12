# Subagent 与 Swarm Roadmap

> 状态：P13 已完成 S1 · Subagent Execution Foundation、S2 · Generic `subagent_run`、S3 · Model Pool 与 S4 · Desktop Swarm。当前进入 S5 hardening；Headless 明确不暴露普通 Swarm Tool。ProjectModel/Serena/code intelligence 已临时关闭，其 SQLite 迁移排在 S5 完成之后。
>
> 已实现的稳定契约见 [`architecture.md`](./architecture.md) 与 [`requirements.md`](./requirements.md)。本文只保留尚未完成的演进方向，避免同时维护两套事实来源。

---

## 1. 已完成基线

P13 已提供默认关闭的单子 Agent 能力：

- `subagent_run` 的公开输入固定为 `{ name, task }`；`task` 作为子 Session 的普通 canonical `user_input`，不复制父 Session 历史。
- 子 Agent 复用唯一 Session/Run/Provider loop，精确继承父 Run 已冻结的 main/compression route。
- 每次执行直接读取父 Run 的 live workspace，只能使用明确列出的只读工具，不创建文件/Git snapshot 或 refs。
- `subagent_run` 是 parallel Tool；同批可有多个调用，准备/审批和结果提交按 call 顺序，Tool body 可并发。
- 隐藏 Session 与 execution 使用 SQLite durable ownership；不进入普通 bootstrap、分页、搜索、导出或 Renderer 事件。
- 父 Run 取消、30 分钟默认 worker timeout、Provider failure 与应用退出都会中断子 Run 并释放全局 Run slot。
- 子 Agent 沿用全局 `maxStepsPerRun`、模型最大输出和通用 Tool context 限制，没有专属 step/token/result 预算。
- Execution 内部保留 `results/meta`；父模型的 canonical Tool Result 只接收 `results[name]` 最终文本，Provider/model/usage 不重复进入上下文。
- Desktop 与 Headless 共用相同实现；父对话继续显示普通 ToolCallCard。

这些约束是后续 Model Pool 和 Swarm 的底座，不在后续阶段复制第二套 Session、Provider、Tool executor 或恢复逻辑。

## 2. S3 · Model Pool（已完成）

### 2.1 目标

允许用户建立只引用现有 Provider 配置的命名模型池，为 Swarm 的多模型调度提供确定性 route assignment。模型池不复制 API key，也不改变 `subagent_run({ name, task })` 的公开输入。

建议的 pool entry 至少包含：

```json
{
  "id": "strong-coder",
  "providerId": "provider-b",
  "model": "model-y",
  "reasoning": "high"
}
```

能力等级第一版固定为 `light | standard | strong`，由用户在 Provider 的 per-model metadata 中显式标注；pool entry 只引用模型，不复制标注。系统不根据模型名、价格或未经用户确认的外部评估自动推断能力。

### 2.2 已完成的 backend foundation

- AppConfig v16 增加默认空的 `modelPool.entries`；v17 保留并迁移合法 v16 pool，同时加入显式 approval reasoning 和六档 pool reasoning；v18 删除 entry 中重复的 capability；v19 再删除从未执行的 per-route `maxParallel`，并在 `subagents` 增加 `maxAgentsPerSwarm`。当前 v20 只新增 command shell 配置，不改变模型池或 Swarm 结构。v16–v18 升级会规范化 pool 并移除旧冗余字段。Headless 外部配置保持 v4；Runtime Identity v5 新增显式 `swarmsEnabled`，当前 Headless 固定为 `false`。
- `config:set(model-pool)` 使用完整数组和精确 Provider revision 覆盖做一次性校验与原子写盘。enabled entry 的调度能力从 Provider `modelOverrides[model].capability` 读取，缺少标注时拒绝保存；disabled entry 可以保留失效引用。Provider 删除、模型移出 `enabledModelIds`、移除 capability annotation、reasoning annotation 变为不兼容或显式清除凭据时只自动禁用受影响项，恢复后不会自动重启用。
- 纯 allocator 只接收能力需求序列。每项需求可使用能力大于或等于 `requiredCapability` 的任意模型；先按稳定声明顺序 round-robin `Provider + model`，再轮询该模型已选的精确 reasoning route，避免选择更多 reasoning 叶节点的模型获得更高权重。每次调用重置 cursor，`strong` 不向下降级；符合要求的模型少于 Agent 数时自然重复使用模型。
- route freezer 只读取一次 PublicConfig 快照，对所有 enabled entry 与 Provider revision 计算顺序敏感 digest，并对实际选中的每个唯一 entry 解析一次 main/compression pair。prepared plan 只在 backend 内存持有 API key；safe snapshot 只包含 assignment、revision 和安全 route，不含 API key 或 credential reference。
- `subagent_run` 继续通过 `runOne` 精确继承父 Run route；Swarm 则通过 backend-private `runPrepared` 消费冻结 assignment。全局 Run coordinator 为 Swarm child 提供可取消 FIFO 等待，SQLite v8 持久化 Job root、child ordinal、assignment 安全快照和终态。

### 2.3 调度规则

- Job 创建时将复用现有 freezer，冻结 pool digest、Provider revision、模型、reasoning 与安全 route snapshot，并仅在 backend-private prepared plan 中持有已解析凭据；配置热变更不影响已排队或运行的 assignment。
- 所有满足 `actualCapability >= requiredCapability` 的模型按稳定顺序参与 round-robin；先均匀遍历 `Provider + model`，再遍历同一模型的 reasoning route。需要更强能力时不得静默降级。
- 每个 Agent 整个 Run 固定一条 route，不能在 React loop 或 continuation 中途轮换模型。
- 某个 assignment 失败时保留原模型信息，不自动切换 Provider 重跑，避免重复费用和不可审计结果。
- 模型池不保存并发配额。Job 需要的 Agent 总数由 `swarm_run` 输入声明并受 `subagents.maxAgentsPerSwarm` 约束；实际同时执行数仍必须取得全局 Run slot。

### 2.4 配置与 UI（已完成）

- Agents 设置页已经提供基于 Naive UI Transfer/Tree 的 `Provider → model → reasoning` 自定义树形穿梭框；每个 reasoning 叶节点对应一条精确 route，同一模型的多个 reasoning 可以同时入池且互不 fallback。最低 reasoning 下拉栏只筛选左侧候选，已选低档 route 继续显示并提示；模型池不再提供 per-route 并发配置。能力等级继续只在 Provider 模型配置中维护，pool UI 只读展示该标注，内部 ID/顺序/enabled 不作为常规配置项暴露。
- 同页 Subagent 设置提供 `maxAgentsPerSwarm`，默认 10、范围 1–32；它限制单次 Swarm 创建的 child Agent 总数，不等同于同时运行数。`limits.maxConcurrentRuns` 继续限制全应用同时 active 的 Run，且主 Run 自身占一个 slot。
- Renderer 使用独立模型池 store 保存草稿，并通过单次完整数组请求校验 Provider、credential binding、模型、能力标注和 revision；无效配置不能部分生效。Provider 编辑导致持久化 entry 自动禁用时不会静默覆盖 dirty 草稿。
- UI 明确提示每个模型会读取当前 workspace 内容并产生额外 Provider 请求；执行时冻结的 pool digest、assignment、Provider revision 和安全 route snapshot 保存在 durable Job/child execution 中，凭据只存在于 backend 内存。
- Runtime Identity v5 显式记录宿主是否支持 Swarm。当前生成 identity artifact 的 Headless 保持外部 config v4 且 `swarmsEnabled = false`；Desktop 直接支持普通 Swarm Tool，因此不需要把 Desktop Job assignment 混入 Headless artifact identity。

### 2.5 验收

- 五个满足能力要求的模型、十个 Agent 可确定性分配为每个模型两次；同一模型选择多个 reasoning route 不会提高该模型的分配权重。
- `strong` 任务在没有可用强模型时于启动任何 Agent 前失败，不交给 `light`。
- queued 期间修改配置不会改变既有 assignment。
- API key 仍只在主进程内存中解析，不进入 pool 配置、execution、trace 或 Tool Result。

上述 allocator/freezer、配置/UI、prepared execution 与冻结后配置热变更均已有回归覆盖，S3 已完成。

## 3. S4 · 普通 `swarm_run` Tool（Desktop 已完成）

### 3.1 产品语义

满足运行条件的 Desktop 主 Run 会把 `swarm_run` 作为普通 Tool 暴露给 Provider；`/swarm <目标>` 只保留为用户显式请求 Swarm 的编排快捷命令，不再授予一次性 capability。普通消息可以使用该工具，历史重放、子 Agent 和 Headless 仍不能继承或伪造它。Tool description 要求用户未明确提出 Swarm、多 Agent、并行调查或独立交叉检查时不得主动调用；每次调用使用 review risk 进入人工审批，包括 YOLO 模式。

`swarm_run` 接收一组具名、自包含的只读调查任务。主 Agent 负责拆分任务；Backend 负责校验、冻结 assignment、排队、取消和聚合结果。SwarmCoordinator 直接调用 backend-private `PreparedSubagentExecutionPort.runPrepared`，不通过循环调用公开 `subagent_run` Tool，也不允许 child 获得递归编排能力。

每个任务由主 Agent 显式声明内容、最低能力与 Agent 数，不增加另一套含义重叠的“难度”字段：

```ts
swarm_run({
  tasks: [
    {
      name: 'security-review',
      task: '独立检查认证与权限边界，并给出证据。',
      requiredCapability: 'strong',
      agentCount: 2,
    },
  ],
})
```

- `requiredCapability` 必填且只允许 `light | standard | strong`，Backend 不根据任务文本、模型名或价格猜测能力。
- `agentCount` 必须为 `1..frozenMaxAgentsPerSwarm`。Provider 可见的 `swarm_run` schema 在普通主 Run 启动时按当时的 `subagents.maxAgentsPerSwarm` 生成，因此 JSON Schema 的 `maximum` 会直接显示用户设置；设置变化从下一次 Run 生效，不能改写 active Run 已看到的工具契约。
- 多个 task 的 `agentCount` 总和也不得超过同一冻结上限。JSON Schema 无法表达跨数组元素求和，Backend 必须在创建 Job 前再次校验并整体拒绝超限输入；XML tag 只可作为冗余提示，不能成为权限或上限的权威来源。
- Tool description 偏好每个 task 默认使用 1 个 Agent；只有需要独立交叉验证、不同调查视角或高风险复核时才增加数量，并选择足以完成任务的最低 `requiredCapability`，不能因为上限较大就主动占满。

### 3.2 运行边界

- 同一 Swarm 的 Agent 绑定相同 canonical workspace，并在各自读取时观察 live 状态；本阶段不重新引入 source identity 或冻结 snapshot。
- Job 会先原子创建 root 与全部 queued child，再并发等待执行；真正 active 的 child 必须通过全局 Run coordinator 的可取消 FIFO 队列取得空闲 slot。冻结的 Job Agent 总数限制待调度规模，全局 `maxConcurrentRuns` 限制实际并发，模型池不再提供 per-route 并发配额。
- 全局 `maxConcurrentRuns = 1` 时在启动前拒绝，避免父 Run 占满唯一 slot。
- 同一父 Run 的多个 `swarm_run` Job 严格串行；不同父 Run 的 Job 可以同时排队和运行。普通 Run 与 `subagent_run` 继续 fail-fast，不因 Swarm 引入等待语义。
- 父 Run 取消或应用退出时停止 queued assignment，并中断所有 active child Run。
- worker timeout 从 child 取得 slot 后开始计算，排队时间不消耗执行时限。每个 child 继续沿用全局 `maxStepsPerRun`、对应模型的最大输出和通用 Tool 输出限制；不增加重复的 per-agent step/token/result 配置。
- Job 可以返回 partial result；单个 Provider 失败不丢弃其他成功结果，也不自动重试。

### 3.3 结果契约

Swarm 结果使用稳定的扁平 `results[] + meta` 契约：

- `results` 按 task 声明顺序和 replica 序号保存每个 Agent，包含 `taskIndex/agentIndex/name/status`、成功文本或有界错误、冻结 assignment、耗时、usage 与截断标记；失败不会改变兄弟项顺序。
- `meta` 保存 `completed|partial` Job 状态、Agent/成功/失败数量、总耗时和聚合 usage。只要至少一个 child 成功就返回完整或 partial 结果；全部失败返回明确 Tool error。
- 不返回 reasoning、endpoint、凭据、子 Session ID、trace 路径、workspace 绝对路径或完整工具轨迹。
- 主 Agent 在原 Run 中消费一个标准 Tool Result 并向用户汇总，不启动第二个聚合 Run。
- Tool Result 总 JSON 上限为 2 MB；超限时按各响应或错误正文的 UTF-8 字节公平收窄并标记 `truncated`，不删除 Agent 条目。

### 3.4 验收

- 未启用、运行条件不足、child/Headless 调用与普通 catalog 之外的伪造调用均在 Provider/Tool 执行前被拒绝。所有权限模式逐次展示专用 Swarm 审批卡；同一父 Run 可多次调用但 Job 严格串行，同一 call ID 和相同参数可幂等复用，参数不同明确冲突。
- 十个只读 Agent 可在有界并发下完成，主 Session 只出现一个 Swarm Tool call/result 和最终 Assistant 回复。
- 所有 Agent 绑定相同 canonical workspace；部分失败保留成功结果，全部失败返回明确 Tool error。
- Renderer reload 不暴露隐藏 Session，也不影响后台 Job 收敛。

## 4. S5 · Hardening 与体验（下一阶段）

- Agents artifact 已使用两级 `NCollapse` 展示 Swarm Job → child Agent，完全手动展开，只显示统计和可见 Assistant 文本；后续评估在主时间线 ToolCallCard 增加 queued/running/completed/failed 汇总、模型 assignment、部分失败和截断。
- 完善 live workspace 变更提示、父 call 到 child usage 的诊断关联和成本汇总。
- 覆盖慢 Provider、排队取消、应用崩溃、Renderer reload 与长结果的压力测试。
- 评估取消入口和更完整的只读诊断视图，但 child Session 仍不可继续聊天，也不进入普通 Session 列表。

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
- parallel/serial Tool 调度持续保持串行屏障、单审批和原 call 顺序结果；未知 Tool 默认 serial。
- route、canonical workspace、assignment、usage 和终态可审计，但凭据、reasoning 与 workspace 绝对路径不落盘、不回传。
- 隐藏 Session 不进入 bootstrap、分页、搜索、导出、普通事件或侧栏；父/Project 删除级联清理，归档保留。
- 重启只把遗留 active execution 标记为 `interrupted`，不恢复 stream、不自动重试 Provider。
- Desktop 与 Headless 继续复用唯一 runtime，并用 fake-provider trajectory 验证一致性。

每阶段完成后运行日常门禁 `npm run check`；准备合并或发布时运行完整门禁 `npm run verify`。真实 Provider、benchmark、Docker worker 和其他付费测试保持显式 opt-in。

## 7. 明确延后

- `subagent_continue` 与对子 Agent 的多轮追问。
- 子 Agent 之间通信、递归委派、投票、辩论或自动应用修改。
- 允许 child 运行测试、终端、命令、网络或只读 MCP 的隔离 sandbox profile。
- 自定义 child 工具列表；当前 `subagents.enabled` 仅保留功能开关。
- 共享结果索引、跨 Job 调查缓存和自动能力评估。
- 多机器 Worker、claim lease、heartbeat、远程 artifact/trace 上传和断线恢复。
