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
- 应用重启后可以从 SQLite 重建完整 canonical history，再由所选 Protocol Adapter 生成协议有效的 Provider request。
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
4. Commit 成功后生成一次 `DurableCommitEnvelope`；command 回包和 durable push event 携带同一个 envelope，到达顺序不作保证。
5. Renderer 让回包和事件经过同一个 reconciler，按 event cursor 和 record revision 幂等更新本地副本。

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
  durable.ts              # schema version、revision/seq 与容量上限
  durable-api.ts          # target commands / queries / results / events
  project.ts              # ProjectRecord
  session.ts              # SessionRecord / SessionSnapshot
  message.ts              # canonical MessageRecord
  model-route.ts          # ModelSelection / ModelRouteSnapshot
  file-change.ts          # FileChangeSummary IPC schema
  runtime-events.ts       # ephemeral Run/stream events
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
    protocol-adapters/
      openai-chat-completions-adapter.ts
      openai-responses-adapter.ts
      anthropic-messages-adapter.ts
    transports/
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

Message 是 SQLite 中唯一的对话历史单位。它既能投影为 UI timeline，也能重建 provider-independent canonical history。

Message 必须完整后才写入数据库：

- 用户点击发送时，user message 已完整。
- Provider 一个 assistant turn 完成后，assistant message 才完整。
- 一个 tool call 得到 terminal result 后，tool message 才完整。
- Harness/context layer 构造完毕后才写入。

数据库中不存在 partial message。

### 4.4 Run

Run 是一次活动执行，不是持久化领域实体。Backend 为它分配临时 `runId`，用于：

- IPC stream routing。
- 中断、interjection 和 approval。
- 关联当前 provider/tool loop。
- trace correlation。

Run 完成或应用退出后，`ActiveRunExecution` 销毁。完成的结果已经体现在 messages；失败、取消和详细执行轨迹由可选 trace 记录。

`runId` 只出现在 runtime IPC events 和可选 trace，不写入 Messages 或 FileChanges。完成后的持久化关系已由 Message `seq`、tool `callId` 和 user `clientRequestId` 表达；不保留没有持久化消费者的 `turnId`。

---

## 5. Canonical 数据结构

V1 record `schemaVersion` 固定为 1。Project、Session 和 FileChange `revision` 从 1 开始；空 Session 的 `lastSeq = 0`，首条 Message 的 `seq = 1`。所有计数使用不超过 JavaScript safe integer 的非负或正整数。Message page 最大 200 条并按 `seq` 升序返回；Session summary page 最大 200 条，按 `(updatedAt, id)` 降序并使用同一复合 cursor；Project list 最大 512 条，FileChange list 最大 200 条，单次 Session commit 最多携带 512 条 Message records。

TypeBox schema 负责单 record 的闭集字段、枚举、长度和 `kind + parts` 组合；`assertBoundedJsonValue`、route/page semantic validators 负责 JSON 深度/总字节、secret-safe endpoint、本地 call ID 唯一性和升序 page 等不能可靠表达为可组合 JSON Schema 的约束。跨 records 的 tool call/result 配对不属于 P1 schema，由 `MessageHistoryCompiler` 在 P3 校验。

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
  revision: number
  lastSeq: number
  createdAt: string
  updatedAt: string
  archivedAt?: string
}
```

`modelSelection` 是下一次执行使用的当前选择。Backend 在 Run 开始时将它解析为不可变 `ModelRouteSnapshot`；除 provider/model/reasoning 和端点/配置 revision 外，snapshot 必须包含实际 `adapterId`，以区分同一供应商的 Chat Completions、Responses 等协议。已完成 assistant message 记录该实际 route。

```ts
type ProviderPurpose = 'main' | 'approval' | 'title' | 'compression'

interface ModelRouteSnapshot {
  schemaVersion: 1
  purpose: ProviderPurpose
  adapterId: string
  providerId: string
  model: string
  reasoning: ReasoningEffort
  endpoint: string
  providerConfigRevision: number
}
```

Snapshot 保存解析完成后的非凭据 route，而不是指向可变全局 Provider 配置的引用。`purpose` 表示 `main/approval/title/compression` 等模型用途，不是 wire role；API key、Authorization header 和 transport client 不进入 shared record。一次 Run 启动后，即使用户修改 Provider 配置，该 Run 仍使用已冻结的 adapter、endpoint、model 和 reasoning；新配置只影响后续 Run。

`endpoint` 必须是 HTTP(S) 绝对 URL，并拒绝 URL userinfo、fragment 和凭据型 query key。它是可进入 SQLite、renderer 和 trace 的非 secret route 信息，不能用来携带 API key、token、signature 或 Authorization 数据。

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

interface TextPart {
  type: 'text'
  text: string
}

interface JsonPart {
  type: 'json'
  value: JsonValue
}

interface ToolCallPart {
  type: 'tool_call'
  callId: string
  name: string
  arguments: JsonValue
}

interface ToolResultPart {
  type: 'tool_result'
  callId: string
  content: Array<TextPart | JsonPart>
  isError: boolean
}

type MessagePart = TextPart | ToolCallPart | ToolResultPart

interface MessageRecord {
  schemaVersion: 1
  id: MessageId
  sessionId: SessionId
  seq: number
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

  parts: MessagePart[]
  normalizedReasoningText?: string
  providerContinuation?: ProviderContinuationEnvelope
  modelRoute?: ModelRouteSnapshot
  metadata?: MessageMetadataV1

  inHistory: boolean
  createdAt: string
}
```

字段职责：

- `kind`：应用内部语义，renderer、搜索、导出、compact policy 和 Provider Protocol Adapter 用它区分用户输入、编排注入和其他消息。`kind` 不是任何 Provider 的 wire `role`。
- `parts`：应用理解的、有序的 canonical payload atoms。V1 支持文本、工具调用和工具结果；图片、文件等多模态类型只在产品真正支持时以新的闭集 union member 增加，不接受开放任意 JSON part。
- `normalizedReasoningText`：可选、非加密、应用标准化后的可读 reasoning 文本或摘要，只用于 UI、导出和通用审计；它不是原始 CoT，也不能用于反向重建 Provider continuation。
- `providerContinuation`：可选的 provider-native continuation envelope。Core 只验证外壳并原样搬运 `data`；只有 `adapterId + format` 对应的 Provider Adapter 可以解释它。
- `modelRoute`：已完成 assistant turn 实际使用的 route，便于 UI 和审计。
- `metadata`：应用拥有并理解的 typed annotations，例如 attachment provenance、prompt id/hash、标准化 usage、approval/tool/compact 摘要和 reasoning projection 状态。
- `inHistory`：是否属于下一次 provider request 的 canonical active history。

`metadata`“与 Provider 协议无关”指的是：它可以来源于 Provider，例如标准化 usage，但删除 metadata 只能损失 UI、统计或审计信息，不能让下一次 Provider request 失去协议完整性。任何必须原样回传、只由 Adapter 理解、或影响 continuation 正确性的字段都必须进入 `providerContinuation`，不能藏在 metadata 中。完整原始 Provider request/response、headers 和 stream events 属于可选 trace，也不进入 metadata。

实际 shared schema 必须是以 `kind` 为 discriminator 的闭集 union，而不是上面这个允许所有组合的宽松 interface：

- `user_input`：`clientRequestId` 必填，V1 只允许非空 text parts。
- `assistant_turn`：只允许 text/tool-call parts，至少一项；`modelRoute` 必填，可携带 reasoning projection 和 continuation。
- `tool_result`：每条 record 正好包含一个 terminal tool-result part；`callId` 必须对应之前 active assistant turn 中的 tool-call part。
- `harness/runtime_context/agents_context/orchestrator/interjection/compact_summary`：V1 只允许非空 text parts。
- `normalizedReasoningText/providerContinuation` 不能出现在非 assistant record。
- `MessageMetadataV1` 也必须按 `kind` 收紧，不接受任意键。

MessageRecord 是持久化、排序、分页、compact 和 UI 派生的单位；MessagePart 是同一个逻辑消息内部的有序 payload atom。这是两层逻辑类型，不代表需要 `message_parts` 表；V1 将整个 parts array 作为受 shared schema 校验的 JSON 落在 `messages.parts_json`。

这两层不是从某一家 Provider DTO 原样复制出来的，而是从应用自己的两个不同问题推导出来：

| 层级            | 负责的事情                                                                 | 为什么不能合并                                                                                            |
| --------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `MessageRecord` | identity、Session 归属、全局 `seq`、幂等发送、持久化原子性、分页与 compact | 如果每个内容块都成为独立 record，Session 排序、一次 assistant turn 的原子提交和 UI 分页都会被协议细节打碎 |
| `MessagePart`   | 单个逻辑消息内的内容类型、局部顺序和 call/result 关联                      | 如果 record 只有一个字符串字段，就无法无损表达“文本 + 多个工具调用”或后续图片/文件等异构内容              |

它借鉴的是多个现代 API 都存在“外层事件/消息 + 内层有序内容单元”这一共同形态，但只保留本应用确实理解的最小语义交集。Chat Completions、Responses 和 Anthropic 的具体 message/item/block 仍由各自 Adapter 生成，所以 canonical parts 不会随着某一家 wire schema 的升级而被迫迁移。

### 5.3.1 History Compiler 与 Provider Protocol Adapter

持久化和请求边界固定为：

```text
SQLite row
  <-> Message codec
MessageRecord[]
  -> MessageHistoryCompiler
CompiledCanonicalHistory
  -> ProviderProtocolAdapter.compileRequest(...)
OpenAI Chat Completions / OpenAI Responses / Anthropic Messages DTO
```

`MessageHistoryCompiler` 只负责 provider-independent policy：按 `seq` 排序、选择 `inHistory`、应用 compact 边界、校验 `kind/parts` 和 tool-call/result 完整性，并删除不应外发的 application metadata。它不生成 `role`、Provider message 或任何 SDK DTO。

```ts
interface CompiledCanonicalHistory {
  entries: Array<{
    sourceMessageId: MessageId
    kind: MessageRecord['kind']
    parts: MessagePart[]
    sourceModelRoute?: ModelRouteSnapshot
    continuation?: ProviderContinuationEnvelope
  }>
}

interface ProviderProtocolAdapter<RequestDto> {
  readonly adapterId: string

  compileRequest(input: {
    history: CompiledCanonicalHistory
    route: ModelRouteSnapshot
    tools: ToolDefinition[]
  }): RequestDto

  decodeStream(input: {
    stream: AsyncIterable<unknown>
    emit: (event: NormalizedProviderEvent) => void
  }): Promise<CompletedAssistantTurn>
}

interface CompletedAssistantTurn {
  parts: Array<TextPart | ToolCallPart>
  normalizedReasoningText?: string
  providerContinuation?: ProviderContinuationEnvelope
  usage?: NormalizedUsage
}
```

Protocol Adapter 必须消费整个 ordered history，不是对每条 MessageRecord 做一对一 `map()`。编译可以提升 harness、合并相邻记录或将一条 record 展开为多个 wire items，但不能改写持久化 history。Application service 根据 `CompletedAssistantTurn` 生成 ID/Session/seq/metadata 并落盘；Adapter 不直接创建或插入 MessageRecord。

| Canonical history                          | Chat Completions              | OpenAI Responses                         | Anthropic Messages                          |
| ------------------------------------------ | ----------------------------- | ---------------------------------------- | ------------------------------------------- |
| harness text                               | `system` message              | `instructions` / input message item      | top-level `system`                          |
| user/context/compact text                  | `user` message                | input `message` item                     | `user` text block                           |
| assistant text                             | `assistant` message           | output `message` item                    | `assistant` text block                      |
| assistant `tool_call` part                 | `assistant.tool_calls[]`      | `function_call` item                     | assistant `tool_use` block                  |
| one or more adjacent `tool_result` records | one `tool` message per result | one `function_call_output` item per call | one `user` message with result blocks first |

`role` 只是部分 wire 协议的字段，不是 canonical database field。OpenAI 官方把 Chat Completions 的基本单位称为 Message，而 Responses 使用包括 `message/function_call/function_call_output` 的 Items；Anthropic 则把 client tool result 放在 `user` message 的 `tool_result` content block 中。因此一条 MessageRecord 不要求对应一条 wire message/item。协议依据：[OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)。

同一供应商的不同协议也是不同 Adapter，例如 `openai.chat-completions`、`openai.responses` 和 `anthropic.messages`。Provider transport 负责 SDK/HTTP、stream 和 abort；Protocol Adapter 负责 request compilation、response decoding 和 continuation compatibility。两者可以由同一 Provider module 组合，但不能让 Chat Completions 形状的通用 `ProviderMessage` 渗透回 Core、Persistence 或 Renderer。

### 5.4 FileChangeSummary 与 StoredFileChangeRecord

Renderer 只需要展示 Diff 历史并发起“回退” command，因此 `shared/` 中的公开结构不包含文件恢复内容：

```ts
interface FileChangeSummary {
  schemaVersion: 1
  id: FileChangeId
  sessionId: SessionId
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
  schemaVersion: 1
  session: SessionRecord
  messagePage: MessagePage
}

type MessagePage =
  | {
      schemaVersion: 1
      sessionId: SessionId
      records: MessageRecord[]
      hasMore: true
      nextBeforeSeq: number
    }
  | {
      schemaVersion: 1
      sessionId: SessionId
      records: MessageRecord[]
      hasMore: false
    }
}

interface SessionOpenResult {
  snapshot: SessionSnapshot
  runtime?: ActiveRunPublicSnapshot
}
```

`SessionSnapshot` 只包含数据库可无损恢复的 canonical data。`SessionOpenResult.runtime` 是独立的 backend-memory snapshot，仅用于 renderer reload 后恢复当前活动展示；它不是 Session data。

历史使用 exclusive `beforeSeq` 按 `seq` 降序查询，再在 response 中恢复为升序 records。`hasMore = true` 时 `nextBeforeSeq` 等于当前页第一条 record 的 seq。Renderer 持有的是 canonical records 的部分副本，不是另一套结构。

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

| 表                  | 用途                                                     |
| ------------------- | -------------------------------------------------------- |
| `schema_migrations` | 数据库 schema 迁移                                       |
| `projects`          | Project/workspace 元数据                                 |
| `sessions`          | Session 元数据和当前 Goal/Plan                           |
| `messages`          | 完整、排序、可编译 Provider request 的 canonical history |
| `file_changes`      | 文件变更与有界 revert 数据；不属于消息历史               |

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
  client_request_id    TEXT,
  kind                 TEXT NOT NULL CHECK (
    kind IN (
      'user_input',
      'assistant_turn',
      'tool_result',
      'harness',
      'runtime_context',
      'agents_context',
      'orchestrator',
      'interjection',
      'compact_summary'
    )
  ),
  parts_json           TEXT NOT NULL
    CHECK (
      json_valid(parts_json)
      AND json_type(parts_json) = 'array'
      AND json_array_length(parts_json) > 0
    ),
  normalized_reasoning_text    TEXT,
  provider_continuation_json   TEXT
    CHECK (
      provider_continuation_json IS NULL
      OR json_valid(provider_continuation_json)
    ),
  model_route_json     TEXT
    CHECK (
      model_route_json IS NULL
      OR json_valid(model_route_json)
    ),
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
```

`parts_json` 是 `MessagePart[]` 的唯一持久化表示；Repository codec 必须在读写边界按 `kind` 验证允许的 part 组合，SQL 中的 JSON CHECK 只是最低结构保护。V1 不建 `message_parts` 表，也不保存派生的 wire `role/content/tool_calls/tool_call_id`。

本地对话搜索只读取 `kind = 'user_input'/'assistant_turn'` records 中 `type = 'text'` 的 parts；不索引 tool-call 参数、tool-result/JSON payload、reasoning、continuation 或 metadata。V1 可在 Repository 中解码后查询；数据量需要 FTS 时，FTS 只能是可从这些 text parts 重建的派生索引，不能成为新的真相源。

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

它不是 provider message、Run journal、trace 或通用 filesystem audit log，不进入 `messages`、`inHistory` 或下一次模型请求。`call_id` 只用于与对应 tool call/result 关联，不表示 Run 已持久化。

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
       client_request_id,
       kind,
       parts_json,
       normalized_reasoning_text,
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

`MessageRepository` 通过 codec 将每一行无损解码为完整 `MessageRecord`。`MessageHistoryCompiler` 检查顺序、`kind/parts` 组合和 assistant tool-call/tool-result 配对，投影为 `CompiledCanonicalHistory`；当前 `ProviderProtocolAdapter` 再消费完整 history 并转换成具体 wire request。Repository 不返回 Provider DTO。

Session history 不再依赖 main-process `ProviderMessage[]` 或 Responses/Anthropic item arrays。Backend 可以缓存查询结果和已编译 request，但缓存只按 Session revision、route 和 adapter config 失效，不能成为真相源。

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

Tool/approval 的实时卡片来自 runtime event；完成后 renderer 从 assistant/tool messages 的 `tool_call/tool_result` parts 和 typed metadata 重建稳定展示。

这个简化模型不承诺“宿主文件副作用”和 Message transaction 在进程崩溃下原子一致：如果工具已经修改文件、但应用在完整 tool batch commit 前崩溃，workspace 变化可能存在而对应 tool messages 不存在。`file_changes` 和下一次 runtime context 可以重新发现当前 workspace 状态，但不能伪造丢失的执行历史。若未来要求 crash-atomic tool journal，必须重新引入 durable tool/run journal；它不是 v2.1 目标。

### 7.3 Compact 与 `inHistory`

`inHistory` 表示下一次请求使用的 canonical active history，不表示消息是否在 UI 可见。

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
  "adapterId": "deepseek.chat-completions",
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

`MessageHistoryCompiler` 不解析 `data`。Provider Protocol Adapter 使用 Message 的 `modelRoute.adapterId` 加 envelope 的 `adapterId/format` 判断兼容性：

- 兼容：按该 Adapter 的协议使用原始 continuation。
- 不兼容、用户切换 Provider/protocol 或 format 未知：忽略 continuation，使用 canonical active `kind + parts` history 重放。
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

### 8.2 Commit 回包与 Commit Event

Renderer 发起的 command 不能只等待 push event，也不能只依赖 invoke 回包。两条路径解决不同问题：

- invoke 回包让发起操作的组件明确知道 command 成功、冲突或失败，并立即结束 pending 状态。
- durable push event 覆盖 backend 自主发生的提交，例如 assistant turn 完成、tool batch 完成、compact、Goal/Plan tool 更新，以及后台 Session 的变更。

所有 durable mutation 在 transaction commit 后只构造一次提交结果：

```ts
interface BackendEventCursor {
  schemaVersion: 1
  backendInstanceId: string
  sequence: number
}

interface DurableCommitEnvelope<TChange> {
  schemaVersion: 1
  cursor: BackendEventCursor
  topic: 'project.changed' | 'session.changed' | 'file-change.changed'
  change: TChange
}

interface DurableCommandResult<TChange> {
  version: 1
  commit: DurableCommitEnvelope<TChange>
}
```

`backendInstanceId` 在 main process 每次启动时重新生成，`sequence` 是该实例内所有 durable commit 共用的严格单调序号。它们只是 IPC 传输顺序游标，不写 SQLite，也不是领域 revision、change log 或可恢复的事件历史。

对应 change payload 为：

```ts
interface ProjectCommittedChange {
  projects: ProjectRecord[]
}

interface SessionCommittedChange {
  session: SessionRecord
  messageChange:
    | { mode: 'none' }
    | { mode: 'upsert'; records: MessageRecord[] }
    | { mode: 'invalidate'; throughSeq: number }
}

interface FileChangeCommittedChange {
  sessionId: SessionId
  fileChanges: FileChangeSummary[]
}
```

Project 和 FileChange 集合有明确上限，因此提交完整 list snapshot。Session event 总是携带完整 `SessionRecord`；纯标题、模型或权限等 metadata 更新使用 `mode = 'none'`，常规消息提交使用非空 `upsert` records。Compact 等操作如果影响的旧 Message 太多、会超过 IPC 上限，则使用 `mode = 'invalidate'`，renderer 丢弃该 Session 的已缓存 message pages，并通过 `session:get/message:list` 重取；不能发送无界事件。

Application service 的固定顺序是：

1. 在串行 write queue 中校验 `expectedRevision` 等前置条件。
2. 执行 transaction 并 commit。
3. 为已提交结果分配 event cursor，构造 immutable envelope。
4. 将同一个 envelope 交给 event publisher 和 IPC handler。
5. Event 与 invoke response 谁先到 renderer 都是合法行为。

Commit、cursor 分配和 envelope 发布必须在同一个串行 application-state job 释放前完成；bootstrap snapshot 读取也进入这条队列，不能在“数据库已 commit、cursor 尚未分配”的中间状态取快照。Commit 失败时不分配 envelope、不发送 durable event。`run:start` 等同时产生 runtime 结果的 command 在 `DurableCommandResult` 之外返回 `ActiveRunPublicSnapshot/runId`；其中 durable 部分仍必须是相同的 commit envelope。

### 8.3 Renderer Reconciliation

Renderer 不为 durable state 做 optimistic write。点击创建、重命名、切换模型或发送消息后，只设置 UI-only `pending`；收到 command error 时清除 pending 并保留 backend record，收到 commit 回包或事件时才更新副本。

Command 回包和 push event 进入同一个 durable-event reconciler：

1. `backendInstanceId` 不同：当前副本属于旧 backend，重新 bootstrap。
2. `sequence <= lastAppliedSequence`：同一提交已由另一条路径处理，幂等忽略。
3. `sequence = lastAppliedSequence + 1`：按 topic 应用 change，并推进 cursor。
4. `sequence > lastAppliedSequence + 1`：存在提交缺口，不猜测缺失内容；重新 bootstrap，清空已加载 Session message/FileChange pages，再按当前页面需要查询。

Invoke promise 的成功/失败仍负责结束该组件的 pending 状态；如果同一 envelope 已由 event 先应用，回包在 reconciler 中被忽略只表示“不重复写副本”，不表示 command 失败。

应用 `session.changed` 时还要检查 Session 自身的持久化 revision：

- 本地不存在该 Session：安装 record；按 `messageChange` 安装 records 或标记 message cache invalid。
- incoming revision 小于或等于本地 revision：不重复应用 records。
- incoming revision 等于本地 revision + 1：应用完整 SessionRecord 和 message change。
- incoming revision 大于本地 revision + 1：该 Session 存在领域变更缺口，调用 `session:get` 替换 Session，并重建其 message cache。

每个 Session transaction 只把 `sessions.revision` 递增一次，即使它插入了一组连续 Messages。Message 仍用 `(sessionId, seq)` 幂等 upsert。查询得到的 snapshot 可以直接替换副本；事件 delta 不能跨 revision 缺口强行合并。

### 8.4 Bootstrap 无窗口丢事件

Renderer 启动不能采用“先 query、后 subscribe”，否则两步之间的 commit 会永久漏掉。固定握手为：

1. Preload bridge 先订阅 durable events，并在 renderer 完成 hydrate 前暂存有界 buffer。
2. Renderer 调用 `app:get-bootstrap`。
3. Backend 在与 write queue 一致的边界读取 snapshot，并一并返回当时的 `BackendEventCursor`。
4. Renderer 安装 snapshot。
5. 只重放同一 `backendInstanceId` 且 `sequence` 大于 snapshot cursor 的 buffered events。
6. 确认序号连续后切换为 live apply；实例变化、buffer 溢出或序号缺口都重新 bootstrap。

这套 buffer 只跨越一次 bootstrap 窗口，不是 durable queue。窗口 reload 后重新执行同一握手。

### 8.5 Query 时机与禁止轮询

Renderer 不定时轮询 Project、Session、Message、Goal/Plan 或 FileChange。Query 只用于：

- 应用 bootstrap 和 renderer reload。
- 切换 Session、消息分页、搜索和按需加载 FileChanges。
- revision/event cursor 缺口后的重同步。
- 用户显式刷新某项允许过期的 workspace read model。

Backend 自主产生的 durable state 一律通过 commit event 通知；invoke response 只确认当前 command，不能代替对其他 Session 和后台执行的订阅。

`run:stream` 不进入 durable reconciler。它按 `sessionId/runId` 更新 runtime overlay，允许包含独立的瞬时 sequence；缺口只触发一次 `session:get` 获取可用的 `ActiveRunPublicSnapshot`，不能轮询补 token。收到对应 Session 的完整 assistant/tool Message commit 后，renderer 清除已经被持久化事实取代的 overlay。Backend 不再持有 buffer 时，部分流式文本允许丢失。

### 8.6 无 durable change log

Durable-state changed events 由 commit 后的 backend event publisher 发送，不写 `session_change_log` 或通用 durable outbox。

Project 和 FileChange 变更直接推送有界完整 list snapshot；renderer 用新 list 替换副本。Renderer reload 或 main-process restart 后再通过 bootstrap/`file-change:list` 获得当前值。

Desktop 单窗口场景中，主进程崩溃会同时终止 renderer；重启后本来就会 bootstrap，因此不需要 durable outbox/change log。

### 8.7 Command 幂等

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
4. Commit 后通过回包和 `session.changed` 推送同一个 envelope，其中包含 SessionRecord。
5. Renderer 导航到新 Session。

创建 Session 不访问 Provider。空 Session 是真实 backend record。

### 9.2 Draft

Draft 和 draft attachments 只属于当前 renderer 输入组件：

- 不发送 IPC。
- 不进入 SQLite。
- 不保证切换 Session、renderer reload 或应用重启后保留。
- 点击发送时，renderer 把完整 text 和 attachment refs 一次性交给 backend。

Backend 校验附件、构造完整 user/harness messages 并落盘。Draft 丢失不会造成 backend state 与 canonical history 不一致。

### 9.3 模型和权限模式

模型下拉框发送 `session:update`，更新 Session `modelSelection`。它不修改全局 provider default，也不改变已经开始的 Active Run。

Active Run 开始时解析 immutable `ModelRouteSnapshot` 并保存在 memory；每个完成的 assistant message 记录实际 route。

权限模式同样由 backend 更新。Active Run 使用启动时的 mode snapshot。

### 9.4 发送与执行

1. Backend 校验 Session、Provider、并发和 writer 条件。
2. 预留 run slot/writer lease。
3. Transaction 插入完整 user/context messages。
4. Commit 后生成 `session.changed` envelope；`run:start` 回包返回该 envelope 和 runtime snapshot，push channel 发送同一 envelope。
5. 创建 `ActiveRunExecution` 并开始 provider/tool loop；其后 backend 自主完成的 assistant/tool commit 只需通过 push event 通知 renderer。
6. Stream delta 只存 memory 并推送 renderer。
7. 每个完整 assistant turn 或完整 tool batch 按 §7.2 写入 SQLite。
8. 完成、取消或失败后释放 runtime resources。

### 9.5 应用崩溃与重启

重启后：

- Session metadata 和完整 messages 从 SQLite 恢复。
- `inHistory = 1` 的 rows 重建 `CompiledCanonicalHistory`，再由当前 Protocol Adapter 编译 request。
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
  modelRoute: ModelRouteSnapshot
  permissionMode: PermissionMode
  controller: AbortController
  textBuffer: string
  reasoningBuffer: string
  pendingAssistantTurn?: CompletedAssistantTurn
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

Queued interjection 属于 ActiveRun memory。只有真正注入 canonical active history 时，才作为完整 `kind = 'interjection'` message 插入 SQLite。

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
- 根据 `kind` 隐藏 harness、折叠 internal message，并按有序 `parts` 组合 assistant text/tool calls 和 tool results；只有 `kind = 'user_input'` 渲染成用户气泡。
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

### 18.1 新数据库启用

切流版本首次启用 v2 persistence 时，创建 `agent.db` 并执行 SQLite schema migrations。旧 `workbench.json`、renderer localStorage 和 `change-history.json` 不参与新数据库初始化或状态恢复；新架构从 SQLite 中已有的 records 开始，没有 records 时显示空 Project/Session 状态。

切流不读取、改写、重命名或删除这些旧文件。`schema_migrations` 只负责 `agent.db` 自身的 schema version，不承担旧 Conversation/Message/FileChange 数据转换。

### 18.2 切换顺序

1. 引入 shared Session/Message/MessagePart schemas 和 SQLite repositories。
2. 引入 Project 和 FileChange repositories。
3. 引入只输出 `CompiledCanonicalHistory` 的 Message history compiler、Provider Protocol Adapter contract 和完整 tool batch transaction。
4. Runtime 改为从 messages 查询 active history。
5. Renderer 改为 Project/Session/Message/FileChangeSummary replica。
6. 删除 `workbench:save`、frontend conversation persistence、legacy change-history JSON 和 memory-only canonical history。

迁移不长期双写。

---

## 19. 测试与不变量

必须覆盖：

- Project/Session/Message codec round-trip，canonical project path 去重，以及 Project path 重新关联不改写 Session `projectId`。
- `kind + parts` discriminated union round-trip；单条记录的非法组合（例如 assistant 携带 tool-result part）在 shared/repository boundary 被拒绝，跨记录的缺失/重复 call 在 MessageHistoryCompiler 被拒绝。
- MessageHistoryCompiler 只执行 active-history policy 并生成 `CompiledCanonicalHistory`，不生成 wire `role` 或 Provider DTO。
- 相同 active MessageRecords、route 和 adapter config 生成确定性的 Provider DTO；不同 protocol adapter 的 golden tests 覆盖 Chat Completions messages、Responses items 和 Anthropic content blocks。
- Chat Completions 将 assistant tool-call parts 编译为 `tool_calls[]`、将每个 tool-result record 编译为 `role = 'tool'`；Responses 编译为 `function_call/function_call_output` items；Anthropic 把相邻 results 合并为 `user` message 中排在前面的 `tool_result` blocks。
- Protocol Adapter 可以将一条 canonical record 展开为多个 wire items，或把多条相邻 canonical records 合并为一条 wire message；不依赖一对一映射。
- `normalizedReasoningText` 只包含允许展示的非加密文本；缺失投影时 UI 不显示 reasoning，且不能从它重建 continuation。
- `ProviderContinuationEnvelope` 外层 schema 校验、`data` 原样 round-trip、数组顺序不变；签名、密文和 opaque item 不被 Core 改写。
- Adapter、route 或 format 不兼容时忽略 continuation 并重放 canonical history；损坏状态不得由 normalized reasoning 伪造。
- 删除或改变 metadata 不改变相同 route/adapter 下编译出的 Provider request；协议关键字段藏入 metadata 的 fixture 必须被拒绝。
- SQLite migration 顺序、checksum 不可变、单步 rollback、高版本拒绝、foreign key cascade 和 seq uniqueness。
- 移除 Project 会 cascade 删除其 Sessions/Messages/FileChanges，但不删除 workspace 目录或任何项目文件。
- Application service 的 Session/Message 多表事务回滚时，Repository 不得留下独立 commit。
- Durable mutation 的 invoke result 与 push event 携带同一个 envelope；event-first、response-first 和重复 delivery 都只更新一次 renderer replica。
- Bootstrap 在订阅后读取 snapshot/cursor；握手期间发生 commit 不丢失，cursor gap、backend instance change 或 buffer overflow 会重同步而不是轮询。
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

核心重启回归：

1. 用户发送 A。
2. Provider 产生 assistant tool call、tool results 和最终 assistant message。
3. 完整退出主进程。
4. 使用相同 `userData` 重启。
5. 发送 B。
6. 断言 `messages WHERE in_history = 1 ORDER BY seq` 能构造协议完整的 A/tool/final/B provider request。

现有 test、typecheck、lint、format、native、E2E 和 real-provider gates 继续保留；benchmark proof 不属于本次重构或后续发布门禁。SQLite driver 引入后必须覆盖 Electron native ABI 和打包 smoke。

---

## 20. 当前迁移状态

P0 regression gates 和 P1 shared canonical contracts 已实现。P1 target contracts 尚未接入 SQLite、现有 preload/IPC handler 或 renderer；这部分分别从 P2、P6、P7 开始。

当前 legacy 实现仍然：

- Renderer Pinia 保存 Conversation/timeline 并整体写 `workbench.json`。
- Project registry 仍位于 `workbench.json`，文件变更/回退记录仍单独写入 `change-history.json`。
- Main-process provider history 主要位于内存。
- Restart 后 UI history 与 provider history 可能不一致。
- Composer model selection 与实际 route 不是同一 canonical mutation。

这些不是 v2.1 的长期折中。新功能不得继续扩大 legacy 数据流。
