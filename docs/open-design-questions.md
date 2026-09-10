# 待讨论的运行时设计问题

状态：开放；本文只保留尚未形成最终设计决定的问题。返回[文档入口](./README.md)，代码定位见[Code map](./code-map/README.md)。

本文只记录当前可观察行为、影响范围和后续需要回答的问题，不包含候选方案、推荐结论或实施计划。形成决定后，应把结论写入相应的 requirements、architecture、frontend spec 或 decision log，并更新本文状态。

Session 用量、上下文分解与刷新恢复已确定，当前规则见[Session 用量与当前上下文](./architecture/session-usage.md)。

## 2. Swarm 运行中 Tool call 统计的一致性

### 当前行为

- Background 面板中的“工具调用”读取 `AgentExecutionDetail.statistics.toolCallCount`，不会直接计算当前 Renderer live activities 中的 Tool card 数量。
- Main process 查询该统计时，会从隐藏 child Session 的可见 assistant turn 中按 `callId` 统计不同的 `tool_call`；Swarm root 的统计是 root 自身 Session 和所有 child Session 统计之和。
- `AgentExecutionDetail.statistics` 是详情查询时返回的快照。Renderer 收到 `tool.proposed` 或 `tool.completed` 时会更新 live activities，但不会同步修改该统计字段。
- Swarm child 状态变化会更新 child summary；Coordinator 也会在每个 child 结束时发布新的 root summary 和 agent counts，但 `execution.changed` event 不包含 Tool call 统计。
- Renderer 只会在 execution 进入终态时无条件刷新已加载的详情；运行中的 root summary 更新不会刷新 root 详情统计。因此展开 Swarm 后看到的 Tool call 数量可能在运行中保持旧快照，而 Job 结束后的边界刷新会得到完整持久化计数。

### 待讨论问题

- 运行中 Tool call 数量应统计已开始生成、已 `proposed`、已获批、已执行还是已持久化的调用？
- Swarm root 的数量应只汇总 child Agent Tool call，还是还包括 root/orchestrator 自身调用？
- Tool 重试、相同 `callId` 的状态更新、拒绝、取消和失败分别计为几次？
- 运行中统计的权威来源应是 durable Message、Agent execution event、Renderer live overlay，还是三者的组合？
- Child Tool event 到达时，root 聚合统计如何同步，允许多大的延迟和暂时不一致？
- Renderer event 丢失、乱序、详情分页或 reload 后，运行中数字如何恢复并与最终统计收敛？
- Agents 面板、Trace、日志和最终 Swarm result 是否需要共享同一个 Tool call 统计定义？

### 关联实现

- [electron/persistence/message-repository.ts](../electron/persistence/message-repository.ts)
- [electron/application/agent-execution-query-service.ts](../electron/application/agent-execution-query-service.ts)
- [electron/swarm/coordinator.ts](../electron/swarm/coordinator.ts)
- [electron/session/session-events.ts](../electron/session/session-events.ts)
- [shared/agent-execution.ts](../shared/agent-execution.ts)
- [src/stores/agent-executions.ts](../src/stores/agent-executions.ts)
- [src/components/artifacts/AgentExecutionBody.vue](../src/components/artifacts/AgentExecutionBody.vue)

## 3. 用户消息的视觉容器与对齐方式

### 当前行为

- 每个对话 Turn 使用最大 `760px` 的内容列并整体居中；用户消息在该内容列内又使用 `fit-content` 和水平自动外边距，因此消息块本身会居中。
- 用户消息设置了边框、背景、内边距和不对称圆角，并将宽度限制为内容列的 `78%` 且不超过 `680px`，视觉上将每条用户消息表达为独立卡片。
- 用户消息没有可见的角色 metadata；文本、附件 Tag 以及重试、编辑、分叉等消息操作都放在同一个卡片容器中。
- `interjection` 消息也使用居中的 `fit-content` 容器，但通过左侧强调边框和斜体与普通用户消息区分。

### 待讨论问题

- 用户消息是否应继续使用独立卡片容器，还是与主对话内容列采用其他视觉层级？
- 用户消息应在内容列中左对齐、右对齐、居中，还是根据消息类型采用不同对齐方式？
- 短文本、多段 Markdown、代码块、宽表格、超长路径和大量附件分别需要什么宽度、换行和溢出规则？
- 如果弱化或取消卡片边界，应通过哪些元素区分用户输入、assistant 输出、`interjection` 和内部编排内容？
- 消息操作的位置、出现时机和可点击范围是否依赖当前卡片容器？
- 窄屏、辅助技术和历史会话中的用户消息应如何保持一致且可识别？

### 关联实现

- [src/components/chat/ConversationTurn.vue](../src/components/chat/ConversationTurn.vue)
- [src/components/chat/ChatMessageItem.vue](../src/components/chat/ChatMessageItem.vue)
- [src/components/MarkdownBlock.vue](../src/components/MarkdownBlock.vue)
- [src/styles/conversation-layout.css](../src/styles/conversation-layout.css)
