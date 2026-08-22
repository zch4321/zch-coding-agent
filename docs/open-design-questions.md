# 待讨论的运行时设计问题

状态：部分开放；第 1、2、6 项已形成设计决定，其余问题仍待讨论。

本文只记录当前可观察行为、影响范围和后续需要回答的问题，不包含候选方案、推荐结论或实施计划。形成决定后，应把结论写入相应的 requirements、architecture、frontend spec 或 decision log，并更新本文状态。

## 1. Swarm 编排消息的可见性（已解决）

### 决定

- 用户提交的 `/swarm <goal>` 继续作为普通可见 `user_input` 展示。
- 供 Provider 使用、正文包含 `<orchestration_request kind="swarm">` 的 canonical `orchestrator` Prompt Layer 以 `visibility = hidden` 持久化，同时保持 `inHistory = true`；它继续进入模型上下文，但不进入普通对话时间线。
- 已经持久化为 visible 的旧 Swarm Prompt 不改写 SQLite；Renderer 根据稳定来源 `slash:/swarm` 抑制其时间线投影。
- `orchestrator.message` runtime/trace event、`swarm_run` 工具与审批状态、Agents artifact 各自沿用独立展示链路，不把内部 Prompt 正文重新投影为聊天消息。
- 本次规则只适用于 `/swarm`；`/prompt`、`/goal`、`/plan` 和 `interjection` 的现有可见性不变。
- 普通消息搜索与时间线不展示内部 Swarm Prompt；完整 canonical history、Provider-transfer transcript、Conversation 导出和完整 Trace 仍可保留它，用于模型连续性和显式诊断/导出。

### 关联实现

- `electron/session/slash-commands.ts`
- `electron/session/session-user-turn-preparer.ts`
- `electron/session/session-run-controller.ts`
- `electron/session/canonical-history.ts`
- `src/stores/conversation-timeline.ts`

## 2. `run_command` 与交互式 Terminal 的执行环境边界（已解决）

### 决定

- `run_command.shell` 与交互 Terminal 统一使用 `executionEnvironment.commandShell`；不引入独立的用户侧 Terminal profile 配置。
- `terminal_open` 删除模型可见的 `shell` 参数；TerminalPool 在每次打开 Terminal 时读取当前配置并经 CommandShellService 解析实际 profile，配置失效时沿用自动回退且不改写保存值。解析为 PowerShell kind 的 PTY 固定使用 `-ExecutionPolicy Bypass`。
- 设置变更只影响之后打开的 Terminal；已在运行的 Terminal 不重启。
- `<environment_context>` 继续只注入实际解析后的 `command_shell: label (id)`；它同时约束 `run_command` shell 模式与 Terminal 输入语法，模型不能选择、假设或更换 Shell。
- `run_command.process`、内部 Git、Subagent、Swarm child 和其他直接进程不读取该配置；设置页文案统一为“命令与终端 Shell”。

### 关联实现

- `shared/command-shell.ts`
- `electron/process/command-shell.ts`
- `electron/process/run.ts`
- `electron/tools/process-tools.ts`
- `electron/terminal/pool.ts`
- `electron/tools/terminal-tools.ts`
- `electron/session/session-terminals.ts`
- `src/components/settings/LimitsSettingsPanel.vue`

## 3. 上下文占用进度条的数据语义

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

## 4. Reasoning-only Provider completion 的重试语义

### 当前行为

- Chat Completions 或 Responses Provider 在收到 reasoning、但没有 assistant 文本和工具调用时，会抛出 `ProviderCompletionError`。
- Desktop 主 Run 当前不会自动重试该错误；Run 进入 failed，用户看到 `Provider returned reasoning without an assistant answer; retry the request` 或对应 Provider 文案。
- 此错误发生在 canonical assistant Message 写入、工具执行和审批之前；失败尝试不会形成可继续的 assistant turn。
- Provider reasoning delta 可能已经作为活动 Run 事件发送给 Renderer，因此失败前的临时 reasoning 可能已经显示。
- `ProviderCompletionError` 当前携带 response diagnostics，但没有稳定的 reasoning-only failure code、结束原因或 retry disposition。
- Chat Completions accumulator 已观察 Provider finish reason，但 reasoning-only 异常没有把它作为结构化分类公开给 Session Core。
- 完整 Trace 开启时，失败 completion 可以写入带 `normalizedTurn = null` 的 `llm.response`；失败尝试的 usage 不进入普通成功 usage 汇总。
- 主对话 Provider 调用没有通用 retry loop；Provider compaction 有独立的、有界 retry policy。

### 待讨论问题

- Reasoning-only completion 是否应自动重试？如果需要，重试预算属于一次 Provider attempt、一次 ReAct step 还是整个 Run？
- Empty turn 是否与 reasoning-only 使用相同语义？
- 如何区分偶发空响应、正常 stop、输出 token 耗尽、content filter、refusal 和 Provider 协议损坏？
- Retry policy 应依据结构化错误字段、HTTP/Provider code、finish reason 还是其他信号？
- 自动重试是否保持相同 Provider、模型、reasoning、Prompt 和 output limit？
- 第一次失败尝试已经流式展示的 text/reasoning 应如何处理？
- 每次重试是否拥有独立 call ID、Plugin hook、Trace 事件、usage 和费用统计？
- 用户取消、应用退出或 Session 关闭发生在重试等待期间时，终止边界是什么？
- 第二次仍然失败时，用户应看到哪一层错误以及哪些 attempt 信息？
- 主对话的 reasoning-only 重试与未来可能加入的网络、timeout、HTTP 408/429/5xx 重试之间是什么关系？

### 关联实现

- `electron/providers/provider.ts`
- `electron/providers/chat-completions-shared.ts`
- `electron/providers/generic-responses-provider.ts`
- `electron/session/session-provider-turn.ts`
- `electron/session/session-run-controller.ts`
- `electron/session/session-compact-retry.ts`
- `src/stores/agent-runtime-events.ts`

## 5. 后端运行日志与 Session Trace 的职责

### 决定

- 增加独立 Operational Log：支持 `off/error/warn/info/debug`，默认 `info`，14 天/50 MB，固定 5 MB 单文件轮转。它只记录白名单化、脱敏、有界的运行元数据；Provider/Tool 正常 attempt 为 `debug`，失败为 `warn/error`。
- Full Session Trace 继续默认关闭并要求隐私确认，独立使用 14 天/500 MB 配额。它保存内容级聚合 request/response、工具、审批和 canonical 诊断信息。
- 正常 Provider stream 不写 token/SSE 增量。Trace v3 仅为失败写一条 `llm.failure`，可附带最多 256 KiB 的 HTTP body 或非法 SSE/JSON/completion 证据；失败前 partial text/reasoning 不落盘。读取链保留 v2 `llm.stream` 兼容投影，但生产写入类型不再允许该事件。
- HTTP/network/timeout/SSE/JSON/completion/configuration/tool batch/compaction 使用稳定 Run 错误码。`warn/error` 分配 `diagnosticId`，同一 ID 贯穿 Provider、Run status、Operational Log 和 Renderer 的 Naive UI message。
- Operational Log 永不包含 Prompt、消息正文、reasoning、Provider body、工具参数/结果、命令、Terminal/文件内容、凭据、任意 headers 或绝对 workspace 路径。Error 仅保存有界首行、稳定 code、两层 cause 和 16 个规范化 stack frame；endpoint 移除 userinfo/query/fragment。
- 日志服务使用独立 `electron-log` 实例和同步文件 transport；日志自身失败只把状态标为 degraded，不能改变业务结果。设置页只提供两类日志的配置、状态、打开目录和清理历史，不提供 tail/分页查看或远程上传。
- Desktop 写入 `userData/logs/runtime/`；Headless 写入 artifact 下的 `runtime/logs/runtime/` 并在 result 中返回目录，stdout JSONL 不混入日志。

### 关联实现

- `electron/diagnostics.ts`
- `electron/notifications/backend-notification-reporter.ts`
- `electron/logging/events.ts`
- `electron/logging/logger.ts`
- `electron/logging/service.ts`
- `electron/session/session-trace-controller.ts`
- `electron/session/session-provider-turn.ts`
- `electron/session/session-run-controller.ts`
- `electron/main.ts`
- `src/components/settings/LoggingSettingsPanel.vue`

## 6. Terminal 标识符与生命周期（已解决）

### 决定

- 模型可见的 `terminalId` 采用进程级作用域：进程内全局递增的正整数，跨 Session 不重复；应用重启后从 1 重新开始。模型使用的短标识符与 Main process 内部资源主键保持相同。
- ID 一经分配在当前进程内不复用；打开失败允许留下编号空洞。不迁移数据库或旧日志中的旧字符串 ID。
- 每个 Session 最多保留 16 个 Terminal（含 opening、running 与已退出但未显式关闭的条目）；显式关闭立即释放名额；打开前同步预留名额，Tool 与 Renderer 并发打开不会越过上限。
- `terminal_list` 按数字 ID 升序返回；模型输错、引用已关闭 Terminal 或引用其他 Session 的同号 Terminal 时，统一返回 `Terminal not found for this session`；对同一 ID 的重复显式关闭仍幂等返回“已关闭”。
- 模型侧 `terminal_resize` Tool 已移除；Terminal 尺寸由 Renderer 面板自动 fit 后经 `terminal:resize` IPC 同步给 PTY。

### 关联实现

- `shared/ids.ts`
- `shared/terminal.ts`
- `shared/ipc-contract.ts`
- `electron/terminal/pool.ts`
- `electron/tools/terminal-tools.ts`
- `electron/session/session-terminals.ts`
- `electron/session/session-manager.ts`

## 7. 对话运行阶段、布局稳定性与 Tool call 生成可见性（已解决）

### 决定

- 单个对话 Turn 固定按用户消息、思考过程、Tool call、assistant 消息的顺序渲染。
- “思考过程”标题右侧是唯一的普通对话 Run 状态区域。所有非终态都显示 Naive UI 圆形 Spinner，并使用“请求模型”“思考中”“输出中”“调用工具”“执行工具”“等待审批”“取消中”之一。
- 对话头部 Run Tag、流式 assistant 消息的“生成中”和 Session 侧栏运行文字全部移除；Trace 状态、fork/import 身份标记和每个 Tool card 自身状态继续保留。
- Main process 发出轻量 `assistant.activity` 事件，值为 `reasoning`、`output` 或 `tool_call`。Provider stream 类型发生变化时才发送，不转发 Tool 名称、arguments delta 或其他参数内容。
- Renderer 对活跃 Run 的启动期 `idle` 与 `calling_llm` 使用同一套瞬时活动映射：没有活动时显示“请求模型”，收到活动后显示对应细分状态；每次进入 `calling_llm` 时清空上一轮活动。text/reasoning delta 同时作为兼容兜底更新活动。`evaluating_tools` 统一显示“调用工具”，不暴露短暂的内部评估阶段。
- 活动不写入持久化历史或公开 Run Snapshot。Renderer reload 后先根据粗粒度 `run.status` 恢复状态，收到新的活动事件后再细化。
- 活跃 Run 即使尚无 reasoning、text 或 Tool，也投影出状态专用 Turn；状态槽保持固定高度。终态隐藏状态，不额外保留“已完成”标签。
- `orchestrator.message` 仍是模型可见但用户不可见的编排上下文；Renderer 注册表为它和 `tool.attempt` 提供显式空处理器。
- Tool call 累计次数不在本项中定义或修改；Swarm 运行统计的一致性继续由下一节跟踪。

### 关联实现

- `electron/providers/provider.ts`
- `electron/session/session-provider-turn.ts`
- `shared/agent-events.ts`
- `src/stores/agent-runtime-events.ts`
- `src/stores/conversation-timeline.ts`
- `src/components/chat/ConversationHeader.vue`
- `src/components/chat/ConversationTurn.vue`
- `src/components/chat/ReasoningGroup.vue`
- `src/components/chat/ChatMessageItem.vue`
- `src/components/chat/ToolCallGroup.vue`

## 8. Swarm 运行中 Tool call 统计的一致性

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

## 9. 用户消息的视觉容器与对齐方式

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
