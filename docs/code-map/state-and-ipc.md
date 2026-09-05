# 领域状态、SQLite 与 IPC

返回[总地图](./README.md)。规范见[状态与 IPC](../architecture/state-and-ipc.md)。

## 职责与边界

shared 定义跨层契约，Application service 拥有业务事务，Repository/Codec 读写完整记录，Renderer 保存副本。IPC handler 不直接操作 Repository 或 Runtime map。

## 关键入口

| 文件 / 符号                                                                                                                                  | 责任                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [project.ts](../../shared/project.ts)、[session.ts](../../shared/session.ts)、[message.ts](../../shared/message.ts)                          | Canonical record 的 TypeBox schema                      |
| [domain-state-api.ts](../../shared/domain-state-api.ts)                                                                                      | Commands、queries、snapshots 与 `DurableCommitEnvelope` |
| [ipc/registry.ts](../../shared/ipc/registry.ts)                                                                                              | IPC 领域的唯一 channel 组合                             |
| [agent-api.ts](../../shared/agent-api.ts)                                                                                                    | 显式 capability manifest、公开 API 类型与装配工厂       |
| [preload.ts](../../electron/preload.ts)                                                                                                      | 冻结 bridge、订阅适配与有界缓冲                         |
| [ipc/index.ts](../../electron/ipc/index.ts)、[app-handlers.ts](../../electron/ipc/app-handlers.ts)                                           | sender/schema 校验与业务 handler 路由                   |
| [application-state-coordinator.ts](../../electron/application/application-state-coordinator.ts)                                              | 串行 command、事务和 commit 发布                        |
| [database-service.ts](../../electron/persistence/database-service.ts)、[migrations/index.ts](../../electron/persistence/migrations/index.ts) | 数据库生命周期、迁移与事务控制                          |
| [message-repository.ts](../../electron/persistence/message-repository.ts)、[message-codec.ts](../../electron/persistence/message-codec.ts)   | Message SQL、分页和无损编码                             |
| [agent-replica.ts](../../src/stores/agent-replica.ts) / `useAgentReplicaStore`                                                               | cursor/revision 幂等合并、缺口恢复                      |
| [agent-runtime-subscriptions.ts](../../src/stores/agent-runtime-subscriptions.ts)                                                            | push delivery 与 Store 的连接                           |

## 主要调用链

后台 UI 契约由 [ipc/background.ts](../../shared/ipc/background.ts) 汇入 registry。Agent/Background runtime 观察使用 [runtime-cursor.ts](../../shared/runtime-cursor.ts)，与 durable commit cursor 同实例、独立序列；快照在协调队列内同步采样，Renderer 不用墙钟时间判断新旧。

```text
Renderer command → typed agentApi → validated IPC → Application service
  → coordinator.command → SQLite transaction → commit
  → 同一个 envelope 经 command 回包和 domain-state:event 返回
  → replica.reconcile → records/cache → Vue
```

bootstrap、snapshot 和分页 query 用来初始化或恢复副本。正常更新依赖事件；backend instance 改变、cursor gap 或 preload overflow 时重同步。不能假定回包先于事件，也不能把旧异步结果应用到新选择。

## 状态与契约

`revision` 表示 record 版本，Message `seq` 表示 Session 内顺序，event cursor 表示当前 Backend 实例的提交顺序，三者用途不同。stream 和审批另走 [agent-events.ts](../../shared/agent-events.ts)；Git Review 是只读临时查询。Hidden child Session 的公开过滤在 Repository/服务边界完成。

## 修改指引

- 新增 IPC：先改所属 [shared/ipc](../../shared/ipc/) 领域，组合 registry；仅需 Renderer 使用时才加入 capability manifest，再接 handler 和调用方。不能公开通用 invoke。
- 新增持久字段：改 canonical schema、codec、相关 repository 和下一号 migration；检查 snapshot/query/event 与 fork/rewind/导出影响。
- 修复同步：检查 command/push 是否经同一 reconciler，涵盖重复、乱序、缺口、切换和 backend instance 变化。
- 配置项走 [shared/config](../../shared/config/)、[ConfigStore](../../electron/config/store.ts) 和所属设置 Store；配置版本迁移与 SQLite migration 独立。

## 验证入口

| 测试                                                                                                           | 验证内容                         |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| [ipc-contract.test.ts](../../shared/ipc-contract.test.ts)、[agent-api.test.ts](../../shared/agent-api.test.ts) | channel、payload 和公开能力映射  |
| [security.test.ts](../../electron/security.test.ts)                                                            | Renderer 与宿主安全边界          |
| [repositories.test.ts](../../electron/persistence/repositories.test.ts)                                        | Codec、记录和查询                |
| [durable-concurrency-recovery.test.ts](../../electron/application/durable-concurrency-recovery.test.ts)        | 并发命令、重启和恢复             |
| [agent-replica.test.ts](../../src/stores/agent-replica.test.ts)                                                | 重复 delivery、缺口与副本合并    |
| [domain-state-contracts.test.ts](../../shared/domain-state-contracts.test.ts)                                  | Durable command 与 snapshot 契约 |
