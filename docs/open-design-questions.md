# 待讨论的运行时设计问题

状态：开放，尚未形成设计决定。

本文只记录当前可观察行为、影响范围和后续需要回答的问题，不包含候选方案、推荐结论或实施计划。形成决定后，应把结论写入相应的 requirements、architecture、frontend spec 或 decision log，并更新本文状态。

## 1. Swarm 编排消息的可见性

### 当前行为

- `/swarm <goal>` 会同时保留用户提交的斜杠命令，并生成供 Provider 使用的 `orchestrator` Prompt Layer。
- Provider Prompt Layer 的正文包含 `<orchestration_request kind="swarm">`，其 canonical Message `kind` 是 `orchestrator`。
- canonical history 当前把 `orchestrator` 和 `interjection` 默认标记为 `visibility = visible`；Renderer 会把 visible `orchestrator` Message 投影到普通对话时间线。
- 因此用户可能同时看到自己提交的 `/swarm` 消息、内部 Swarm 编排正文、后续 `swarm_run` 工具或审批状态，以及 Agents 面板中的执行状态。
- `orchestrator.message` runtime/trace event 与 canonical Prompt Layer 是不同对象；普通时间线中的持久内容来自 canonical Message 的 visibility。

### 待讨论问题

- 模型可见的 Swarm 编排正文是否应该进入普通用户时间线？
- 用户输入、内部编排指令、编排状态提示、工具审批和 Agents 执行状态各自应采用什么可见性？
- 可见性规则只适用于 Swarm，还是也适用于 `/prompt`、`/goal`、`/plan` 及后续 orchestration continuation？
- `kind`、`visibility`、`inHistory` 和 UI presentation 之间的职责边界是什么？
- 已经持久化为 visible 的历史 Swarm 编排 Message 应如何表现？
- 普通搜索、会话导出、完整 Trace 和受限 transcript 是否应以相同方式处理这些记录？

### 关联实现

- `electron/session/slash-commands.ts`
- `electron/session/session-user-turn-preparer.ts`
- `electron/session/session-run-controller.ts`
- `electron/session/canonical-history.ts`
- `src/stores/conversation-timeline.ts`

## 2. `run_command` 与交互式 Terminal 的执行环境边界

### 当前行为

- `run_command` 是一次性子进程工具，不创建 PTY，也不把实时输出投影到前端 Terminal。
- `run_command.mode = process` 直接执行模型提交的 `executable + args`，不读取命令 Shell 配置。
- `run_command.mode = shell` 读取 `executionEnvironment.commandShell`，由 Main process 解析实际解释器和固定启动参数，最终仍以 `shell: false` 启动。
- Renderer 在 `Settings → Limits → Commands` 中提供“一次性命令 Shell”选择、重新扫描、实际路径和失效回退提示。
- `terminal_open` 使用另一条持久 PTY 链路。它当前允许 Tool 参数提供可选 `shell`；未提供时，Windows 默认 `powershell.exe`，其他平台默认 `$SHELL` 或 `/bin/sh`。
- `terminal_open` 不读取 `executionEnvironment.commandShell`，当前也没有独立的用户侧 Terminal profile 配置。

### 待讨论问题

- 产品中的“命令解释器”“终端”“Shell profile”分别指什么，设置和文案是否足够明确？
- `run_command.shell` 与 `terminal_open` 应共享配置还是维护不同配置？
- 交互式 Terminal 使用哪个 Shell 应由用户配置、Tool 参数决定，还是同时支持两者？
- Main Agent 应获知哪些实际执行环境信息，哪些候选解释器信息不应进入模型上下文？
- 不同平台上的发现顺序、失效回退、重新扫描和配置持久化语义是否一致？
- `run_command.process`、内部 Git、Subagent、Swarm child 和 Terminal 是否需要明确展示各自不受哪些设置影响？

### 关联实现

- `shared/command-shell.ts`
- `electron/process/command-shell.ts`
- `electron/process/run.ts`
- `electron/tools/process-tools.ts`
- `electron/terminal/pool.ts`
- `electron/tools/terminal-tools.ts`
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

### 待讨论问题

- “上下文占用”指最近一次请求的输入、该次输入加输出，还是下一次 Provider 请求预计会携带的上下文？
- 哪些 token 字段可以被视为 Provider 报告的权威值？cache read、cache creation、reasoning 和 output 应如何计入？
- Provider usage 缺失或字段不完整时，进度条应展示什么状态？
- 上下文容量必须来自 Provider，还是可以来自用户配置、内置元数据或全局默认值？
- 当已用量和容量来自不同来源时，UI 应如何描述准确性和来源？
- UI、自动压缩、usage 统计和 Trace 是否必须使用同一个上下文 token 定义？
- 进度条是否应跨 Renderer reload、Session 切换和已完成 Run 恢复？若需要，权威数据源是什么？
- 模型切换、Provider transfer 和 compact epoch 切换后，旧 usage 是否仍能代表当前上下文？

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

### 当前行为

- 应用已有可选的 Session JSONL Trace。默认配置为关闭；开启前需要接受 Trace notice。
- Trace 可以记录 Run lifecycle、Provider request/response、usage、工具、审批、Terminal 和部分编排事件；它可能包含源码、Prompt、命令、工具参数或结果和明文 reasoning，因此属于敏感的完整诊断数据。
- Reasoning-only 等带 completion diagnostics 的 Provider 失败，在 Trace 开启时可以保存脱敏 API key 后的 raw response、Provider state、usage 和 timing。
- Provider 在形成 completion diagnostics 之前发生的网络、timeout、HTTP 或 stream 解析错误，不一定有对应的失败 `llm.response`；`run.end` 当前只记录 terminal status，不记录结构化 failure code、message 或 cause。
- Trace schema 和读取链支持 `llm.stream`，但当前主 Provider 生产调用链没有写入该事件。
- Architecture 文档提到 runtime diagnostics，但 Trace schema 当前没有通用 diagnostic/error event。
- Backend 使用 `DiagnosticSink` 汇集部分内部异常。Desktop 默认实现把原始 message/error 写到主进程 console，并只把经过截断和脱敏的 notification 发送给 Renderer。
- `audience = internal` 的 diagnostic 不发送 Renderer notification，但仍写 console。
- 应用启动、Backend recovery、Window/App cleanup 等错误主要使用 `console.error` 或 `console.warn`，当前没有统一的持久化、轮转应用日志。
- 当前没有统一覆盖 `uncaughtException`、`unhandledRejection`、Renderer process gone 或其他 Electron process failure 的持久记录。
- 设置页的“打开日志目录”当前打开的是 Trace 目录，不是独立的应用运行日志目录。
- Trace 写入失败会降级为 Null logger 并保持业务运行；关闭 Trace 时不会持久化 Session 级详细执行事件。

### 待讨论问题

- 是否需要独立于完整 Trace 的持久化 Backend/Application operational log？
- Operational log 默认状态、保留周期、总大小、单文件轮转和清理规则是什么？
- Operational log 与 Session Trace 的数据边界分别是什么？
- Provider request/response、Prompt、reasoning、工具参数、源码、workspace path、endpoint、headers 和凭据分别允许进入哪类日志？
- 任意 Error 的 message、cause、stack 和附加字段应如何分类、截断和脱敏？
- 哪些 lifecycle 和错误必须记录：应用启动退出、数据库迁移、IPC、Provider attempt、Run、Tool、MCP、Terminal、Subagent、Swarm、Plugin、Trace degradation 和进程崩溃？
- Provider 失败需要哪些稳定错误代码和 correlation IDs，才能关联 Session、Run、call 和 retry attempt？
- Full Trace 关闭时，Provider 失败应保留哪些最小诊断元数据？
- 日志自身创建、写入、轮转或清理失败时，业务和用户通知语义是什么？
- 用户应如何查看、复制、导出和清理应用日志与 Session Trace？两者是否需要不同的隐私提示？
- Headless 与 Desktop 是否共享日志事件 schema、目录结构和默认策略？
- 当前文档宣称但生产链尚未写入的 `llm.stream` 和 runtime diagnostics 应如何定性？

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
