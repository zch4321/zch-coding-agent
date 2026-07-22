# 架构设计文档 · Zch Coding Agent

> 状态：Backend Architecture v2.1 目标规范 · 2026-07-22
>
> 配套文档：[`requirements.md`](./requirements.md) 定义产品能力，[`frontend-spec.md`](./frontend-spec.md) 定义前端信息架构与交互验收。
>
> 本文是后续重构的规范性目标，不表示所有内容已经实现。迁移期间，新增代码必须遵守本文边界；旧 `workbench.json`、renderer-owned conversation 和 memory-only canonical history 仅作为待移除的兼容实现，不得继续扩展。

---

## 1. 架构目标

Zch Coding Agent 是 Electron + Vue 3 桌面 coding agent。Backend 负责 Project 注册表、Session 元数据、完整消息历史、文件变更历史、Agent 编排和宿主能力；renderer 负责展示、收集输入并保存后端状态的副本。

目标结构：

```text
Renderer (Vue + Pinia)
  ├─ UI-only state：draft、draft attachments、layout、selection
  └─ backend replicas：Project、Session、complete Messages、Goal、Plan、FileChangeSummary
          │ commands / queries
          ▼
Preload typed bridge
          │ validated IPC
          ▼
Backend application services
  ├─ SessionService
  ├─ LiveSessionContext / ActiveRunExecution
  ├─ Provider / Prompt / Tool / Permission services
  └─ SQLite repositories
          │ commit complete records
          ▼
SQLite
  ├─ Project registry / Session metadata
  ├─ complete, ordered Messages
  └─ bounded FileChanges / revert payloads
```

本次重构解决：

- renderer 不再拥有独立于 backend 的 Conversation 真相。
- `ConversationRecord` 与 main-process session history 不再表示同一对话的两套不同数据。
- 应用重启后可以从 SQLite 重建完整、协议有效的 OpenAI-compatible messages。
- 模型、权限模式、Goal 和 Plan 的提交都经过 backend。
- renderer 不再保存整个 workbench 快照。
- Run、stream delta、pending approval 和进程句柄明确属于 backend memory，不因为“后端拥有状态”而过度落盘。

---

## 2. 状态所有权与持久化边界

### 2.1 Backend 是已提交领域状态的唯一真相源

持久状态变更流程固定为：

1. Renderer 发送 typed command。
2. Backend 校验 command。
3. Backend 在 SQLite transaction 中更新 Project/Session、插入完整 Message，或记录完整 FileChange。
4. Commit 成功后返回并推送新的 record/revision。
5. Renderer 用 backend record 更新本地副本。

数据库提交失败时，renderer 只能显示 pending/error，不能把请求值当成已提交事实。

### 2.2 状态分为三类

| 类别                      | 所有者           | 是否落盘 | 示例                                                                                           |
| ------------------------- | ---------------- | -------- | ---------------------------------------------------------------------------------------------- |
| Durable application state | backend + SQLite | 是       | Projects、Session metadata、完整 messages、Goal/Plan、有界 FileChanges/revert payloads         |
| Ephemeral execution state | backend memory   | 否       | active Run、stream buffer、AbortController、pending approval、writer lease、PTY/MCP connection |
| UI-only state             | renderer         | 否       | draft、draft attachments、IME composition、scroll、panel、selection                            |

“Backend authoritative”不等于“所有 backend 状态必须落盘”。只有应用重启后仍应存在、并参与后续模型历史或产品展示的完整记录才进入 SQLite。

### 2.3 明确允许丢失的状态

以下内容在 renderer reload、窗口切换或应用崩溃后不保证恢复：

- 未发送 draft 和 draft attachments。
- 尚未完成的 assistant text/reasoning delta。
- 尚未完成的 tool batch 和 pending approval。
- Active Run 的内存状态。
- 真实 PTY、网络请求、provider stream 和子进程。

应用崩溃后丢失一部分未完成输出是接受的产品行为。数据库不写 partial assistant message，也不为每个 token 执行 transaction。

### 2.4 Canonical schema 只定义一次

`ProjectRecord`、`SessionRecord` 和 `MessageRecord` 在 `shared/` 用 TypeBox 定义。Renderer、backend、IPC 和 database codec 使用同一 schema，不再在 `src/` 与 `electron/` 分别维护语义不同的 Project/Conversation/Message 类型。

`file_changes.before_content` 是唯一一个明确的宿主私有恢复 payload：它有 backend 内部 codec，但不属于 renderer 状态。`shared/` 只定义不含该字段的 `FileChangeSummary` IPC schema。

SQLite 可以使用关系型列名，但必须满足：

```text
decode(encode(record)) deep-equals record
```

---

## 3. 进程与代码边界

### 3.1 `shared/`

```text
shared/
  project.ts              # ProjectRecord
  session.ts              # SessionRecord / SessionSnapshot
  message.ts              # canonical MessageRecord
  file-change.ts          # FileChangeSummary IPC schema
  runtime-events.ts       # ephemeral Run/stream events
  commands.ts             # commands / queries / results
  ipc-contract.ts
  config.ts
  ids.ts
```

`shared/` 不导入 Electron、Node.js、Vue、Pinia、SQLite driver 或 provider implementation。

### 3.2 `electron/`

```text
electron/
  application/
    session-service.ts
    message-history-compiler.ts
  persistence/
    database-service.ts
    migrations/
    repositories/
      project-repository.ts
      session-repository.ts
      message-repository.ts
      file-change-repository.ts
    codecs/
  runtime/
    live-session-context.ts
    active-run-execution.ts
  providers/
  prompts/
  tools/
  permission/
  terminal/
  project/
  skills/
  mcp/
  logging/
  ipc/                    # host adapter，不包含领域逻辑
```

Persistence 是独立代码层，但不是独立进程、IPC service 或通用 ORM：

- `DatabaseService` 拥有 SQLite connection、migration、PRAGMA、关闭流程和 `withTransaction()`。
- Repository 只执行领域相关 SQL，输入输出是 shared canonical record，或明确的 backend-private `StoredFileChangeRecord`；它们接受 transaction handle，但不自行 begin、commit 或发布事件。
- Codec 只负责 SQLite row 与 `ProjectRecord/SessionRecord/MessageRecord/StoredFileChangeRecord` 的字段名、JSON 和时间格式转换，并在边界执行对应 schema 校验。
- Application service 拥有业务事务边界，负责在同一个 transaction 中分配 seq、插入 messages、递增 Session revision，并在 commit 后发布 records。

Persistence 不导入 provider adapter，不判断哪些消息进入模型请求，也不把 `MessageRecord` 转成 provider DTO。禁止为了抽象而引入 `BaseRepository`、动态 query DSL，或另一套语义不同的 `DatabaseSession/DatabaseMessage` 领域模型。

IPC handler 只负责边界校验、调用 application service 和编码结果，不能直接修改 repository、SQLite connection 或 runtime map。

### 3.3 `src/`

Renderer 只保存：

- Project/Session/Message/FileChangeSummary/backend settings 的副本。
- Run stream 的瞬时展示状态。
- command pending/error。
- draft、附件选择和其他纯 UI 状态。

它不能访问 SQLite、workspace、secrets 或 provider，也不能持久化 Project/Session/FileChange。

### 3.4 Host-neutral runtime

Electron 和 Headless 复用同一个 application/runtime composition：

- Desktop 使用 `userData/agent.db`。
- Headless/benchmark 使用任务独立的临时 SQLite database。
- Repository tests 使用真实临时 SQLite 文件。

Headless 不复制 Prompt、Provider、Tool、Permission、compact 或 Agent loop。

---

## 4. 领域术语

### 4.1 Project

Project 对应一个 canonical workspace。数据库使用稳定 `projectId`，路径是可变属性，不作为跨表主键。

### 4.2 Session

Session 是持久化对话，也是 UI 中“对话”的唯一领域实体。不再存在独立 Conversation record 或 `conversationId -> sessionId` 映射。

Session 保存：

- project、title、lifecycle。
- 当前 provider/model/reasoning selection。
- 当前 permission mode。
- 当前 Goal/Plan。
- fork metadata。
- `revision` 和 `lastSeq`。

### 4.3 Message

Message 是 SQLite 中唯一的对话历史单位。它既能投影为 UI timeline，也能重建 provider messages。

Message 必须完整后才写入数据库：

- 用户点击发送时，user message 已完整。
- Provider 一个 assistant turn 完成后，assistant message 才完整。
- 一个 tool call 得到 terminal result 后，tool message 才完整。
- Harness/context layer 构造完毕后才写入。

数据库中不存在 partial message。

### 4.4 Run

Run 是一次活动执行，不是持久化领域实体。Backend 为它分配临时 `runId/turnId`，用于：

- IPC stream routing。
- 中断、interjection 和 approval。
- 关联当前 provider/tool loop。
- trace correlation。

Run 完成或应用退出后，`ActiveRunExecution` 销毁。完成的结果已经体现在 messages；失败、取消和详细执行轨迹由可选 trace 记录。

Messages 可以保存 `turnId` 作为相关性字段，但不存在 `runs` foreign key 或 `runs` table。

---

## 5. Canonical 数据结构

### 5.1 ProjectRecord

```ts
interface ProjectRecord {
  schemaVersion: 1
  id: ProjectId
  path: string
  name: string
  revision: number
  createdAt: string
  updatedAt: string
}
```

`path` 是 Backend 在添加项目时通过平台路径规则和 `realpath` 规范化的绝对 workspace 路径；数据库以它去重，但 Session 只保存稳定 `projectId`。目录移动或用户显式重新关联后可以更新 `path`，不能通过路径级联重写 Session。

`name` 默认取目录名。ProjectModel、module、Serena/code intelligence 配置不进入 `projects` 表，继续由 workspace 内 `.zch/project-model.json` 管理。

### 5.2 SessionRecord

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
  goal: GoalState | null
  plan: PlanState | null
  parent?: {
    sessionId: SessionId
    forkedFromSeq: number
  }
  historyFidelity: 'complete' | 'legacy_display_only'
  revision: number
  lastSeq: number
  createdAt: string
  updatedAt: string
  archivedAt?: string
}
```

`modelSelection` 是下一次执行使用的当前选择。已完成 assistant message 另外记录实际使用的 `ModelRouteSnapshot`。

### 5.3 MessageRecord

```ts
interface ProviderContinuationEnvelope {
  schemaVersion: 1
  adapterId: string
  format: string
  data: JsonValue
}

interface MessageMetadataV1 {
  schemaVersion: 1
  attachments?: Array<{
    ref: string
    name: string
    mimeType?: string
    snapshotHash?: string
  }>
  prompt?: {
    resourceId: string
    version: string
    hash: string
  }
  usage?: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
  }
  tool?: {
    name: string
    reason?: string
    status: 'completed' | 'denied' | 'failed' | 'cancelled' | 'timed_out'
    truncated: boolean
    durationMs?: number
  }
  approval?: {
    decision: 'approved' | 'denied'
    source: 'user' | 'rule' | 'model'
  }
  compact?: {
    replacesThroughSeq: number
    sourceHash: string
  }
  reasoningProjection?: {
    truncated: boolean
    omittedOpaqueBlocks: boolean
  }
}

interface MessageRecord {
  schemaVersion: 1
  id: MessageId
  sessionId: SessionId
  seq: number
  turnId?: string
  clientRequestId?: string

  kind:
    | 'user_input'
    | 'assistant_turn'
    | 'tool_result'
    | 'harness'
    | 'runtime_context'
    | 'agents_context'
    | 'orchestrator'
    | 'interjection'
    | 'compact_summary'

  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  normalizedReasoningText?: string
  toolCalls?: JsonValue[]
  toolCallId?: string
  providerContinuation?: ProviderContinuationEnvelope
  modelRoute?: ModelRouteSnapshot
  metadata?: MessageMetadataV1

  inHistory: boolean
  createdAt: string
}
```

字段职责：

- `kind`：应用内部语义，renderer、搜索、导出和 compact policy 用它区分用户输入、编排注入和其他消息；它永远不发送给 Provider。
- `role/content/toolCalls/toolCallId`：provider-neutral、可无损重建公共消息序列的协议字段。不能根据 `kind` 或内容标签临时猜测。
- `normalizedReasoningText`：可选、非加密、应用标准化后的可读 reasoning 文本或摘要，只用于 UI、导出和通用审计；它不是原始 CoT，也不能用于反向重建 Provider continuation。
- `providerContinuation`：可选的 provider-native continuation envelope。Core 只验证外壳并原样搬运 `data`；只有 `adapterId + format` 对应的 Provider Adapter 可以解释它。
- `modelRoute`：已完成 assistant turn 实际使用的 route，便于 UI 和审计。
- `metadata`：应用拥有并理解的 typed annotations，例如 attachment provenance、prompt id/hash、标准化 usage、approval/tool/compact 摘要和 reasoning projection 状态。
- `inHistory`：是否属于下一次 provider request 的 canonical active history。

`metadata`“与 Provider 协议无关”指的是：它可以来源于 Provider，例如标准化 usage，但删除 metadata 只能损失 UI、统计或审计信息，不能让下一次 Provider request 失去协议完整性。任何必须原样回传、只由 Adapter 理解、或影响 continuation 正确性的字段都必须进入 `providerContinuation`，不能藏在 metadata 中。完整原始 Provider request/response、headers 和 stream events 属于可选 trace，也不进入 metadata。

实际 shared schema 应按 `MessageRecord.kind` 对 metadata 使用 discriminated union；上面的 `MessageMetadataV1` 汇总允许出现的字段，不能作为接受任意键的开放字典。

`kind` 与 `role` 正交。相同的 provider role 不代表相同的产品语义：

| `kind`            | 常见 `role` | 含义                                    |
| ----------------- | ----------- | --------------------------------------- |
| `user_input`      | `user`      | 用户亲自提交的消息                      |
| `orchestrator`    | `user`      | 编排器注入的 tagged user-role message   |
| `runtime_context` | `user`      | Runtime context 注入                    |
| `harness`         | `system`    | Base instructions 或其他 harness layer  |
| `assistant_turn`  | `assistant` | 完整 assistant 文本或 tool-call turn    |
| `tool_result`     | `tool`      | 一个 tool call 的 terminal result       |
| `compact_summary` | `user`      | 代替旧 active history prefix 的完整摘要 |

持久化和请求边界固定为：

```text
SQLite row
  <-> Message codec
MessageRecord[]
  -> MessageHistoryCompiler
CompiledProviderHistory
  ├─ ProviderMessage[]
  └─ ProviderContinuationEnvelope references
  -> ProviderAdapter
OpenAI / DeepSeek / Anthropic request DTO
```

`CompiledProviderHistory` 是瞬时内存结构，并保留 continuation 与来源 assistant message 的关联：

```ts
interface CompiledProviderHistory {
  entries: Array<{
    sourceMessageId: MessageId
    message: ProviderMessage
    sourceModelRoute?: ModelRouteSnapshot
    continuation?: ProviderContinuationEnvelope
  }>
}
```

SQLite 不保存某个 Provider SDK 的原始请求 DTO。`MessageRecord` 保存公共、完整的消息字段、可读 reasoning 投影，以及恢复 continuation 所需的可选 opaque envelope；它不保存完整 wire request。`MessageHistoryCompiler` 校验 active history 的协议完整性，不把 `kind`、数据库 ID、`normalizedReasoningText` 或 UI metadata 放入 `ProviderMessage`；`sourceMessageId` 只在内存中关联对应 `providerContinuation`，最终也不会进入 wire request。最后由 Provider Adapter 转成具体 DTO。对 OpenAI-compatible Provider，这通常只是字段选择和命名转换，但仍必须保留该边界。

### 5.4 FileChangeSummary 与 StoredFileChangeRecord

Renderer 只需要展示 Diff 历史并发起“回退” command，因此 `shared/` 中的公开结构不包含文件恢复内容：

```ts
interface FileChangeSummary {
  schemaVersion: 1
  id: FileChangeId
  sessionId: SessionId
  turnId?: string
  callId: string
  path: string
  operation: 'write' | 'patch' | 'delete'
  diff: string
  diffHash: string
  diffTruncated: boolean
  beforeExists: boolean
  beforeHash: string
  afterExists: boolean
  afterHash: string
  revision: number
  createdAt: string
  updatedAt: string
  revertedAt?: string
}

interface StoredFileChangeRecord extends FileChangeSummary {
  beforeContent: string | null
  payloadBytes: number
}
```

`StoredFileChangeRecord` 只属于 Backend repository 和 SQLite。`path` 是相对于 Project workspace 的路径。`beforeContent` 是回退 payload：

- 修改或删除已有文件时，保存完整、受限的 UTF-8 修改前内容。
- 创建新文件时，`beforeExists = false` 且 `beforeContent = null`；回退动作删除该文件。
- 不保存 `afterContent`；回退只需要 `beforeContent`，冲突检查使用当前文件的 existence 与 `afterHash`。

Hash 都是对 UTF-8 内容计算的 SHA-256。文件不存在时使用 `exists = false` 区分状态，hash 列保存空字节串的 SHA-256，不把空文件和不存在混为一种状态。

Renderer 只能通过 IPC 获得 `FileChangeSummary`。这不违反“Session 数据在前端、后端、数据库一致”的约束：FileChange 是独立的宿主恢复记录，不是 Session 字段或 Message。Renderer 不执行回退，也不持有恢复快照。

### 5.5 SessionSnapshot

```ts
interface SessionSnapshot {
  session: SessionRecord
  messages: MessageRecord[]
}

interface SessionOpenResult {
  snapshot: SessionSnapshot
  runtime?: ActiveRunPublicSnapshot
}
```

`SessionSnapshot` 只包含数据库可无损恢复的 canonical data。`SessionOpenResult.runtime` 是独立的 backend-memory snapshot，仅用于 renderer reload 后恢复当前活动展示；它不是 Session data。

历史可以按 `seq` 分页。Renderer 持有的是 canonical records 的部分副本，不是另一套结构。

---

## 6. SQLite 表设计

### 6.1 文件与连接

Desktop database：

```text
userData/agent.db
```

主进程使用一个 connection 和串行 write queue：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

业务模块不能各自创建 connection 或绕过 transaction service。

### 6.2 核心表

目标持久化模型刻意保持小：

| 表                  | 用途                                       |
| ------------------- | ------------------------------------------ |
| `schema_migrations` | 数据库 schema 迁移                         |
| `projects`          | Project/workspace 元数据                   |
| `sessions`          | Session 元数据和当前 Goal/Plan             |
| `messages`          | 完整、排序、可重建 provider history 的消息 |
| `file_changes`      | 文件变更与有界 revert 数据；不属于消息历史 |

不存在以下表：

- `session_drafts` / `session_draft_attachments`。
- `runs` / `run_outputs`。
- `timeline_entries` / tool/approval subtype tables。
- `context_checkpoints`。
- `session_change_log`。
- `processed_commands`。

### 6.3 `schema_migrations`

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version          INTEGER PRIMARY KEY CHECK (version > 0),
  name             TEXT NOT NULL UNIQUE,
  checksum_sha256  TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  app_version      TEXT NOT NULL,
  applied_at       TEXT NOT NULL
);
```

这是 SQLite infrastructure state，不是产品领域记录，不进入 shared schema、IPC 或 renderer。`version` 定义顺序，`name` 提供可读识别，`checksum_sha256` 检测已应用文件被修改，`app_version/applied_at` 用于诊断数据库由哪一版应用在何时升级。

Migration 规则：

1. `DatabaseService` 打开 connection、设置 PRAGMA，并 bootstrap 这张表。
2. Migration 文件以递增版本命名，例如 `0001_initial.sql`。
3. 每个 pending migration 使用 `BEGIN IMMEDIATE`，schema/data change 与对应 migration row 在同一 transaction commit。
4. 已应用 migration 不得修改；启动时发现相同 version 的 checksum 不一致必须失败，不得静默覆盖。
5. 数据库版本高于当前应用支持版本时拒绝启动该 repository，并返回明确升级/降级错误。
6. Desktop runtime 只执行 forward migration，不自动执行 destructive down migration。

### 6.4 `projects`

```sql
CREATE TABLE projects (
  schema_version  INTEGER NOT NULL,
  id              TEXT PRIMARY KEY,
  path            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

Backend 在 insert/update 前规范化并校验 `path`。`UNIQUE(path)` 防止同一个 canonical workspace 被重复添加；`id` 才是其他表使用的稳定 identity。

`project:remove` 表示删除应用中的 Project、Sessions、Messages 和 FileChanges，不删除 workspace 目录或其中任何文件。Application service 必须先确认该 Project 没有 active Run/approval/runtime resource，再在单一 transaction 删除 Project；外键 cascade 清理其应用记录。

### 6.5 `sessions`

```sql
CREATE TABLE sessions (
  schema_version     INTEGER NOT NULL,
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  lifecycle          TEXT NOT NULL,
  permission_mode    TEXT NOT NULL,
  provider_id        TEXT NOT NULL,
  model              TEXT NOT NULL,
  reasoning          TEXT NOT NULL,
  goal_json          TEXT,
  plan_json          TEXT,
  parent_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  forked_from_seq    INTEGER,
  history_fidelity   TEXT NOT NULL,
  revision           INTEGER NOT NULL,
  last_seq           INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  archived_at        TEXT
);
```

`goal_json` 和 `plan_json` 使用 shared schema 校验。当前产品只按 Session 读取，不需要为 Plan item 建立跨 Session 查询，因此不拆表。

### 6.6 `messages`

```sql
CREATE TABLE messages (
  schema_version       INTEGER NOT NULL,
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq                  INTEGER NOT NULL,
  turn_id              TEXT,
  client_request_id    TEXT,
  kind                 TEXT NOT NULL,
  role                 TEXT NOT NULL,
  content              TEXT,
  normalized_reasoning_text    TEXT,
  tool_calls_json      TEXT,
  tool_call_id         TEXT,
  provider_continuation_json   TEXT
    CHECK (
      provider_continuation_json IS NULL
      OR json_valid(provider_continuation_json)
    ),
  model_route_json     TEXT,
  metadata_json        TEXT
    CHECK (
      metadata_json IS NULL
      OR json_valid(metadata_json)
    ),
  in_history           INTEGER NOT NULL CHECK (in_history IN (0, 1)),
  created_at           TEXT NOT NULL,
  UNIQUE (session_id, seq),
  UNIQUE (session_id, client_request_id)
);

CREATE INDEX messages_history_idx
  ON messages(session_id, in_history, seq);

CREATE INDEX messages_turn_idx
  ON messages(session_id, turn_id, seq);
```

`provider_continuation_json` 保存完整 `ProviderContinuationEnvelope` JSON；`data` 保留 Adapter 提供的原始 JSON 结构和数组顺序。若供应商状态需要逐字节保持，Adapter 必须把原始字节编码成 envelope `data` 中带明确 format 的 base64/string，通用 codec 不得解析后重组。Repository 只验证 envelope 外层，Adapter 再按 `adapterId/format` 验证 `data`。

`normalized_reasoning_text` 只保存可读明文投影，不保存签名、密文、redacted block、response cursor 或 provider item id。`metadata_json` 保存按 Message `kind` 校验的 `MessageMetadataV1` JSON；未知键默认拒绝，不能用它绕过 `provider_continuation_json` 的 Adapter ownership。

所有 JSON 列在 application boundary 按 shared schema 校验，并使用 `CHECK(json_valid(...))` 或等价 codec 约束。Nullable JSON 需要允许 SQL `NULL`。`provider_continuation_json` 通常只在 `kind = 'assistant_turn'` 时非空；它不得包含凭据、Authorization header、完整 wire request、usage 或 timing。

`UNIQUE(session_id, client_request_id)` 只对 `kind = 'user_input'` message 的非空 request id 生效，用于阻止一次发送被重复插入；其他 message 的该字段为 `NULL`。

### 6.7 `file_changes`

```sql
CREATE TABLE file_changes (
  schema_version  INTEGER NOT NULL,
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id         TEXT,
  call_id         TEXT NOT NULL,
  path            TEXT NOT NULL,
  operation       TEXT NOT NULL CHECK (operation IN ('write', 'patch', 'delete')),
  diff            TEXT NOT NULL,
  diff_hash       TEXT NOT NULL CHECK (length(diff_hash) = 64),
  diff_truncated  INTEGER NOT NULL CHECK (diff_truncated IN (0, 1)),
  before_exists   INTEGER NOT NULL CHECK (before_exists IN (0, 1)),
  before_hash     TEXT NOT NULL CHECK (length(before_hash) = 64),
  before_content  TEXT,
  after_exists    INTEGER NOT NULL CHECK (after_exists IN (0, 1)),
  after_hash      TEXT NOT NULL CHECK (length(after_hash) = 64),
  payload_bytes   INTEGER NOT NULL CHECK (payload_bytes >= 0),
  revision        INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  reverted_at     TEXT,
  UNIQUE (session_id, call_id, path),
  CHECK (
    (before_exists = 0 AND before_content IS NULL)
    OR (before_exists = 1 AND before_content IS NOT NULL)
  )
);

CREATE INDEX file_changes_session_idx
  ON file_changes(session_id, created_at DESC);
```

`file_changes` 只服务两个产品能力：

1. Diff 面板在应用重启后仍能按 Session 查看 Agent 的文件修改历史。
2. 用户可以不依赖 Git，安全回退某一项 `create_file/apply_patch/delete_file` 变更。

它不是 provider message、Run journal、trace 或通用 filesystem audit log，不进入 `messages`、`inHistory` 或下一次模型请求。`turn_id/call_id` 仅用于与 runtime/tool card 关联，不表示 Run 已持久化。

`operation = 'write'` 同时覆盖 `create_file` 和其他整体写入；`before_exists` 能区分“创建新文件”与“替换已有文件”，不需要再增加一个与恢复语义重复的 `create` 枚举。

记录流程：

1. 副作用前已有 resource precondition 中的 before content 和 diff，先计算 `payloadBytes = utf8(beforeContent) + utf8(diff)`。单条记录已超过总容量上限时，在修改文件前返回 `CHANGE_HISTORY_LIMIT_EXCEEDED`。
2. 文件工具完成原子写入/删除，并重新读取或校验实际 after existence/hash。
3. 在工具结果成为 terminal result 前，同一 FileChange transaction 先删除最旧记录以满足容量/数量上限，再插入完整 `StoredFileChangeRecord`。
4. Commit 后，工具结果才可以声明该变更支持 revert；随后按 §7.2 与其余 tool batch messages 一起写入对话历史。

如果 filesystem mutation 已成功但 FileChange transaction 失败，terminal result 必须同时如实返回 `mutationSucceeded = true`、`warningCode = 'CHANGE_HISTORY_PERSIST_FAILED'` 和 `revertAvailable = false`，不能宣称整个文件操作未发生，也不能自动重试副作用。Filesystem 与 SQLite 仍不是同一原子事务；崩溃可能留下文件变化但没有 FileChange/Message，这与 §7.2 的 crash tradeoff 一致。

FileChange 与 Message 故意不在同一个 transaction 落盘：前者紧跟每次已完成的文件副作用，后者要等当前 assistant tool-call batch 的所有 terminal results 齐全后才能原子提交。Message history 是 append-only 且参与 provider context；FileChange 会更新 `revertedAt`、按独立容量规则清理，并携带大容量恢复 snapshot。将两者混在 Message 中会破坏这些边界。

回退流程：

1. 获取 workspace writer lease，并确认 Session/Project ownership。
2. 当前文件 existence/hash 必须严格等于记录的 `afterExists/afterHash`；否则返回 `RESOURCE_CHANGED`，不能覆盖用户或后续工具的新修改。
3. `beforeExists = true` 时用 `beforeContent` 原子恢复；否则删除 Agent 创建的文件。
4. 成功后更新 `reverted_at`、`updated_at` 和 `revision`。

V1 延续现有配置值：全应用最多 200 条记录，`payloadBytes` 总量最多 50,000,000 bytes。目标实现必须修正 legacy JSON store 在“单条记录已超上限”时仍保留该记录的边界缺陷。Retention 删除最旧记录时只失去该项 Diff/revert 能力，不修改 Messages 或 workspace。恢复 snapshot 永远不经 IPC；renderer 只接收 `FileChangeSummary`。

### 6.8 Message seq 与 transaction

Application service 通过 `DatabaseService.withTransaction()`：

1. 读取并递增 `sessions.last_seq`。
2. 插入一条或一组完整 messages。
3. 递增 `sessions.revision` 和 `updated_at`。
4. Commit。
5. 发布已提交 records。

`SessionRepository` 和 `MessageRepository` 接受同一个 transaction handle，不能在各自方法里提前 commit。多条 tool messages 必须在同一 transaction 获得连续 seq。

---

## 7. Provider History 重建

### 7.1 基本查询

下一次请求的 canonical history 来自：

```sql
SELECT schema_version,
       id,
       session_id,
       seq,
       turn_id,
       client_request_id,
       kind,
       role,
       content,
       normalized_reasoning_text,
       tool_calls_json,
       tool_call_id,
       provider_continuation_json,
       model_route_json,
       metadata_json,
       in_history,
       created_at
FROM messages
WHERE session_id = ?
  AND in_history = 1
ORDER BY seq ASC;
```

`MessageRepository` 通过 codec 将每一行无损解码为完整 `MessageRecord`。`MessageHistoryCompiler` 检查顺序、role 字段和 assistant tool-call/tool-result 配对，投影为包含 provider-neutral messages 与 opaque continuation references 的 `CompiledProviderHistory`；Provider Adapter 再转换成具体 wire request。Repository 不返回 Provider DTO。

Session history 不再依赖 main-process `ProviderMessage[]`。Backend 可以缓存查询结果，但缓存只按 Session revision 失效，不能成为真相源。

### 7.2 完整写入规则

#### User message

用户发送时，backend 先预留并发 slot/writer lease，再在 transaction 中插入完整 `kind = 'user_input'` message。Commit 后才开始 provider call。

#### Assistant final message

Text/reasoning delta 只进入 `ActiveRunExecution` memory buffer，并通过 `run:stream` 推送。Provider 发出 completed turn 后，backend 才插入完整 `kind = 'assistant_turn'` message：公开、非加密的可读投影进入 `normalizedReasoningText`；协议连续性所需的原始结构进入 `providerContinuation`。两者都不按 delta 增量写数据库。

#### Tool call batch

不能在 provider 刚提出 tool call 时写一条缺少 tool result 的持久历史。流程固定为：

1. Provider completed assistant turn，backend 在内存保存完整 assistant tool-call message。
2. 执行权限、审批和全部 tool calls，得到每个 call 的 terminal result。
3. 单一 transaction 依次插入 `kind = 'assistant_turn'` message 和所有对应的 `kind = 'tool_result'` messages。
4. Commit 后才发起下一次 provider call。

拒绝、取消、超时也形成完整 tool message。这样数据库任何时刻都不存在“assistant tool call 已持久化，但 required tool result 缺失”的协议断裂状态。

Tool/approval 的实时卡片来自 runtime event；完成后 renderer 从 assistant/tool messages 的 `toolCalls`、`toolCallId` 和 `metadata` 重建稳定展示。

这个简化模型不承诺“宿主文件副作用”和 Message transaction 在进程崩溃下原子一致：如果工具已经修改文件、但应用在完整 tool batch commit 前崩溃，workspace 变化可能存在而对应 tool messages 不存在。`file_changes` 和下一次 runtime context 可以重新发现当前 workspace 状态，但不能伪造丢失的执行历史。若未来要求 crash-atomic tool journal，必须重新引入 durable tool/run journal；它不是 v2.1 目标。

### 7.3 Compact 与 `inHistory`

`inHistory` 表示 canonical active provider history，不表示消息是否在 UI 可见。

显式或自动 compact 在一个 transaction 中：

1. 选择完整 provider turn/tool batch 边界。
2. 生成完整 compact summary message。
3. 把被替代的非 pinned messages 设置为 `in_history = 0`。
4. 插入 `kind = 'compact_summary'`、`in_history = 1` 的 summary message。
5. 递增 Session revision。

原消息仍在数据库，UI 和导出可以读取；只是后续 provider request 不再携带。

V1 为保持 `ORDER BY seq` 可以直接重建历史，compact 必须替代当前全部非 pinned active prefix，并在下一条新用户消息之前完成。若未来需要“摘要旧前缀但保留部分近期 suffix”，再增加独立 `history_order`；V1 不提前引入。

Compact summary 的 `metadata` 至少记录：

- `replacesThroughSeq`。
- source hash。
- compact prompt id/version/hash。
- compact model route。
- 当时 Goal/Plan snapshot。

不再需要独立 `context_checkpoints` table。

### 7.4 Provider continuation

`ProviderContinuationEnvelope` 统一的是可路由、可版本化的外壳，不统一不同供应商的 CoT 数据结构：

```ts
interface ProviderContinuationEnvelope {
  schemaVersion: 1
  adapterId: string
  format: string
  data: JsonValue
}
```

它表示“这个已完成 assistant turn 若由兼容 Provider 继续，Adapter 需要原样恢复的 provider-native 状态”。它不是 Session 全局 cursor，也不是标准化 reasoning。常见 payload：

```json
{
  "schemaVersion": 1,
  "adapterId": "deepseek.chat",
  "format": "assistant-turn.v1",
  "data": {
    "reasoning_content": "exact provider text"
  }
}
```

```json
{
  "schemaVersion": 1,
  "adapterId": "anthropic.messages",
  "format": "thinking-blocks.v1",
  "data": {
    "contentBlocks": [
      {
        "type": "thinking",
        "thinking": "...",
        "signature": "..."
      },
      {
        "type": "redacted_thinking",
        "data": "..."
      }
    ]
  }
}
```

```json
{
  "schemaVersion": 1,
  "adapterId": "openai.responses",
  "format": "response-state.v1",
  "data": {
    "responseId": "resp_xxx",
    "outputItems": [
      {
        "type": "reasoning",
        "id": "rs_xxx",
        "encrypted_content": "..."
      }
    ]
  }
}
```

`MessageHistoryCompiler` 不解析 `data`。Provider Adapter 使用 Message 的 `modelRoute` 加 envelope 的 `adapterId/format` 判断兼容性：

- 兼容：按该 Adapter 的协议使用原始 continuation。
- 不兼容、用户切换 Provider 或 format 未知：忽略 continuation，使用 canonical active messages 重放。
- continuation 损坏：不得从 `normalizedReasoningText` 伪造签名、密文、item id 或原始 block 顺序；只能明确降级重放或返回错误。

Renderer 可以持有同一个 canonical record，但必须把 `providerContinuation` 当作 opaque data，不解释、不展示、不修改。完整原始 Provider response 只进入显式开启的 trace；Message 中只保留协议继续所需的最小状态。

---

## 8. Command、Query 与状态推送

### 8.1 Typed API

目标 IPC 至少包括：

```text
app:get-bootstrap
project:list / project:add / project:update / project:remove
session:list / session:get / session:create / session:update / session:archive
message:list
file-change:list / file-change:revert
run:start / run:interrupt / run:interject
approval:decide
```

主进程推送分为 durable record changes 与 runtime stream，至少包括：

- `project:changed`：已经 commit 的完整 ProjectRecord list snapshot。
- `session:changed`：已经 commit 的 Session/Message records 和 revision。
- `file-change:changed`：受影响 `sessionId` 和 commit 后的完整 FileChangeSummary list snapshot，已包含 retention 结果。
- `run:stream`：active run status、text/reasoning delta、tool/approval、terminal 等瞬时事件。

### 8.2 无 durable change log

Durable-state changed events 由 commit 后的 backend event publisher 发送，不写 `session_change_log` 或通用 durable outbox。

Renderer 发现 Session revision gap 时：

1. 停止应用后续增量。
2. 调用 `session:get`。
3. 用最新 Session 和所需 message page 替换副本。

Project 和 FileChange 变更直接推送有界完整 list snapshot；renderer 用新 list 替换副本。Renderer reload 或 main-process restart 后再通过 bootstrap/`file-change:list` 获得当前值。

Desktop 单窗口场景中，主进程崩溃会同时终止 renderer；重启后本来就会 bootstrap，因此不需要 durable outbox/change log。

### 8.3 无通用 processed command table

幂等使用业务键：

- User send：`UNIQUE(session_id, client_request_id)`。
- Message：稳定 message id 和 seq unique constraint。
- Approval：active runtime 中一个 approval id 只接受一次 terminal decision。
- Session metadata update：backend 串行 command 和 revisioned response。

不持久化任意 `result_json`，也不维护需要清理的通用 command inbox。

---

## 9. 核心流程

### 9.1 创建 Session

1. Renderer 发送 `session:create(projectId, model?, mode?)`。
2. Backend 从 backend-owned defaults 补齐。
3. Transaction 插入 Session。
4. Commit 后返回并推送 SessionRecord。
5. Renderer 导航到新 Session。

创建 Session 不访问 Provider。空 Session 是真实 backend record。

### 9.2 Draft

Draft 和 draft attachments 只属于当前 renderer 输入组件：

- 不发送 IPC。
- 不进入 SQLite。
- 不保证切换 Session、renderer reload 或应用重启后保留。
- 点击发送时，renderer 把完整 text 和 attachment refs 一次性交给 backend。

Backend 校验附件、构造完整 user/harness messages 并落盘。Draft 丢失不会造成 backend state 与 provider history 不一致。

### 9.3 模型和权限模式

模型下拉框发送 `session:update`，更新 Session `modelSelection`。它不修改全局 provider default，也不改变已经开始的 Active Run。

Active Run 开始时解析 immutable `ModelRouteSnapshot` 并保存在 memory；每个完成的 assistant message 记录实际 route。

权限模式同样由 backend 更新。Active Run 使用启动时的 mode snapshot。

### 9.4 发送与执行

1. Backend 校验 Session、Provider、并发和 writer 条件。
2. 预留 run slot/writer lease。
3. Transaction 插入完整 user/context messages。
4. Commit 后推送 messages。
5. 创建 `ActiveRunExecution` 并开始 provider/tool loop。
6. Stream delta 只存 memory 并推送 renderer。
7. 每个完整 assistant turn 或完整 tool batch 按 §7.2 写入 SQLite。
8. 完成、取消或失败后释放 runtime resources。

### 9.5 应用崩溃与重启

重启后：

- Session metadata 和完整 messages 从 SQLite 恢复。
- `inHistory = 1` 的 rows 重建 provider messages。
- 所有上次的 active Run、pending approval、partial text/reasoning 和未完成 tool batch 丢失。
- 最后一条已提交 user message 可能没有 assistant reply；UI 可以展示为未回答并允许用户重试。
- 崩溃前已经发生但尚未形成完整 tool batch message 的 workspace side effect 可能保留；系统以下一次实际文件状态为准。
- 不生成持久化 `interrupted` Run，也不伪造 partial assistant message。

如果只是 renderer reload 而 main process 仍存活，`session:get` 可以附带 backend memory 中的 `ActiveRunPublicSnapshot`，继续展示当前 Run。

---

## 10. LiveSessionContext 与 ActiveRunExecution

### 10.1 LiveSessionContext

```ts
interface LiveSessionContext {
  sessionId: SessionId
  activeRun?: ActiveRunExecution
  terminalFacade: SessionTerminalFacade
  cachedHistoryRevision?: number
  mcpDisclosures: Map<string, McpDisclosure>
}
```

它是按需创建的 backend execution context：

- 指向当前 active Run。
- 管理 Session-owned terminal facade。
- 保存可以丢弃和重建的 history cache。
- 保存当前 MCP connection 的披露状态。

它不是 SessionRecord，也不是所有持久 Session 都必须常驻内存。

### 10.2 ActiveRunExecution

```ts
interface ActiveRunExecution {
  runId: string
  turnId: string
  modelRoute: ModelRouteSnapshot
  permissionMode: PermissionMode
  controller: AbortController
  textBuffer: string
  reasoningBuffer: string
  pendingAssistantTurn?: ProviderMessage
  pendingToolResults: Map<string, ToolResult>
  pendingApproval?: PendingApprovalWaiter
  pendingSideEffects: Set<Promise<void>>
  writerLease?: WorkspaceWriterLease
  done: Promise<void>
}
```

它负责 provider loop、stream、工具、审批、中断、writer 和资源释放。执行结束后销毁。

### 10.3 为什么不通过 IPC

Runtime object 含有 `AbortController`、Promise、callback、Map、stream、PTY、socket 和 lease，无法也没有意义序列化给 renderer。

Renderer 通过 IPC 操作能力：

```text
run:interrupt   -> ActiveRunExecution.controller.abort()
approval:decide -> PendingApprovalWaiter.resolve()
run:interject   -> ActiveRunExecution interjection queue
```

Renderer 收到的是 serializable snapshot/event，不是 runtime object reference。窗口 reload 或切换 Session 不能成为后台执行生命周期的所有者。

---

## 11. Goal、Plan、Interjection 与并发

### 11.1 Goal 和 Plan

Goal/Plan 会跨越多个 provider turn，并影响下一次 prompt 和 continuation，因此属于 Session durable metadata，保存在 `sessions.goal_json/plan_json`。

模型工具和 renderer command 调用同一个 Session application service。更新成功后 backend commit Session，再向 renderer 推送 SessionRecord。

需要进入模型上下文时，backend 生成完整 harness/orchestrator Message。Goal/Plan 的当前状态不依赖 runtime memory。

### 11.2 Interjection

Queued interjection 属于 ActiveRun memory。只有真正注入 provider history 时，才作为完整 `kind = 'interjection'` message 插入 SQLite。

应用崩溃前仍未注入的 interjection 可以丢失。

### 11.3 并发与 writer

- 每个 Session 同时最多一个 Active Run。
- 全应用受 `maxConcurrentRuns` 限制。
- 同一 canonical workspace 同时最多一个非 readonly writer。
- ReadOnly Run 不获取 writer lease。
- Writer lease 覆盖 provider、工具、审批等待、interjection continuation 和 cancelling。
- 不可中止副作用仍在执行时，writer 延迟到其 Promise settle 后释放。

Run slot 和 writer lease 都是 backend memory，不落盘。应用重启后全部失效。

---

## 12. Renderer 架构

目标 store：

```text
app-shell-store          bridge/bootstrap/window UI
project-replica-store    backend ProjectRecord copies
session-replica-store    SessionRecord + paged MessageRecord copies
run-stream-store         ephemeral ActiveRunPublicSnapshot / stream events
settings-replica-store   public backend settings copies
composer-ui-store        draft / draft attachments / IME
ui-store                 navigation/layout/scroll/panel state
```

Renderer 可以：

- 按 `seq` 渲染 MessageRecord。
- 根据 `kind` 隐藏 harness、折叠 internal message、组合 assistant tool calls 和 tool results；不能把所有 `role = 'user'` 都渲染成用户气泡。
- 根据 `inHistory` 展示 compact 边界。
- 缓存 message pages。
- 在输入组件中临时保存 draft。

Renderer 不可以：

- 自行创建已经完成的 assistant/tool message。
- 聚合 delta 后认定 message 已 commit。
- 将 model/mode 只写入 Pinia。
- 保存完整 Session/workbench 文件。
- 把 draft 当作必须恢复的 backend state。

---

## 13. 配置、Secrets 与其他存储

| 数据                                                 | 存储                                     | 所有者                  |
| ---------------------------------------------------- | ---------------------------------------- | ----------------------- |
| Projects、Sessions、Messages、Goal/Plan、FileChanges | `userData/agent.db`                      | backend                 |
| 非敏感应用/provider 配置                             | backend config repository                | backend                 |
| API keys                                             | Electron safeStorage-backed secret store | backend                 |
| Trace                                                | `userData/traces/*.jsonl`                | backend                 |
| Skills                                               | `userData/skills/`                       | backend manager         |
| ProjectModel                                         | workspace `.zch/project-model.json`      | backend project service |
| Prompt resources                                     | versioned application resources          | backend registry        |

Renderer 只能读取 public config snapshot。API key、Authorization 和 safeStorage 密文不进入 renderer、Session/Message records 或 trace。

---

## 14. IPC、安全与宿主边界

Preload 只暴露冻结 typed API，不暴露 `ipcRenderer`。Command/query/result/event 按 `shared/` schema 校验。

本项目不防御已经完全控制本机的恶意软件，因此不引入数据库加密、多用户 ACL、本地记录签名或同一 OS 用户隔离。

继续保留：

- renderer sandbox 和 contextIsolation。
- sender/frame/origin 与 payload/result schema 校验。
- secrets 不进入 renderer。
- workspace path 和 resource ownership 校验。
- 子进程环境 allowlist。
- tool approval、abort 和 bounded output。

这些同时是业务正确性和模型误操作的边界。

---

## 15. Trace 与产品状态

SQLite 是产品持久状态的真相源；JSONL trace 是可选审计记录，不用于 Project/Session/FileChange 恢复。

Trace 可以记录比 messages 更细的内容：

- Run lifecycle 和失败/取消原因。
- stream delta 和 partial output。
- prompt build 和 request-specific selection。
- provider request/response/timing/usage。
- pending approval、tool attempt、writer、terminal 和 runtime diagnostics。

Logging 关闭时这些细节可以不存在，但 Projects、完整 Messages、Session metadata 和未被 retention 清理的 FileChanges 仍必须落盘。

Restricted transcript 可以组合 SQLite messages 与 trace；缺少 trace 时明确省略 runtime 细节。

---

## 16. Project、Terminal、Skills、MCP 与插件

这些服务继续由 backend 拥有：

- Project explorer 和 code intelligence 通过 query 返回 public records。
- PTY process、scrollback 和 ownership 属于 LiveSessionContext；应用重启不恢复真实 PTY。
- Skills manager 扫描、安装和启用 skill。
- MCP manager 拥有连接、目录 revision、tool normalization 和调用。
- Plugin event bus 是 backend hook/event mechanism。

它们需要加入模型历史时，只能创建完整 Message；不能把半完成内部状态写进 messages。

---

## 17. Headless 与 Runtime Parity

Headless/Benchmark 继续复用唯一 Agent runtime：

- 每个 trial 使用独立临时 SQLite database。
- Desktop 和 Headless fake-provider trajectory 比较 active messages、provider requests、tool results、prompt hashes 和 patch。
- Benchmark artifacts 从 canonical messages 导出 conversation，不依赖 renderer store。
- Run/stream 细节来自 trace，而不是 `runs` table。

Docker worker、isolated grader、credential proxy、case identity、pass@k workspace 和 cleanup hard gate 不因状态模型简化而改变。

---

## 18. 迁移方案

### 18.1 Workbench 导入

首次打开 v2 database：

1. 创建 `agent.db` 并执行 migrations。
2. 如果存在 `workbench.json` 或 `change-history.json`，先对原文件做只读备份。
3. 一个 transaction 内先导入 Projects，为 canonical workspace 生成稳定 `projectId`，再导入 Session metadata 和能可靠转换的完整 Messages。
4. 旧 tool activity 只有在能够构成完整 assistant tool-call + tool result 协议时才转换为 provider history；否则只导入可见文本或 metadata，不伪造模型历史。
5. 旧的可见明文 reasoning 只能导入 `normalizedReasoningText`；Importer 不得把它包装成虚假的 `providerContinuation`。
6. `change-history.json` 中的记录只有在 Session/workspace 能唯一对应、路径受 workspace 约束且 snapshot/hash 合法时才导入 `file_changes`；无法验证的记录留在备份中，不提供可能覆盖错误文件的 revert。
7. 不承诺迁移未发送 draft。
8. 导入 ID 使用可重现映射。崩溃重试遇到相同 primary/unique key 时，必须 decode 并比较已有记录；内容相同则跳过，内容不同则停止导入，不得覆盖。全部 commit 成功后，将原 JSON 更名为已导入备份并启用新 repository；不为此新增通用 `processed_commands` 或 product metadata table。

旧 Workbench 没有完整 harness/provider history，因此导入 Session 标记：

```text
historyFidelity = legacy_display_only
```

### 18.2 切换顺序

1. 引入 shared Session/Message schemas 和 SQLite repositories。
2. 引入 Project 和 FileChange repositories，将 `workbench.json` project registry 与 `change-history.json` 纳入 SQLite。
3. 引入 Message history compiler 和完整 tool batch transaction。
4. Runtime 改为从 messages 查询 active history。
5. Renderer 改为 Project/Session/Message/FileChangeSummary replica。
6. 启用一次性 importer。
7. 删除 `workbench:save`、frontend conversation persistence、legacy change-history JSON 和 memory-only canonical history。

迁移不长期双写。

---

## 19. 测试与不变量

必须覆盖：

- Project/Session/Message codec round-trip，canonical project path 去重，以及 Project path 重新关联不改写 Session `projectId`。
- `kind` 与 provider `role` 独立 round-trip，同为 `role = 'user'` 的 user/orchestrator/runtime context 重启后仍可区分。
- MessageHistoryCompiler 只投影 provider 字段；相同 active MessageRecords、route 和 adapter config 生成确定性的 Provider DTO。
- `normalizedReasoningText` 只包含允许展示的非加密文本；缺失投影时 UI 不显示 reasoning，且不能从它重建 continuation。
- `ProviderContinuationEnvelope` 外层 schema 校验、`data` 原样 round-trip、数组顺序不变；签名、密文和 opaque item 不被 Core 改写。
- Adapter、route 或 format 不兼容时忽略 continuation 并重放 canonical messages；损坏状态不得由 normalized reasoning 伪造。
- 删除或改变 metadata 不改变相同 route/adapter 下编译出的 Provider request；协议关键字段藏入 metadata 的 fixture 必须被拒绝。
- SQLite migration 顺序、checksum 不可变、单步 rollback、高版本拒绝、foreign key cascade 和 seq uniqueness。
- 移除 Project 会 cascade 删除其 Sessions/Messages/FileChanges，但不删除 workspace 目录或任何项目文件。
- Application service 的 Session/Message 多表事务回滚时，Repository 不得留下独立 commit。
- User send 重试不重复插入 message。
- Assistant text、`normalizedReasoningText` 和 `providerContinuation` 只有 completed 后才落盘。
- 每个持久化 assistant tool-call message 后都有完整 tool result messages。
- Tool batch transaction 失败时不留下协议半截。
- Compact 只在完整 turn boundary 修改 `inHistory`，active history 可直接按 seq 重建。
- Renderer revision gap 触发 Session snapshot。
- Draft、partial output 和 active Run 不进入 SQLite。
- Renderer reload 且 main 存活时可读取 ActiveRunPublicSnapshot。
- App crash/restart 后 partial output 丢失，但完整 messages 可以继续请求模型。
- FileChange create/patch/delete 都能在重启后列出和回退；当前文件不匹配 after existence/hash 时必须返回 `RESOURCE_CHANGED`。
- FileChange 持久化失败时不宣称 `revertAvailable`；单条 payload 超限在文件副作用前拒绝；retention 只删除最旧变更记录，不改写 Messages 或 workspace。
- `FileChangeSummary` IPC 不包含 `beforeContent`，renderer store、DOM、trace 默认记录中不得出现恢复 snapshot。
- Legacy importer 中断后重试不生成重复 Project/Session/Message/FileChange，损坏或无法归属的变更记录不可导入为可回退项。

核心重启回归：

1. 用户发送 A。
2. Provider 产生 assistant tool call、tool results 和最终 assistant message。
3. 完整退出主进程。
4. 使用相同 `userData` 重启。
5. 发送 B。
6. 断言 `messages WHERE in_history = 1 ORDER BY seq` 能构造协议完整的 A/tool/final/B provider request。

现有 test、typecheck、lint、format、native、E2E、real-provider 和 benchmark gates 继续保留。SQLite driver 引入后必须覆盖 Electron native ABI 和打包 smoke。

---

## 20. 当前迁移状态

当前 legacy 实现仍然：

- Renderer Pinia 保存 Conversation/timeline 并整体写 `workbench.json`。
- Project registry 仍位于 `workbench.json`，文件变更/回退记录仍单独写入 `change-history.json`。
- Main-process provider history 主要位于内存。
- Restart 后 UI history 与 provider history 可能不一致。
- Composer model selection 与实际 route 不是同一 canonical mutation。

这些不是 v2.1 的长期折中。新功能不得继续扩大 legacy 数据流。
