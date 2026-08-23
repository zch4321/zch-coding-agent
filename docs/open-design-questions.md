# 待讨论的运行时设计问题

状态：开放；本文只保留尚未形成最终设计决定的问题。

本文只记录当前可观察行为、影响范围和后续需要回答的问题，不包含候选方案、推荐结论或实施计划。形成决定后，应把结论写入相应的 requirements、architecture、frontend spec 或 decision log，并更新本文状态。

## 1. 上下文占用进度条的数据语义

### 当前行为

- 对话头部从当前 Renderer Run overlay 中选择最近一条 `scope = main` 的 usage。
- 已用量优先取 Provider 标准化后的 `promptTokens`；缺失时使用 `cacheHitTokens + cacheMissTokens`。这些值来自 Provider usage 或由 Provider usage 字段派生，不使用本地 token estimator 计算进度条分子。
- 容量来自冻结 Model Profile 的 `contextWindowTokens`。来源可能是用户 override、Provider model catalog、内置模型元数据或全局默认值。
- Renderer 计算百分比并限制在 `0..100`，同时显示 `contextWindowSource`。
- 自动压缩的 Provider usage 判定采用 `totalTokens`，缺失时采用 `promptTokens + completionTokens`；它和进度条的已用量口径不同。
- Provider 只返回 `totalTokens` 时，当前进度条无法据此形成正确已用量。
- Provider 响应完成后新增的 assistant 输出，以及后续尚未发给 Provider 的工具结果或编排层，不一定反映在当前进度条中。
- usage 主要保存在活动 Run overlay；刷新、重新选择 Session、活动 Run 恢复和 Run 结束后的展示语义尚不完整。
- 进度条下方的累计明细会把当前活动 Run overlay 中全部 usage record 的 `cacheHitTokens`、`cacheMissTokens` 和 `completionTokens` 分别相加，缺失字段当前按 `0` 处理；该汇总不限于最近一条 `scope = main` usage。
- 当前明细显示“缓存命中输入、未命中输入、输出”三个统计量，不显示缓存命中率。

### 待讨论问题

- “上下文占用”指最近一次请求的输入、该次输入加输出，还是下一次 Provider 请求预计会携带的上下文？
- 哪些 token 字段可以被视为 Provider 报告的权威值？cache read、cache creation、reasoning 和 output 应如何计入？
- Provider usage 缺失或字段不完整时，进度条应展示什么状态？
- 上下文容量必须来自 Provider，还是可以来自用户配置、内置元数据或全局默认值？
- 当已用量和容量来自不同来源时，UI 应如何描述准确性和来源？
- UI、自动压缩、usage 统计和 Trace 是否必须使用同一个上下文 token 定义？
- 进度条是否应跨 Renderer reload、Session 切换和已完成 Run 恢复？若需要，权威数据源是什么？
- 模型切换、Provider transfer 和 compact epoch 切换后，旧 usage 是否仍能代表当前上下文？
- “缓存命中率”的分子和分母分别采用哪些 token 字段，是否只在 Provider 明确返回缓存统计时才有定义？
- 缓存命中率应覆盖最近一次主模型请求、当前 Run 的全部请求，还是包括审批、压缩、Subagent 等 scope 的更大范围？
- 不提供缓存统计、只提供部分字段、明确返回零值和混用不同 Provider 的 usage 时，缓存命中率应如何表达？
- 缓存命中率的精度、舍入、零分母和辅助说明采用什么展示语义？

### 关联实现

- `electron/providers/provider.ts`
- `electron/providers/usage.ts`
- `electron/providers/model-catalog.ts`
- `electron/session/session-compact-coordinator.ts`
- `shared/usage.ts`
- `src/components/chat/ConversationHeader.vue`
- `src/stores/agent-runtime.ts`

## 2. Swarm 运行中 Tool call 统计的一致性

### 当前行为

- Agents 面板中的“工具调用”读取 `AgentExecutionDetail.statistics.toolCallCount`，不会直接计算当前 Renderer live activities 中的 Tool card 数量。
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

- `electron/persistence/message-repository.ts`
- `electron/application/agent-execution-query-service.ts`
- `electron/swarm/coordinator.ts`
- `electron/session/session-events.ts`
- `shared/agent-execution.ts`
- `src/stores/agent-executions.ts`
- `src/components/artifacts/AgentExecutionBody.vue`

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

- `src/components/chat/ConversationTurn.vue`
- `src/components/chat/ChatMessageItem.vue`
- `src/components/MarkdownBlock.vue`
- `src/styles/conversation-layout.css`

## 4. `terminal_read` 的模型可见输出语义

### 当前行为

- `node-pty` 输出先以原始字节进入 `ByteRingBuffer`，并作为 `terminal.output` 原样交给 Renderer 的 xterm.js；用户看到的是终端模拟器解释控制序列后的屏幕，而不是普通文本流。
- `terminal_read` 从同一个 raw scrollback 按绝对字节 cursor 截取数据，随后使用 `electron/terminal/pool.ts` 中的手写 `ANSI_PATTERN` 做无状态清洗，再按 `\r?\n` 保留末尾若干行并从末尾限制 UTF-8 字节数。工具结果 formatter 只追加 cursor/truncated footer。
- 当前 `ANSI_PATTERN` 无法完整匹配包含空格或反斜杠的 OSC 窗口标题。它会把 OSC 前缀误当作 CSI，并额外吃掉标题正文的第一个字符：`ESC ] 0 ; npm run lint BEL` 被投影为 `pm run lint BEL`，`ESC ] 0 ; C:\... BEL` 被投影为 `:\... BEL`。这会让泄漏的窗口标题看起来像真实命令输出被吞掉首字符；该行为已由现有正则直接复现。
- 清洗发生在 cursor 截取之后且没有跨调用解析状态。若一次读取的 cursor 位于 UTF-8 字符、CSI/OSC 或其他控制序列中间，下一次增量读取可能从半个序列开始；即使修正完整序列的正则，也不能单靠当前调用恢复它的起始状态。
- 当前实现不解释裸 `\r`、退格、擦除、光标移动、alternate screen 或重复覆盖的进度行。因此模型得到的既不是终端当前屏幕，也不是严格的纯文本 transcript；行合并、重复文本和控制字符残留都可能出现。
- Renderer 的 xterm.js 路径通常正常，因为它消费完整 raw stream。现有 TerminalPool 测试只覆盖 SGR 颜色序列，没有覆盖 OSC/BEL、Windows 标题路径、跨 chunk/cursor 序列、裸 `\r`、UTF-8 截断或屏幕重绘。

### 待讨论问题

- `terminal_read` 的正式契约应是原始追加日志、ANSI-free transcript、当前可见 screen/viewport，还是同时提供其中两种视图？
- cursor 应基于 raw PTY 字节、规范化文本字节还是解析后的逻辑事件？清洗或屏幕重绘改变长度后，如何保证分页稳定且不重复、不漏读？
- ANSI/CSI/OSC 解析状态是否必须按 Terminal 持续保存，并跨 PTY chunk 与多次 `terminal_read` 延续？应用重启、scrollback 淘汰和 cursor 落后时如何表达状态丢失？
- OSC title、hyperlink、clipboard、notification 与其他非正文控制通道应全部丢弃，还是保留部分结构化元数据？如何避免把控制载荷或终端注入内容交给模型？
- 裸 `\r`、退格、擦除、光标定位、alternate screen 和交互式 TUI 分别应该形成覆盖后的屏幕内容、追加式历史，还是明确标记为不支持？
- `lines` 与 `maxBytes` 应在解析前还是解析后生效？从末尾截断时如何避免切断 UTF-8 code point、控制序列或逻辑行，并让 `truncated/totalBytes` 的单位保持可解释？
- 模型读取和 Renderer 恢复是否应共享同一终端状态投影，还是明确维持 raw UI stream 与独立 model transcript 两条边界？两者出现差异时哪一侧是诊断真相？
- 回归测试至少需要覆盖哪些 Windows PowerShell/npm/cmd 标题序列、Unix shell 控制序列、分块边界、增量 cursor 与长输出截断组合？

### 关联实现

- `electron/terminal/pool.ts`
- `electron/terminal/byte-ring-buffer.ts`
- `electron/tools/terminal-tools.ts`
- `electron/tools/tool-result-formatters.ts`
- `electron/terminal/pool.test.ts`
- `src/components/TerminalPanel.vue`
