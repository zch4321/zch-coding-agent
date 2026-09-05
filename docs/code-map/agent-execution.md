# Subagent、Swarm 与后台任务

返回[总地图](./README.md)。规范见 [Agent execution](../architecture/agent-execution.md)，演进背景见[相关决策](../decisions/agent-execution.md)。

## 职责与边界

Agent start Tool 返回后台 handle；execution service 持有独立 worker，复用同一 Session/Run loop。Swarm coordinator 冻结 assignment、原子预留所有 child 并汇总结果。Background service 把 Agent 与 Terminal 暴露为统一模型接口。

## 关键入口

| 文件 / 符号                                                                                                                                                    | 责任                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [subagent-tools.ts](../../electron/tools/subagent-tools.ts)、[swarm-tools.ts](../../electron/tools/swarm-tools.ts)                                             | schema、effects 与启动适配                           |
| [subagent/execution-service.ts](../../electron/subagent/execution-service.ts)                                                                                  | prepare、隐藏 Session、worker timeout、结果和取消    |
| [swarm/coordinator.ts](../../electron/swarm/coordinator.ts) / `SwarmCoordinator`                                                                               | root/child 准备、manifest、并发启动与聚合            |
| [model-pool/allocator.ts](../../electron/model-pool/allocator.ts)、[freezer.ts](../../electron/model-pool/freezer.ts)                                          | 能力匹配、分配与 route 冻结                          |
| [subagent-state-service.ts](../../electron/application/subagent-state-service.ts)、[subagent-repository.ts](../../electron/persistence/subagent-repository.ts) | Durable execution、幂等 identity 和 active leaf 容量 |
| [background/service.ts](../../electron/background/service.ts)、[agent-handle-registry.ts](../../electron/background/agent-handle-registry.ts)                  | wait/list/cancel、进程内数字 target 与 ownership     |
| [background-tools.ts](../../electron/tools/background-tools.ts)                                                                                                | 模型侧后台操作及分页输出                             |
| [agent-execution-query-service.ts](../../electron/application/agent-execution-query-service.ts)                                                                | 公开详情、统计和 hidden identity 过滤                |
| [agent-executions.ts](../../src/stores/agent-executions.ts)、[AgentsTab.vue](../../src/components/artifacts/AgentsTab.vue)                                     | Renderer root/child 副本和 live activity             |

## 主要调用链

```text
subagent_run / swarm_run → ordered Tool preparation
  → freeze toolAccess/routes → durable reservation + leaf capacity
  → initialize artifacts → return numeric BackgroundTaskHandle
  ⇢ execution-owned worker → hidden Session → shared Run loop
  ⇢ state/result/artifacts → safe events and public queries
background_wait/list/cancel → owner-checked target → execution / PTY
```

Swarm 启动前整体冻结并预留，不逐个 child 边收费边发现容量不足。后台 worker 不占用父 Tool body 的生命周期。

## 状态与契约

Durable execution 与 hidden Session 在 SQLite，公开契约在 [agent-execution.ts](../../shared/agent-execution.ts) 和 [swarm.ts](../../shared/swarm.ts)。数字 target 仅当前进程有效，重启后通过 list 重新获取；artifact 可修改、过期或失败，不能作为任务状态依据。

父 Run 结束/取消不终止已启动后台任务。显式取消、timeout、Session/Project 清理与 app dispose 才收敛 worker；重启将遗留 active execution 标为 interrupted，不自动重试 Provider。

## 修改指引

- 修改取消：从 Background service 到 coordinator/execution-owned AbortController，覆盖 root、单 child、排队与已结束 target，不引入父 Run 的旧级联语义。
- 修改权限：同时查 catalog 和 SessionManager child profile；`inherit` 不扩大父权限，recursive Agent/Goal/Plan 工具必须隐藏且拒绝伪造调用。
- 修改统计：区分 durable detail 快照、live activity 和 root 聚合，查看[开放问题](../open-design-questions.md)中运行时计数的已知差异。
- 修改模型池：Provider metadata 是 capability 来源；保持参数 hash 幂等、原子预留和冻结后不重分配。

## 验证入口

| 测试                                                                                                                                         | 验证内容                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [execution-service.test.ts](../../electron/subagent/execution-service.test.ts)                                                               | child 生命周期、权限、结果与隔离   |
| [coordinator.test.ts](../../electron/swarm/coordinator.test.ts)                                                                              | 分配、容量、部分失败与取消         |
| [background/service.test.ts](../../electron/background/service.test.ts)                                                                      | 混合 target、owner、wait 和 cancel |
| [agent-handle-registry.test.ts](../../electron/background/agent-handle-registry.test.ts)                                                     | 数字 handle 的进程内映射           |
| [agent-execution-query-service.test.ts](../../electron/application/agent-execution-query-service.test.ts)                                    | 安全投影和统计                     |
| [agent-executions.test.ts](../../src/stores/agent-executions.test.ts)、[AgentsTab.test.ts](../../src/components/artifacts/AgentsTab.test.ts) | root/child 状态、展开和事件        |
