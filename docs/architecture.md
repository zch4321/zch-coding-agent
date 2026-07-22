# 架构设计文档 · Zch Coding Agent

> 状态：Backend Architecture v2 目标规范 · 2026-07-22
>
> 配套文档：[`requirements.md`](./requirements.md) 定义产品能力，[`frontend-spec.md`](./frontend-spec.md) 定义前端信息架构与交互验收。
>
> 本文是后续重构的规范性目标，不表示所有内容已经实现。迁移期间，新增代码必须遵守本文边界；旧 `workbench.json`、renderer-owned conversation 和 memory-only session history 仅作为待移除的兼容实现，不得继续扩展。

---

## 1. 架构目标

Zch Coding Agent 是 Electron + Vue 3 桌面 coding agent。后端负责领域状态、持久化、Agent 编排和所有宿主能力；renderer 负责展示、收集输入并保存后端状态的副本。

目标结构：

```text
Renderer (Vue + Pinia)
  ├─ UI-only state
  └─ revisioned backend replicas
          │ commands / queries
          ▼
Preload typed bridge
          │ validated IPC
          ▼
Backend application services
  ├─ SessionService / RunService
  ├─ RuntimeCoordinator
  ├─ Provider / Prompt / Tool / Permission services
  ├─ Project / Terminal / Skills / MCP services
  └─ SQLite repositories
          │ commit
          ▼
SQLite canonical durable state
          │ SessionChange / snapshot
          ▼
Renderer replicas
```

这次重构解决以下根本问题：

- renderer 不再拥有一套独立于后端的 conversation 真相。
- `ConversationRecord` 与 main-process `SessionState` 不再表示同一个对话的两套不同数据。
- 应用重启后，模型上下文能够从持久化数据恢复，而不是只恢复 UI 消息。
- 模型、权限模式、Goal、Plan、工具、审批和 draft 的变更都经过后端。
- renderer 不再保存整个 workbench 快照，也不再通过 `workbench:save` 覆盖全部对话。
- provider request 由 provider-neutral canonical history 编译，不以进程内 `ProviderMessage[]` 为唯一来源。

---

## 2. 固定原则

### 2.1 后端是领域状态的唯一真相源

所有非纯 UI 状态由后端拥有。状态变更流程固定为：

1. renderer 发送版本化 command。
2. 后端校验 command 和目标 entity revision。
3. 后端在事务中更新 canonical state。
4. SQLite commit 成功。
5. 后端返回并发布带 entity/state revision 的 snapshot 或 change。
6. renderer 用后端结果替换或更新本地副本。

不得先向 renderer 宣布持久状态成功，再异步尝试落盘。数据库提交失败时，前端只能保留 pending/error UI，不得把请求值当成已提交事实。

### 2.2 状态分为三类

| 类别                    | 所有者           | 是否落盘             | 示例                                                                                               |
| ----------------------- | ---------------- | -------------------- | -------------------------------------------------------------------------------------------------- |
| Durable domain state    | backend + SQLite | 是                   | Session、消息、Run、model selection、route snapshot、Goal、Plan、审批、usage、draft                |
| Ephemeral runtime state | backend          | 否或仅保存恢复检查点 | `AbortController`、Promise、provider client、writer lock、PTY process、MCP connection、流式 buffer |
| UI-only state           | renderer         | 否                   | 滚动位置、面板展开、hover、当前选区、IME composition、未确认的 optimistic value                    |

“前端不能独立修改状态”的准确含义是：**不得存在只有 renderer 知道的已提交领域状态**。输入控件在 IPC 往返前可以有临时值，但必须明确标记 pending，并最终以后端返回为准。

### 2.3 Canonical schema 只能定义一次

持久化领域记录在 `shared/` 使用 TypeBox 定义 schema，并由 schema 导出 TypeScript 类型。renderer、backend application service、IPC 和数据库 codec 共用同一份定义。

禁止在 `src/` 和 `electron/` 再手写语义相近但字段不同的 `ConversationRecord`、`ChatMessage` 或持久化 `SessionState`。

SQLite 是 canonical record 的关系型存储表示。数据库列名和表拆分可以不同于嵌套 JSON，但必须满足：

```text
decode(encode(record)) deep-equals record
```

不能为了“物理结构完全相同”把完整 Session 序列化成一个不断增长的 JSON blob；那会重新引入整份重写、弱查询和并发覆盖问题。

### 2.4 Commit 后发布

所有 durable change 都带 Session `stateRevision`。它是 Session aggregate 的同步序号，与单个 record 的 `entityRevision` 分开。后端只发布已提交数据；renderer 按 `stateRevision` 应用：

- `incomingStateRevision <= localStateRevision`：忽略重复或过期 change。
- `incomingStateRevision == localStateRevision + 1`：正常应用。
- `incomingStateRevision > localStateRevision + 1`：停止增量应用并请求 snapshot。

`stateRevision` 只用于同步排序；title、model selection、draft、Plan 等并发写冲突使用各自的 `entityRevision`。无关的 tool/usage 更新不能让 draft command 产生伪冲突。

流式 token 是 backend-owned ephemeral output，可以在数据库 checkpoint 之间高频推送；它不能伪装成已经提交的最终消息。

### 2.5 历史保真与 append-only

用户消息、assistant 最终消息、harness layer、工具调用结果和 compaction checkpoint 一旦成为正式历史，不允许原地改写。明确的 compaction 只增加 checkpoint，不删除原始历史。

provider context selection 可以省略旧记录，但不能修改 canonical history。需要修正时追加新 record 或使用显式 tombstone/supersede 语义。

---

## 3. 进程与代码边界

### 3.1 `shared/`

只包含跨进程的纯数据定义和纯函数：

```text
shared/
  session.ts              # SessionRecord、SessionSnapshot、SessionChange
  run.ts                  # RunRecord、RunStatus、RunOutput
  timeline.ts             # Message、ToolCall、Approval、Usage 等 canonical entity
  commands.ts             # commands / queries / results
  ipc-contract.ts         # IPC runtime schemas
  agent-events.ts         # runtime stream events
  config.ts
  ids.ts
```

`shared/` 不得导入 Electron、Node.js、Vue、Pinia、数据库 driver 或 provider implementation。

### 3.2 `electron/`

主进程后端拥有：

- SQLite connection、migrations、repositories 和 transaction boundary。
- application services 和 command handlers。
- Session/Run runtime coordinator。
- Provider、Prompt Harness、Tool、Permission、Terminal、MCP、Skills 和 Project services。
- secrets、文件系统、进程、网络和 trace。
- state change publisher。

目标目录：

```text
electron/
  application/            # commands、queries、transaction orchestration
  persistence/
    database.ts           # SQLite lifecycle / pragmas / write queue
    migrations/
    repositories/
    codecs/
  runtime/                # AgentRuntime、SessionRuntime、RunRuntime
  session/                # provider-neutral session/run domain logic
  ipc/                    # host adapter，不承载领域逻辑
  providers/
  prompts/
  tools/
  permission/
  terminal/
  project/
  skills/
  mcp/
  logging/
```

IPC handler 只负责 host 边界校验、调用 application service 和编码结果，不能直接修改 repository 或 runtime map。

### 3.3 `src/`

Renderer 只包含：

- backend entity replicas。
- command pending/error 状态。
- selectors 和展示 projection。
- 纯 UI 状态。

它不能读写 SQLite、workspace、secrets 或 provider，也不能持久化完整 Session。

### 3.4 Host-neutral runtime

Electron 和 Headless 必须复用同一个 application/runtime composition。Repository 通过 port 注入：

- Desktop 使用 `userData/agent.db`。
- Headless/benchmark 使用每次任务独立的临时 SQLite 数据库。
- 测试可以使用临时 SQLite 文件；不得用行为不同的手写内存仓库替代数据库关键语义。

Headless 不复制 Prompt、Provider、Tool、Permission、compact 或 Session loop。

---

## 4. 领域术语与生命周期

### 4.1 Project

Project 是用户选择的 canonical workspace。数据库使用稳定 `projectId`，路径只是可变属性，不作为跨表主键。

### 4.2 Session

Session 是一个持久化对话，也是左侧栏中用户看到的“对话”。系统不再维护额外 `Conversation` 领域实体，也不再维护 `conversationId -> sessionId` 映射。

Session 创建后立即由后端保存。空 Session 可以由显式清理策略删除或归档，但不能先只存在 renderer，再在第一条消息时偷偷创建另一种 runtime Session。

### 4.3 Run

Run 是一次用户提交触发的 Agent 执行。一个 Session 可以包含多个 Run；同一 Session 同时最多一个 active Run。

Run 是持久记录，包含：

- 输入消息引用。
- 状态和错误。
- 开始时的 permission mode snapshot。
- 不可变 `ModelRouteSnapshot`。
- 起止时间和 usage 关联。
- 可选 `parentRunId` 和 `kind`，为 orchestration/swarm child execution 保留稳定归属。

### 4.4 SessionRuntime 与 RunRuntime

后端内存对象必须使用不同名称：

```ts
interface SessionRuntime {
  sessionId: SessionId
  activeRun?: RunRuntime
  terminalFacade: SessionTerminalFacade
  cachedStateRevision: number
  mcpDisclosures: Map<string, McpDisclosure>
}

interface RunRuntime {
  runId: RunId
  controller: AbortController
  done: Promise<void>
  pendingSideEffects: Set<Promise<void>>
  pendingApproval?: PendingApprovalWaiter
  writerLease?: WorkspaceWriterLease
}
```

这些对象永远不经过 IPC，也不直接序列化。重启后它们由 durable records 重建或安全终止。

---

## 5. Canonical Session 数据模型

### 5.1 SessionRecord

```ts
interface SessionRecord {
  schemaVersion: 1
  id: SessionId
  projectId: ProjectId
  title: string
  lifecycle: 'active' | 'archived'
  permissionMode: PermissionMode
  modelSelection: {
    providerId: string
    model: string
    reasoning: ReasoningEffort
  }
  parent?: {
    sessionId: SessionId
    forkedFromSequence: number
  }
  historyFidelity: 'complete' | 'legacy_display_only'
  entityRevision: number
  createdAt: string
  updatedAt: string
  archivedAt?: string
}
```

`modelSelection` 是下一次 Run 默认使用的用户选择，不是已经运行过请求的审计事实。

### 5.2 SessionDraft 与 RunRecord

```ts
interface SessionDraft {
  sessionId: SessionId
  text: string
  attachments: ContextAttachmentRef[]
  entityRevision: number
  updatedAt: string
}

interface RunRecord {
  schemaVersion: 1
  id: RunId
  sessionId: SessionId
  clientRequestId: string
  triggerMessageId: MessageId
  kind: 'primary' | 'orchestration' | 'swarm_child'
  parentRunId?: RunId
  status:
    | 'queued'
    | 'calling_llm'
    | 'evaluating_tools'
    | 'awaiting_approval'
    | 'running_tools'
    | 'cancelling'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'interrupted'
  permissionMode: PermissionMode
  modelRoute: ModelRouteSnapshot
  error?: {
    code: string
    message: string
  }
  entityRevision: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
}
```

`modelRoute` 在数据库中通过 immutable route row 关联，但 repository 返回的 canonical `RunRecord` 包含完整 snapshot。`interrupted` 表示上一进程未正常完成，不能与用户主动 `cancelled` 混为一谈。

### 5.3 SessionSnapshot

```ts
interface SessionSnapshot {
  stateRevision: number
  session: SessionRecord
  draft: SessionDraft | null
  runs: RunRecord[]
  timeline: SessionTimelineEntity[]
  goal: GoalState | null
  plan: PlanState | null
  contextCheckpoints: ContextCheckpoint[]
  runOutputs: RunOutput[]
}
```

其中 timeline 是 shared discriminated union：

```ts
type SessionTimelineEntity =
  | SessionMessage
  | ToolCallRecord
  | ToolResultRecord
  | ApprovalRequestRecord
  | ApprovalDecisionRecord
  | UsageRecord
```

每个成员都包含相同的 `id/sessionId/runId?/sequence/createdAt` base fields。Snapshot 是逻辑结构，不要求每次 IPC 都发送全部历史。Query 可以返回 Session header、最新 timeline page 和 cursor；renderer 持有的是 canonical state 的部分副本，而不是另一套 state。

### 5.4 SessionMessage

正式消息同时服务于 UI timeline 和 provider context compiler：

```ts
interface SessionMessage {
  schemaVersion: 1
  id: MessageId
  sessionId: SessionId
  runId?: RunId
  sequence: number
  kind:
    | 'user'
    | 'assistant'
    | 'harness'
    | 'runtime_context'
    | 'agents_context'
    | 'orchestrator'
    | 'interjection'
    | 'compaction'
  modelRole?: 'system' | 'user' | 'assistant'
  audience: 'user' | 'model' | 'both'
  source: string
  content: string | null
  reasoning?: string
  status: 'complete' | 'incomplete' | 'queued' | 'superseded'
  prompt?: {
    id: string
    version: string
    hash: string
  }
  createdAt: string
}
```

Renderer 根据 `kind`、`audience`、`source` 和 `status` 决定是否以及如何渲染。Backend 根据 `modelRole`、`audience` 和 checkpoint 生成模型上下文。Renderer 不读取 provider wire JSON 来猜测 UI 语义。

### 5.5 ProviderMessage 不是状态

`ProviderMessage[]` 是 `ProviderContextCompiler` 为一次 provider request 生成的临时 adapter 输入。它来自：

- canonical messages。
- tool calls/results。
- 最新适用的 context checkpoint。
- 当前 Run 的 Prompt Harness layers。
- route-compatible provider continuation state。

它不能成为唯一 history，也不能在 SessionRuntime 中形成不可恢复的第二真相源。

---

## 6. SQLite 持久化

### 6.1 文件和连接

Desktop database 位于：

```text
userData/agent.db
```

同一主进程使用一个数据库连接和串行 write queue。初始化至少执行：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

是否使用 `synchronous = NORMAL` 或 `FULL` 在 driver 选型和性能测试后确定。禁止业务模块各自创建连接或绕过 transaction service。

### 6.2 表设计

#### 基础与项目

| 表                   | 关键字段                                                  | 约束与用途                                    |
| -------------------- | --------------------------------------------------------- | --------------------------------------------- |
| `schema_migrations`  | `version`, `name`, `applied_at`                           | 顺序迁移；每个版本只执行一次                  |
| `projects`           | `id`, `path`, `name`, `revision`, timestamps              | `path UNIQUE`；Session 通过 `project_id` 关联 |
| `processed_commands` | `command_id`, `command_type`, `result_json`, `created_at` | 对可重试 command 做幂等去重                   |

#### Session 与 draft

| 表                          | 关键字段                                                                                                                                                                                                                              | 约束与用途                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `sessions`                  | `id`, `project_id`, `title`, `lifecycle`, `permission_mode`, `selected_provider_id`, `selected_model`, `selected_reasoning`, parent/fork fields, `history_fidelity`, `entity_revision`, `state_revision`, `last_sequence`, timestamps | Session aggregate root；每个领域事务递增 `state_revision`，仅 metadata 修改递增 `entity_revision` |
| `session_drafts`            | `session_id`, `text`, `entity_revision`, `updated_at`                                                                                                                                                                                 | 每个 Session 最多一个 draft                                                                       |
| `session_draft_attachments` | `session_id`, `position`, `kind`, `path`, `source`                                                                                                                                                                                    | `PRIMARY KEY(session_id, position)`                                                               |

#### Run 与路由

| 表                             | 关键字段                                                                                                                                                                              | 约束与用途                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `model_route_snapshots`        | `id`, provider id/label/protocol/profile/base URL、model、reasoning、context window、max output、capability source、`created_at`                                                      | immutable；不保存凭据                                                 |
| `runs`                         | `id`, `session_id`, `client_request_id`, `trigger_message_id`, `kind`, `parent_run_id`, `route_snapshot_id`, `permission_mode`, `status`, error fields, `entity_revision`, timestamps | `UNIQUE(session_id, client_request_id)`；route/mode 在 Run 开始时冻结 |
| `run_outputs`                  | `run_id`, `text`, `reasoning`, `entity_revision`, `updated_at`                                                                                                                        | 流式输出的 backend-owned checkpoint；完成后转成正式 assistant message |
| `provider_continuation_states` | `id`, `session_id`, `run_id`, `route_snapshot_id`, `through_sequence`, `state_json`, `created_at`                                                                                     | opaque、route-bound；切换不兼容 route 时忽略而不是重写                |

#### Timeline 与编排

| 表                    | 关键字段                                                                                                | 约束与用途                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `timeline_entries`    | `id`, `session_id`, `run_id`, `sequence`, `entity_type`, `created_at`                                   | 所有 timeline entity 的共同基表；`UNIQUE(session_id, sequence)`，保证跨类型全局顺序  |
| `messages`            | `entry_id`, `kind`, `model_role`, `audience`, `source`, `content`, `reasoning`, `status`, prompt fields | 正式 provider-neutral history；`entry_id` 一对一引用 `timeline_entries`              |
| `message_attachments` | `message_entry_id`, `position`, path/kind/source/size/truncated                                         | 已提交用户消息的 selected context 引用                                               |
| `tool_calls`          | `entry_id`, `call_id`, `assistant_message_entry_id`, `tool`, `args_json`, `reason`                      | immutable tool proposal；顺序和 Session/Run 归属来自基表                             |
| `tool_results`        | `entry_id`, `call_id`, `result_json`, `approval_summary_json`, outcome fields                           | immutable tool terminal result；`call_id UNIQUE`，拒绝/取消/超时也必须有结果         |
| `approval_requests`   | `entry_id`, `approval_id`, `call_id`, kind/tool/request fields、policy/diff/expiry                      | immutable approval request                                                           |
| `approval_decisions`  | `entry_id`, `approval_id`, decision/status/reason fields                                                | immutable terminal decision；`approval_id UNIQUE`，包含 allowed/denied/stale/expired |
| `usage_records`       | `entry_id`, `call_id`, scope/provider/model/token/context fields、`raw_json`                            | Provider usage                                                                       |
| `goals`               | `id`, `session_id`, GoalState fields、`entity_revision`                                                 | 当前 Goal；历史变化仍写 trace/change                                                 |
| `plans`               | `id`, `session_id`, PlanState fields、`entity_revision`                                                 | 当前 Plan                                                                            |
| `plan_items`          | `id`, `plan_id`, `position`, title/status/result/evidence/cancel fields                                 | Plan item 顺序和状态                                                                 |
| `context_checkpoints` | `id`, `session_id`, `through_sequence`, `summary`, `provider_state_json`, `source_hash`, `created_at`   | compact checkpoint；不删除原始 messages                                              |

#### 同步与恢复

| 表                   | 关键字段                                                                     | 约束与用途                                                                        |
| -------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `session_change_log` | `session_id`, `state_revision`, `change_json`, `created_at`                  | 与领域变更同事务写入；支持短期增量补漏；复合主键为 `(session_id, state_revision)` |
| `file_changes`       | change id、`session_id`, `run_id`, path、before/after metadata、`created_at` | 取代独立全局 JSON change-history；具体容量策略另行确定                            |

`session_change_log` 是同步日志，不是第二真相源。可以按 retention 清理；请求的 `stateRevision` 已被清理时返回 snapshot-required。

### 6.3 通用数据库约束

- ID 使用稳定字符串 ID；由 backend 创建，renderer 不生成正式实体 ID。
- 时间统一保存 UTC RFC 3339 字符串。
- JSON 列写入前按 shared schema 校验，并使用 `CHECK(json_valid(...))`。
- Session-owned 子表使用 foreign key；删除/归档策略必须显式，不依赖散落的手工清理。
- Timeline entity 先从事务内的 `sessions.last_sequence` 分配 sequence，再插入 `timeline_entries` 和对应 subtype row。
- 消息、tool call/result、approval request/decision、usage、route snapshot 和 checkpoint 一旦提交即 immutable。
- Mutable entity 使用独立 `entityRevision`；任何 Session-owned durable transaction 同时递增 Session `stateRevision`。

---

## 7. Command、Query 与状态同步

### 7.1 API 形态

IPC 保留显式、typed channel，不使用无 schema 的通用 RPC。目标能力至少包括：

```text
app:get-bootstrap
project:list / project:add / project:update / project:remove
session:list / session:get / session:create / session:update / session:archive
session:update-draft
session:get-changes
run:start / run:interrupt / run:interject
approval:decide
goal:update / plan:update
```

主进程推送分成两类：

- `state:changed`：已提交的 canonical entity change。
- `run:stream`：文本/reasoning delta、runtime status、terminal output 等瞬时事件。

不能继续让同一 `AgentEvent` 同时承担数据库事实、流式传输、UI model 构造和 trace 四种职责。

### 7.2 Command envelope

会产生持久变更的 command 包含：

```ts
interface CommandEnvelope<T> {
  schemaVersion: 1
  commandId: string
  sessionId?: SessionId
  expectedEntityRevision?: number
  payload: T
}
```

- `commandId` 支持 IPC retry 幂等。
- `expectedEntityRevision` 用于 title/model/mode 所在的 SessionRecord，以及 draft、Plan 等各自会发生并发覆盖的 entity；它不使用 Session `stateRevision`。
- `run:start` 额外使用稳定 `clientRequestId`，并受数据库 unique constraint 保护。
- 冲突返回当前 entity revision 和最新 entity，不做 silent last-write-wins。

### 7.3 SessionChange

```ts
interface SessionChange {
  schemaVersion: 1
  sessionId: SessionId
  stateRevision: number
  upserts: SessionEntity[]
  deletes: EntityRef[]
  committedAt: string
}
```

Backend response 和 push 使用同一 change schema。发起请求的窗口可以先从 response 应用；随后收到重复 push 时依靠 `stateRevision` 幂等忽略。

### 7.4 Snapshot 和分页

应用启动只返回：

- public settings。
- project list。
- Session summaries。
- 当前选中 Session 的必要首屏数据。

完整历史按 `sequence` 分页。以下情况请求新的 snapshot：

- renderer 首次打开 Session。
- 应用/窗口重载。
- `stateRevision` gap。
- change cursor 过期。
- schema version 变化。

禁止恢复 `workbench:save` 式全应用快照覆盖。

---

## 8. 核心流程

### 8.1 创建 Session

1. Renderer 发送 `session:create`，包含 `projectId` 和可选初始 model/mode。
2. Backend 从当前 backend-owned defaults 补齐字段。
3. 单事务插入 Session，并写 `stateRevision = 1` 的 change。
4. Commit 后返回并发布 `SessionRecord`。
5. Renderer 将它加入 replica store 并导航到该 Session。

空 Session 是真实后端记录，不存在 renderer-only `transient` conversation。

### 8.2 更新 draft

输入控件可以立即显示本地字符。Renderer 对 draft 采用 debounce command：

1. 本地值标记为 pending。
2. 发送 `session:update-draft(expectedEntityRevision)`。
3. 后端更新 `session_drafts` 并发布 change。
4. Renderer 用确认值、entity revision 和 state revision 收口 pending。

应用关闭时可以主动 flush，但正确性不能依赖 renderer 的 dispose 回调一定执行。

### 8.3 更新模型和权限模式

模型下拉框发送带 SessionRecord `expectedEntityRevision` 的 `session:update`，更新 `SessionRecord.modelSelection`。它不直接改 provider settings，也不修改已经开始的 Run。

权限模式同样由后端更新。active Run 使用启动时冻结的 permission mode；Session 上的新值只影响后续 Run，避免运行中语义突变。

### 8.4 发送用户消息

`run:start` 在第一个事务中完成：

1. 校验 Session、model/mode entity revision、并发和 writer 条件，并预留所需 run slot/writer lease。
2. 追加 canonical user message 和 attachments。
3. 清空已提交 draft。
4. 从 Session model selection 解析 immutable `ModelRouteSnapshot`。
5. 创建 Run，冻结 route 和 permission mode。
6. 递增 Session `stateRevision` 和 sequence。
7. Commit 后发布 user message、Run 和 Session change。
8. 将预留 lease 交给 `RunRuntime` 并启动执行；事务失败时必须释放预留资源。

因此不会出现 UI 已经显示用户消息、但后端没有对应 Run/history 的状态。

### 8.5 Provider、工具和流式输出

1. `ProviderContextCompiler` 从 SQLite records/checkpoint 构建 provider-neutral上下文。
2. Provider adapter 编译成目标 provider request。
3. Text/reasoning delta 写入 backend run buffer，并通过 `run:stream` 推送。
4. Backend 周期性更新 `run_outputs`，用于 renderer 重连和进程崩溃后的 incomplete display。
5. Tool proposal、approval request、decision 和 result 分别获得 timeline sequence，并在各自事务提交后发布 state change；不能通过更新 proposal row 丢失真实顺序。
6. Provider 完成后，在同一事务写 assistant message、usage、continuation state 和 terminal Run status。
7. Commit 后清理/终结 run output，并发布最终 change。

最终 assistant message 不能由 renderer 聚合 delta 后自行创建。

### 8.6 重启恢复

应用启动时执行 recovery transaction：

- 将非终态 Run 标为 `interrupted`。
- 关闭不存在底层进程的 terminal/runtime records。
- 释放所有内存 writer/run lease；它们不能跨进程存活。
- 保留 `run_outputs` 作为 incomplete output。
- Session history、Goal、Plan、model selection、draft 和审批结果从 SQLite 恢复。

下一次 Run 从最新适用 checkpoint 加后续 canonical records 重建 context。恢复不能依赖上一进程的 `SessionRuntime`。

---

## 9. Model Route 与 Provider Context

### 9.1 两层模型状态

模型状态明确分为：

- `Session.modelSelection`：下一次 Run 的用户选择。
- `Run.modelRouteSnapshot`：这次执行实际使用的不可变事实。

`ModelRouteSnapshot` 包含 provider id/label、protocol、profile、base URL、model、reasoning、context window、max output 和 capability source，但不包含 API key。

全局 provider 默认值只用于新 Session 或用户明确“恢复默认”。改变全局默认不能让现有 Session 静默换模型。

### 9.2 Provider continuation

Provider continuation state 是 opaque JSON，并绑定：

- Session。
- Run/provider call。
- ModelRouteSnapshot。
- `throughSequence`。

Provider adapter 可以复用兼容 continuation。切换 provider/model/protocol 后若不兼容，compiler 必须回退到 canonical history replay，不能丢弃历史或错误复用旧 token。

### 9.3 Prompt Harness

Base instructions、runtime context、assistant preferences、AGENTS、selected context、skills、slash/orchestration request 均形成 canonical harness/message record，并记录 source、prompt id/version/hash 和 audience。

Prompt selection 可以裁剪普通历史，但 pinned layers、compact checkpoint 和当前用户轮必须保持协议完整。每次 provider request 继续把 prompt build、resource hash 和最终 normalized messages 写入 trace。

---

## 10. Run 编排、并发与工具

现有 Agent loop、Prompt Harness、ToolRegistry、PermissionPipeline、TerminalPool、MCP、Skills、ProjectModel 和 Code Intelligence 能力继续保留，但它们通过 application/runtime service 修改 canonical state。

### 10.1 并发不变量

- 每个 Session 同时最多一个 active Run。
- 全应用 `maxConcurrentRuns` 限制不变。
- 同一 canonical workspace 同时最多一个非 readonly writer Run。
- `readonly` Run 不获取 writer lease。
- writer lease 覆盖 provider、工具、审批等待、interjection continuation 和 cancelling。
- 有不可中止副作用仍在执行时，Run 可以进入用户可见终态，但 writer 必须延迟释放到副作用真正 settle。

Writer lease 属于 backend runtime，不持久化为可恢复锁。Run record 和 trace 记录获得、拒绝、释放事实；重启时所有旧 lease 失效。

### 10.2 工具与审批

- Tool call 先规范化和校验，再追加 immutable `ToolCallRecord`。
- 需要人工审批时追加 `ApprovalRequestRecord`；renderer 只提交 decision command，后端再追加 `ApprovalDecisionRecord`。Pending 状态由 request 尚无 terminal decision 推导。
- Tool result 必须先落盘，再进入下一次 provider context。
- 拒绝、取消、超时同样形成结构化 result。
- Tool output 继续执行字节/token/条目上限。
- Workspace path、resource precondition 和 tool ownership 是执行不变量，不因本地桌面威胁模型放宽。

### 10.3 Goal、Plan 和 interjection

Goal/Plan 从 SessionRuntime 移入 SQLite tables。模型工具和 renderer command 都调用相同 application service，不得一方只改内存。

Interjection 的 queued/injected/superseded/carryover 状态由后端保存。它进入 provider context 后形成 canonical message；renderer 只根据状态渲染。

### 10.4 Compact

Compact 生成 `context_checkpoints` 和对应 canonical compaction message。它记录 `throughSequence`、source hash、Goal/Plan snapshot 和必要 provider state，但不重写或删除旧 messages。

---

## 11. 配置、Secrets 与其他存储

“Backend authoritative”不等于所有内容必须进入同一个数据库。

目标存储边界：

| 数据                                                               | 存储                                         | 所有者                  |
| ------------------------------------------------------------------ | -------------------------------------------- | ----------------------- |
| Projects、Sessions、Runs、timeline、Goal/Plan、draft、file changes | `userData/agent.db`                          | backend                 |
| 非敏感应用/provider 配置                                           | backend config repository；可后续迁入 SQLite | backend                 |
| API keys                                                           | Electron safeStorage-backed secret store     | backend                 |
| Trace                                                              | `userData/traces/*.jsonl`                    | backend                 |
| Skills                                                             | `userData/skills/`                           | backend manager         |
| ProjectModel                                                       | workspace `.zch/project-model.json`          | backend project service |
| Prompt resources                                                   | versioned application resources              | backend registry        |

Renderer 只能读取经过筛选的 public config snapshot。API key、Authorization 和 safeStorage 密文不进入 renderer、Session records 或 trace。

配置的 mutation 同样走 command → backend store → committed snapshot → renderer，不允许 settings form 只改 Pinia。

---

## 12. Renderer 架构

### 12.1 Replica stores

目标 store 分层：

```text
app-shell-store          bridge/bootstrap/window UI
project-replica-store    backend ProjectRecord copies
session-replica-store    SessionRecord and paged canonical entities
run-stream-store         backend stream buffers and connection state
settings-replica-store   public backend settings copies
ui-store                 selection/layout/scroll/panel state
```

Pinia action 可以发送 command，但不得在成功前直接把领域值当成 canonical state。收到 response/change 后统一通过 reducer/upsert 路径更新 replica。

### 12.2 Renderer 可以派生但不能发明

Renderer 可以：

- 直接按 sequence 渲染 canonical timeline，并按 call/approval ID 把相关实体投影成工具卡和审批卡。
- 根据 canonical kind 决定隐藏、折叠或使用哪个组件。
- 计算 badge、搜索索引和展示用 summary。
- 缓存分页结果。

Renderer 不可以：

- 自行创建正式 message、Run、ToolCall 或 Approval。
- 聚合 delta 后自行认定 assistant message completed。
- 将 model dropdown 值只写入 form/store。
- 保存整个 Session/workbench 文件。
- 在切换 Session 时把一份 frontend record 写回另一份 record。

### 12.3 UI-only 状态

以下状态可以只在 renderer：

- 当前导航和选中的 Session。
- 面板尺寸、展开状态和滚动位置。
- hover、selection、modal open/close。
- IME composition。
- 尚未确认的输入值和 command pending/error。

如果产品要求某项 UI preference 跨重启恢复，它会升级为 backend-owned preference，而不是直接增加 renderer localStorage 真相源。

---

## 13. IPC 与 Electron 边界

Preload 继续只暴露冻结的 typed API，不暴露 `ipcRenderer`。每个 command/query/result/change 都按 `shared/` schema 校验。

本项目不以防御已完全控制本机的恶意软件为目标，因此不引入数据库加密、多用户 ACL、本地记录签名或防止同一 OS 用户读取对话的机制。

仍保留：

- renderer sandbox 和 contextIsolation。
- sender/frame/origin 与 payload/result schema 校验。
- CSP、导航和 window/webview 限制。
- secrets 不进入 renderer。
- workspace path 和 resource ownership 校验。
- 子进程环境 allowlist。
- tool approval、abort 和 bounded output。

这些边界主要防止模型误操作、prompt injection、renderer bug 和依赖漏洞，同时维护业务不变量，不是为了对抗 root 级本机攻击者。

---

## 14. Trace、回放与导出

SQLite 是产品状态的真相源；JSONL trace 是可选审计和调试记录，不能承担 Session 恢复。

Trace 继续记录：

- Session/Run lifecycle 和 route snapshot。
- prompt build、normalized messages 和 provider request/response。
- text/reasoning stream、usage 和 continuation metadata。
- tool、approval、interjection、Goal/Plan、writer 和 terminal 事件。

Trace sequence 与 Session entity sequence 是不同命名空间。Trace 可以比产品状态更详细，也可以在 logging 关闭时不存在。

Conversation Markdown import/export 以 canonical messages 为输入。Restricted session transcript 可以组合 SQLite state 与 trace；缺少 trace 时必须明确省略 provider wire/runtime 细节，不能把产品 state 冒充完整 trace。

---

## 15. Project、Terminal、Skills、MCP 与插件

这些服务仍在 backend：

- Project explorer 和 code intelligence 通过 query 返回 canonical public records。
- Terminal 的 PTY process、scrollback 和 ownership 属于 backend runtime；renderer 只显示 terminal stream。应用重启不恢复真实 PTY process。
- Skills manager 扫描、安装和启用 skill；renderer 只提交 command 和显示状态。
- MCP manager 拥有连接、目录 revision、tool normalization 和调用。
- Plugin event bus 是 backend hook/event 机制，不是 renderer 插件运行时。

这些服务如需修改 Session timeline、Goal/Plan 或 tool state，必须调用 application service，不能直接向 renderer 发一个无法恢复的临时事实。

---

## 16. Headless、Benchmark 与 Runtime Parity

Headless 和 Benchmark 继续复用唯一 Agent runtime。v2 要求把 persistence 也纳入 parity：

- 每次 benchmark trial 使用独立临时 SQLite database。
- desktop fake-provider 和 headless fake-provider trajectory 比较 canonical records、provider messages、tool results、prompt hashes 和最终 patch。
- Runtime identity 继续包含 source commit、prompt/tool hash、provider/model/profile/reasoning 和预算。
- Benchmark artifacts 可以导出数据库中的 canonical transcript，但不得依赖 renderer store。
- Trial resume 不恢复未完成 container/runtime；数据库和 artifacts 只在完整终态后封存。

Docker worker、isolated grader、credential proxy、case identity、pass@k 独立 workspace 和 cleanup hard gate 的现有边界不因状态架构重构而改变。

---

## 17. 迁移方案

### 17.1 一次性导入

首次打开 v2 database 时：

1. 创建并迁移 `agent.db`。
2. 如果存在 `workbench.json` 且没有 import marker，先复制只读备份。
3. 在单一事务中导入 projects 和 conversations。
4. 每个旧 Conversation 创建同 ID 或稳定映射的 Session。
5. 导入可见 messages、tool activities、usage、Goal、Plan、draft、attachments 和 fork metadata。
6. 写入 import marker 和来源 hash。
7. Commit 成功后才启用新 repository；失败时保留旧文件且不写半成品。

旧 `workbench.json` 没有完整保存 backend provider history、harness layers 和 continuation state，因此不能完美恢复。迁移 Session 必须标记：

```text
historyFidelity = legacy_display_only
```

迁移器不得伪造不存在的 provider history。旧 Session 后续执行可以采用明确的 visible-history replay/summary 策略，并在 UI 或内部诊断中说明上下文保真度有限。

### 17.2 切换原则

迁移不采用长期双写。正确顺序是：

1. 引入 shared canonical schemas、SQLite 和 repository tests。
2. 引入 backend Session/Run application services。
3. Runtime 改为从 repository 构建 history 并事务性写结果。
4. Renderer 改为 query/command/change replica。
5. 一次性启用 importer 并切换真相源。
6. 删除 `workbench:save`、frontend persistence 和 memory-only canonical history。

任何阶段都只能有一个明确真相源。兼容 adapter 可以读旧格式并写新格式，不能让两个方向互相覆盖。

### 17.3 明确移除项

- `userData/workbench.json` 作为活动存储。
- `PersistedWorkbench.conversations`。
- frontend-owned `ConversationRecord`。
- `conversationIdBySessionId`。
- renderer 250ms 全 workbench save。
- `SessionState.history` 作为唯一 provider context。
- 只修改 provider form、不提交 Session selection 的模型下拉框行为。

---

## 18. 测试与架构不变量

### 18.1 必须新增的测试层

- Shared schema contract tests。
- SQLite migration、foreign key、transaction rollback 和 codec round-trip tests。
- Repository tests 使用真实临时 SQLite 文件。
- Application command idempotency、entity revision conflict 和 commit-before-publish tests。
- Runtime crash/restart recovery tests。
- Renderer replica reducer、state revision gap 和 pending reconciliation tests。
- Electron full relaunch E2E，不以 `page.reload()` 代替进程重启。
- Desktop/Headless persistence parity tests。

### 18.2 核心恢复回归

必须覆盖以下端到端不变量：

1. 用户发送消息 A。
2. Provider 产生 tool call、tool result 和最终回复。
3. 完整退出 Electron 主进程。
4. 使用相同 `userData` 重启。
5. 在同一 Session 发送消息 B。
6. 断言新 provider request 包含正确的 A、assistant/tool 历史、B、checkpoint 和 route 语义。

还必须覆盖：

- model selection 修改只影响后续 Run。
- 已开始 Run 的 route/mode 不随 Session 修改漂移。
- interrupted Run 恢复为明确终态并保留 partial output。
- renderer 不能只靠本地 mutation 产生持久消息。
- duplicate command/clientRequestId 不产生重复消息或 Run。
- state revision gap 必须 snapshot resync。
- tool result 未 commit 时不得进入下一次 provider request。

### 18.3 质量门禁

现有 `npm test`、typecheck、lint、format、native、ripgrep、E2E、real-provider 和 benchmark opt-in 门禁继续保留。数据库 driver 引入后，打包和 native ABI smoke 必须覆盖开发环境与目标 Electron runtime。

---

## 19. 当前迁移状态

本文描述目标架构。当前代码仍存在以下已知 legacy 状态：

- renderer Pinia 保存 conversation 和 timeline，并整体写入 `workbench.json`。
- main-process Session history 主要位于内存。
- restart 后 UI history 与 provider history 可能不一致。
- Session 和 Conversation 使用不同 ID/生命周期。
- composer model selection 与实际 Session route 不是同一 canonical mutation。

这些不是 v2 允许的长期折中。任何涉及 Session、模型选择、历史恢复或 renderer persistence 的新功能，都应优先落到 v2 migration，不得继续扩大 legacy 数据流。
