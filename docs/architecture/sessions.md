# Session、Run 与编排

本文规定消息提交、续跑、取消和编排的语义。代码入口见 [Runtime 地图](../code-map/runtime.md)。后台 Agent 的独立生命周期见 [Agent execution 规范](./agent-execution.md)。

返回[架构总览](../architecture.md) · [文档入口](../README.md)。

## 核心流程

### Lazy Session creation

1. 点击“新对话”只在 renderer 建立 draft、候选 `sessionId`、model/mode/Goal/Plan 和附件引用；不发送 backend command，Sidebar 也不增加 Session replica。
2. 首次发送使用 `run:start { kind: "new_session", ... }` 一次提交候选 Session、initial system/harness/context 和原始 user message。
3. Backend 在外部 I/O 完成且所有 precondition 通过后，用单一 transaction 插入 Session 与首批 Messages。Session 初始 `revision = 1`，`lastSeq` 直接指向首批最后一条 Message。
4. Commit 后通过回包和 `session.changed` 发布同一个 envelope，候选 identity 此时才成为 durable Session；随后才允许 Provider request。
5. 已存在 Session 使用 `run:start { kind: "existing_session", ... }`，只追加本次 context/user records。

首次发送前的 terminal、interjection、approval 和 `/compact` 都没有 durable owner，必须返回 precondition error。失败前不得留下空 Session。

### Draft

Draft 和 draft attachments 只属于当前 renderer 输入组件：

- 不发送 IPC。
- 不进入 SQLite。
- 不保证切换 Session、renderer reload 或应用重启后保留。
- 点击发送时，renderer 把完整 text 和 attachment refs 一次性交给 backend。
- 切换 Session、再次点击新对话或 renderer reload 时直接丢弃；draft 不进入 Sidebar 搜索结果。

Backend 校验附件、构造完整 user/harness messages 并落盘。附件正文受 AppConfig 的 `limits.maxAttachmentContextTokens` 约束，默认 `64_000`；聚合估算超过预算时，本次附件统一降级为仅注入类型和路径，renderer attachment chips 标记为 truncated。Draft 丢失不会造成 backend state 与 canonical history 不一致。

### Rewind、用户消息重试、继续与编辑

- `session:rewind` 只接受当前分支中可见的原始用户或 Assistant 消息。用户边界会移除该用户整轮及之后记录；Assistant 边界保留对应用户消息，从 Assistant 开始移除。
- “移除”不删除 row：相关 records 改为 `visibility = superseded` 且 `inHistory = false`。每次 rewind 递增 Session revision、清除 Goal/Plan，并从保留前缀重建 `inHistory`；`compact_summary.replacesThroughSeq` 与 `conversation_transcript.sourceThroughSeq` 作为同等 epoch boundary，因此可以跨 compact 或 Provider transition 回退。
- `run:retry(userMessageId)` 只接受可见原始用户消息。它保留该用户消息及其本轮前置 context，supersede 之后分支，再复用该 user record 运行；不会插入第二条 user message。Assistant、replay、derived、control command 或其他消息类型都返回验证错误。
- `run:continue` 只在 idle Session 的 active history 停在可续跑边界时启动：忽略尾部 passive prompt layer 后，最后一个驱动记录必须是非 control-command 的 `user_input`、`tool_result`、`interjection`、`orchestrator`，或带 `turnId` 的自动 `compact_summary`。完整 `assistant_turn`、手动 compact summary 和 conversation transcript 都是终止边界。Application 与 Session Core 必须分别校验当前 revision 和 live canonical history。
- 继续复用该记录的 `turnId`（缺省时复用记录 ID）作为原始轮次，不追加空 user message，也不产生初始 durable commit；新的 Assistant/tool commit 仍通过正常 `session.changed` 发布。Renderer 只在最后一个匹配轮次的消息操作栏显示“继续”，点击后直接调用，不经过 composer。
- 编辑先按该用户整轮 rewind，将原文和附件引用恢复到 composer，不自动发送；下一次发送创建新的用户轮次。
- Fork 只复制当前非 superseded 分支，连续重编号并重映射 message/turn/reference IDs，以及 compact/transcript epoch boundary。
- 所有操作只修改 Session/Message 状态。文件、终端与 MCP/外部工具副作用不回滚，应用也没有可供随后恢复的 FileChange journal；UI 在操作前明确提示用户自行使用 Git 管理工作树。

### 模型和权限模式

模型下拉框发送 `session:update`，更新 Session `modelSelection`。它不修改全局 provider default，也不改变已经开始的 Active Run。

Active Run 开始时解析 immutable `ModelRouteSnapshot` 并保存在 memory；每个完成的 assistant message 记录实际 route。

权限模式同样由 backend 更新。Active Run 使用启动时的 mode snapshot。

### 发送与执行

1. Backend 校验候选/已有 Session、Project、Provider、credential/notices 和同 Session lifecycle 条件。
2. 冻结 route、credential、model profile、permission mode 和本次 Run 工具 catalog。
3. 在 transaction 外异步构造完整 harness/context；transaction 插入 Session（仅首次）和完整 user/context messages。
4. Commit 后生成 `session.changed` envelope；`run:start` 回包返回该 envelope 和 runtime snapshot，push channel 发送同一 envelope。
5. `ActiveRunExecution` 在 commit 后开始 provider/tool loop。其后 backend 自主完成的 assistant/tool commit 只需通过 push event 通知 renderer。
6. Stream delta 只存 memory 并推送 renderer。
7. 每个完整 assistant turn 或完整 tool batch 按 [完整写入规则](./providers-and-context.md#完整写入规则) 写入 SQLite。
8. 完成、取消或失败后释放 runtime resources。

`subagent_run/swarm_run` 的 Tool body 只等待 durable reservation、容量预留和初始 artifact；返回 background handle 后 execution 不再绑定父 Run AbortSignal。因此第 8 步只释放前台 Run，自身完成/中断不会取消后台 Agent 或 Terminal。页面切换、live context 卸载、retry/edit/rewind 同样不取消；Session/Project archive/delete 与 app dispose 通过独立 quiesce boundary 先阻止新任务、级联取消并最多等待 60 秒，再提交生命周期变更。

用户中断或可恢复的 Provider failure 后，若 durable history 符合 [对话分支与续跑](./sessions.md#rewind用户消息重试继续与编辑) 的续跑边界，`run:continue` 可以从同一 canonical turn 重新进入第 5 步；streaming 中尚未完成的 Assistant text/reasoning 不会被恢复或伪造。

Durable execution port 对每个 Session 串行 commit。commit 失败时从 SQLite 单次恢复 SessionRecord、active history、next seq、mode/model/Goal/Plan，并清除未提交 request 映射；恢复也失败时 binding 标记为 invalid，当前 Run settle 后强制驱逐。tool-batch commit 失败即使恢复成功也会隔离当前 live binding，避免带着已发生但未落库的副作用继续 React。

`LiveSessionContextRegistry` 使用带 ownership token 的 `reserved → loading → live ↔ mutating → evicting/invalid/releasing` 状态机。并发候选 Session 只有 owner 能清理自己的 manager context/binding；lazy restore 从首次串行 durable read 起就参与 Session/Project lifecycle guard。Registry 的 idle 检查同时覆盖 active Run、未完成副作用、terminal 和 SessionManager 的 metadata mutation，避免 plan/mode commit 与 archive、rewind、fork 或 Project eviction 交错。Archive、Project path update/remove 会先取得 eviction lease，成功 commit 后的资源清理失败只记录诊断，不把已提交事务改报失败。

Application boundary 保留显式 `ApplicationError`；SQLite/codec 故障归一化为安全的 `PERSISTENCE_FAILURE`，其他未知异常归一化为 `INTERNAL_ERROR`。原始 cause 只进入主进程诊断，不通过 IPC 暴露路径、SQL 或其他内部消息。Backend 启动失败时始终尝试全部清理；清理或诊断失败不得覆盖最初的启动错误。

### 应用崩溃与重启

重启后：

- Session metadata 和完整 messages 从 SQLite 恢复。
- `inHistory = 1` 的 rows 重建 `CompiledCanonicalHistory`，再由当前 `ModelProvider` 编译 request。
- 所有上次的 active Run、pending approval、partial text/reasoning 和未完成 tool batch 丢失。
- SQLite 中遗留的 `queued/preparing/running` Subagent/Swarm execution 标记为 `interrupted`，不自动恢复；真实 PTY 不恢复。
- 最后一条已提交 user message 可能没有 assistant reply；UI 可以展示为未回答并允许用户重试。
- 崩溃前已经发生但尚未形成完整 tool batch message 的 workspace side effect 可能保留；系统以下一次实际文件状态为准。
- 不生成持久化 `interrupted` Run，也不伪造 partial assistant message。
- Session temp 根启动时清理最后使用时间超过 24 小时的安全目录；较新的 artifact/scratch 保留。路径已过期时 `read_file` 返回 `ARTIFACT_EXPIRED`。

如果只是 renderer reload 而 main process 仍存活，`session:get` 可以附带 backend memory 中的 `ActiveRunPublicSnapshot`，继续展示当前 Run。

## LiveSessionContext 与 ActiveRunExecution

### LiveSessionContext

它是按需创建的 backend execution context：

- 指向当前 active Run。
- 管理 Session-owned terminal facade。
- 保存可以丢弃和重建的 history cache。
- 保存当前 MCP connection 的披露状态。

它不是 SessionRecord，也不是所有持久 Session 都必须常驻内存。

### ActiveRunExecution

它负责 provider loop、stream、工具、审批、中断、writer 和资源释放。执行结束后销毁。

### 为什么不通过 IPC

Runtime object 含有 `AbortController`、Promise、callback、Map、stream、PTY、socket 和 lease，无法也没有意义序列化给 renderer。

Renderer 通过 IPC 操作能力：

```text
run:interrupt   -> ActiveRunExecution.controller.abort()
approval:decide -> PendingApprovalWaiter.resolve()
run:interject   -> ActiveRunExecution interjection queue
```

Renderer 收到的是 serializable snapshot/event，不是 runtime object reference。窗口 reload 或切换 Session 不能成为后台执行生命周期的所有者。

## Goal、Plan、Todo、Interjection 与并发

### Goal 和 Plan

Goal/Plan 会跨越多个 provider turn，并影响下一次 prompt 和 continuation，因此属于 Session durable metadata，保存在 `sessions.goal_json/plan_json`。

模型工具和 renderer command 调用同一个 Session application service。更新成功后 backend commit Session，再向 renderer 推送 SessionRecord。

需要进入模型上下文时，backend 生成完整 harness/orchestrator Message。Goal/Plan 的当前状态不依赖 runtime memory。

### History-derived Todo List

Todo List 是模型自行维护的当前任务执行清单，不是 Durable Plan 的别名。`shared/todo.ts` 一次定义 `TodoState`：一个不超过 65,536 字符的可选 explanation 和至多 128 个有序 item；item 只包含不超过 1,024 字符的 step 与 `pending | in_progress | completed` 状态。完整快照至多允许一个 `in_progress`，不使用稳定 item ID、增量 patch、取消态或完成证据。

Provider 只看到一个 `todo_update` 工具。每次调用必须提交完整有序快照，因此替换、重排和多项状态推进都是一次原子更新。工具按 serial 执行，校验 `sessionId/runId` 与当前 `ActiveRunExecution` 一致，使用低风险、无 workspace 副作用的既有执行路径，不进入人工审批，也不创建、修改或完成 Goal/Plan。普通 Main、Headless 和 child 使用同一 schema；child catalog 包含 Todo，但 internal Session 的 `todo.updated` 不投影到父 Session。

成功的 `todo_update` assistant tool call 与对应 `tool_result` 是 canonical history 中的事实记录。Renderer 按顺序归约当前已加载消息中已完成且非错误的调用，从参数重建快照，并将最新快照暴露为 `currentTodo`；协议工具卡片仍从普通 Tool Call 折叠栏隐藏。输入框上方用 Naive UI 的紧凑单行预览展示当前 `in_progress` item，没有时回退到第一个 `pending` item；鼠标悬停后在有界 Popover 中展开完整只读 checklist，全部完成时隐藏预览。Todo 与输入框在同一纵向布局中参与正常文档流，不使用绝对定位覆盖输入框，也不生成时间线项。失败、拒绝、取消、超时或缺少结果的调用不改变 Todo。应用重启、Session 切换和 Run 终态 reload 都从有界消息页尽力重建，不另存需要同步或删除的 Session Todo 字段；更新落在未加载的更早页、被压缩或无法从原始参数解析时，Todo 可以暂时不显示。

`ActiveRunExecution.todo`、`todo.updated` 与 `ActiveRunPublicSnapshot.todo` 只负责成功调用后的低延迟显示、窗口 resync 和终态 durable reload 完成前的过渡。Run 结束或下一 Run 开始不向历史追加清空标记，也不注入 `<todo_state>`；后续模型像处理其他工具一样，从 conversation history 中最近的成功 `todo_update` 理解当前清单。Provider compact 依靠 handoff summary 保留当前进度，route 转换依靠 complete-history transcript，不维护 Todo 专用 checkpoint。

### Interjection

Queued interjection 属于 ActiveRun memory。只有真正注入 canonical active history 时，才作为完整 `kind = 'interjection'` message 插入 SQLite。

应用崩溃前仍未注入的 interjection 可以丢失。

### 并发边界

- 每个 Session 同时最多一个 Active Run。
- 不设置全应用 Active Run 准入上限；不同 Session 可以同时运行。
- 不按 canonical workspace 建立 writer lease、只读降级、启动拒绝或并发警告；同一 workspace 的多个可写 Session 可以并发。
- 文件工具继续使用路径守卫、args-bound approval、普通文件限制与原子发布，但不使用内容 hash/file identity precondition；读取后的竞争采用 last-writer-wins。`apply_patch` 的精确唯一匹配只报告该次操作是否可应用，不充当 workspace 并发锁。
- 同一 Session 的 active Run、metadata mutation、归档和关闭仍按线性历史与 lifecycle token 互斥。
- 不可中止副作用仍在执行时继续由其 Tool 生命周期跟踪到 Promise settle，但不占用 workspace 准入资源。
