# Runtime、Session 与 Run

返回[总地图](./README.md)。约束见 [Session 规范](../architecture/sessions.md)与[依赖边界](../architecture/boundaries.md)。

## 职责与边界

Runtime 组装可复用的 Node Agent；SessionManager 管理 live Session，RunController 驱动一次执行。Application service 负责 durable command、事务和 Runtime 协调；IPC 只适配宿主边界。

## 关键入口

| 文件 / 符号                                                                                                | 责任                                                           |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [main.ts](../../electron/main.ts)                                                                          | Electron 启动、窗口、Backend 和 IPC 生命周期                   |
| [create-backend-runtime.ts](../../electron/application/create-backend-runtime.ts) / `createBackendRuntime` | SQLite、应用服务、后台 execution、Agent Runtime 的唯一生产组装 |
| [create-agent-runtime.ts](../../electron/runtime/create-agent-runtime.ts) / `createAgentRuntime`           | 创建 SessionManager，连接 Provider、工具、Skills、MCP 与事件   |
| [durable-run-application-service.ts](../../electron/application/durable-run-application-service.ts)        | start/retry/continue、请求幂等、Session 创建与 live 状态协调   |
| [session-manager.ts](../../electron/session/session-manager.ts) / `SessionManager`                         | Session map、生命周期检查和各协作者门面                        |
| [session-run-controller.ts](../../electron/session/session-run-controller.ts) / `SessionRunController`     | Run 启动、循环、中断与终态收尾                                 |
| [session-provider-turn.ts](../../electron/session/session-provider-turn.ts)                                | 单轮模型请求及流式活动                                         |
| [session-tool-runner.ts](../../electron/session/session-tool-runner.ts)                                    | Tool batch 的有序准备、执行与结果提交                          |
| [session-orchestration-planner.ts](../../electron/session/session-orchestration-planner.ts)                | Goal/Plan 的执行延续决策                                       |
| [disposer.ts](../../electron/disposer.ts)                                                                  | 宿主退出时复用清理边界                                         |

## 主要调用链

```text
agent-runtime Store → agentApi.startRun → run:start IPC
  → DurableRunApplicationService.start
  → SessionManager.startRun → SessionRunController
  → UserTurnPreparer / PromptContext / Compact
  → ProviderTurnRunner → ToolRunner → 下一轮或最终回复
  → durable commits + ephemeral events → Renderer
```

首次发送先通过业务校验并提交初始记录，才进入 Provider 请求。已有 Session 的 retry/continue 经过各自边界，不能通过重复调用普通 start 模拟；[conversation-continuation.ts](../../shared/conversation-continuation.ts) 共享续跑判定。

## 状态与契约

完整 Message 和 Session 由 Backend/SQLite 持有；live maps、AbortController、stream、pending approval 在内存。Renderer reload 可同步主进程仍持有的 [runtime-state](../../shared/runtime-state.ts)，进程重启不能恢复 partial 输出。后台 Agent/PTY 的生命周期见 [Agent 地图](./agent-execution.md)，不能在 Run finish 中顺手全部取消。

## 修改指引

- 修改发送/继续：同时查 Store、Application service 和 Session Core 的 revision/历史判定；避免创建空 Session 或重复 user message。
- 修改循环：先确定属于 Provider、工具、compact 还是编排协作者，保持 SessionManager 的组装职责。
- 修改取消/关闭：区分普通 Run 中断、后台任务取消和 Session/Project dispose，检查未完成 call 的结果与监听器清理。
- 修改事件：同步 [runtime-events.ts](../../electron/runtime/runtime-events.ts)、[session-events.ts](../../electron/session/session-events.ts) 和 Renderer 消费路径。

## 验证入口

| 测试                                                                                                                  | 验证内容                                   |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [durable-backend-runtime.test.ts](../../electron/application/durable-backend-runtime.test.ts)                         | 后端装配与持久化路径                       |
| [create-backend-runtime-cleanup.test.ts](../../electron/application/create-backend-runtime-cleanup.test.ts)           | 构造失败和 dispose 清理                    |
| [session-manager.precommit-recovery.test.ts](../../electron/session/session-manager.precommit-recovery.test.ts)       | 首次提交、失败和恢复                       |
| [session-manager.cancellation-and-fork.test.ts](../../electron/session/session-manager.cancellation-and-fork.test.ts) | 中断、分支和生命周期                       |
| [conversation-continuation.test.ts](../../shared/conversation-continuation.test.ts)                                   | 可续跑和终止历史边界                       |
| [durable-session-terminal.spec.ts](../../e2e/durable-session-terminal.spec.ts)                                        | 跨宿主生命周期的持久会话/Terminal 用户路径 |
