# 架构设计文档 · Zch Coding Agent

> 状态：Backend Architecture v2.1 已完成 P0–P11 · 2026-07-27
>
> 配套文档：[`requirements.md`](./requirements.md) 定义产品能力，[`frontend-spec.md`](./frontend-spec.md) 定义前端信息架构与交互验收。
>
> 本文同时是当前实现的规范。P6–P9 已一次完成 Durable IPC、renderer replica、production composition 切流和旧路径删除；P10 已完成事务、生命周期、通知、恢复与发布门禁收口。

---

## 1. 架构目标

Zch Coding Agent 是 Electron + Vue 3 桌面 coding agent。Backend 负责 Project 注册表、Session 元数据、完整消息历史、文件变更历史、Agent 编排和宿主能力；renderer 负责展示、收集输入并保存后端状态的副本。

目标结构：

```text
Renderer (Vue + Pinia)
  ├─ UI-only state：draft、draft attachments、layout、selection
  └─ backend replicas：Project、Session、paged Messages、Goal、Plan、FileChangeSummary；Todo 从当前已加载的 Messages 尽力派生，ActiveRun 另有临时 overlay
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
- 应用重启后可以从 SQLite 重建完整 canonical history，再由所选 `ModelProvider` 生成协议有效的 Provider request。
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

| 类别                      | 所有者           | 是否落盘 | 示例                                                                                   |
| ------------------------- | ---------------- | -------- | -------------------------------------------------------------------------------------- |
| Durable application state | backend + SQLite | 是       | Projects、Session metadata、完整 messages、Goal/Plan、有界 FileChanges/revert payloads |
| Ephemeral execution state | backend memory   | 否       | active Run、stream buffer、AbortController、pending approval、PTY/MCP connection       |
| UI-only state             | renderer         | 否       | draft、draft attachments、IME composition、scroll、panel、selection                    |

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
  domain-state-api.ts     # 业务状态 commands / queries / results / events
  project.ts              # ProjectRecord
  session.ts              # SessionRecord / SessionSnapshot
  message.ts              # canonical MessageRecord
  model-route.ts          # ModelSelection / ModelRouteSnapshot
  file-change.ts          # FileChangeSummary IPC schema
  runtime-events.ts       # ephemeral Run/stream events
  agent-api.ts            # Renderer capability manifest、派生类型与装配工厂
  ipc-contract.ts         # 旧导入路径的兼容出口
  ipc/
    application.ts        # bootstrap / window
    configuration.ts      # config / shell / Provider catalog
    projects.ts           # Project registry / workspace / ProjectModel
    sessions.ts           # Session / message / file change
    runs.ts               # Run / approval
    agents.ts             # Agent execution / plan
    terminals.ts          # Terminal commands
    integrations.ts       # MCP / skills
    diagnostics.ts        # trace / logs
    common.ts             # success/error envelope 与共享 payload
    events.ts             # push event envelopes
    registry.ts           # 全量 channel 注册表组合
  config.ts               # 旧导入路径的兼容出口
  config/
    application.ts        # logging / workspace
    assistant.ts          # language / preferences / prompts
    integrations.ts       # skills / web search / MCP
    models.ts             # 主辅模型角色与模型池组合
    network.ts            # proxy / network
    providers.ts          # Provider、目录与模型能力标注
    runtime.ts            # subagents / shell / limits / token estimation
    security.ts           # permission / privacy
    public-config.ts      # AppConfig 版本与八领域根组合
  ids.ts
```

`shared/` 不导入 Electron、Node.js、Vue、Pinia、SQLite driver 或 provider implementation。

配置契约固定分为 application、assistant、integrations、models、network、providers、runtime、security 八个领域。领域叶模块可以依赖已有共享原语，models 可以组合 providers，但不得反向导入 `shared/config.ts`、根 `public-config.ts` 或 IPC transport。`public-config.ts` 是唯一 AppConfig 版本与根结构组合点；`ConfigSection` 与 `ConfigSetRequest` 归 configuration IPC 领域所有，`shared/config.ts` 只为旧调用方兼容转出。新配置代码应直接依赖所属领域。领域拆分本身不得改变 schemaVersion 或持久化形状。

Renderer 设置页用一份显式 registry 把上述八个配置领域分别映射为一个一级菜单、页面组件和其拥有的 `ConfigSection[]`；导航与动态页面分发不得再维护两份手写列表。assistant 展示语言与偏好，models 展示主/辅助模型角色和模型池，providers 展示连接、凭据、目录与模型标注，runtime 组合 Subagents、Limits 与命令/终端 Shell，security 展示权限与敏感数据，integrations 组合 Skills、MCP 与 Web Search，network 展示 HTTP proxy，application 展示日志与诊断。内部 Prompt resource、隐私确认记录和 workspace 最近路径仍归所属领域，但不因存在 schema 就自动生成 UI。项目管理与已归档对话属于 durable data 操作，在侧栏单独归入“管理”，不声明 ConfigSection。一个领域页面可以组合多个独立保存区；跨领域只读派生允许，写入必须委托实际配置所有者，不能为了页面布局把不同领域重新绑定成隐式表单事务。

Renderer 配置状态按相同所有权拆为 application、assistant、integrations、network、providers、runtime 与 security store，models 的角色与模型池继续由两个既有独立 store 负责。`agent-runtime.applyConfig` 是配置快照进入 Renderer 后的唯一 fan-out 点，各 store 只写入自己拥有的配置；Provider store 对 Limits 更新仅重算未显式覆盖的模型 Token 派生值，不接管 Limits 草稿，也不得覆盖未保存的 Provider 编辑。兼容 UI facade 只路由旧组件仍需的公开字段与动作，不重新拥有状态。领域 store 的错误分别进入统一通知桥，避免一个领域的保存状态或错误覆盖另一个领域。

IPC 契约固定分为 application、configuration、projects、sessions、runs、agents、terminals、integrations、diagnostics 九个领域。一个领域可以为原注册顺序中的不同位置导出多个子注册表；`registry.ts` 按既有顺序把它们组合为唯一 `IPC_CONTRACTS`，并派生 `IpcChannel/IpcPayload/IpcResult`。`common.ts` 和 `events.ts` 是跨领域传输原语与 push envelope，不算额外领域。领域叶模块不得导入根 registry、events composer 或 `shared/ipc-contract.ts`；shared 内部生产代码直接依赖领域、registry 或 events，兼容出口只服务尚未迁移的跨层调用方。IPC 拆分不得改变 channel 集合、channel 顺序、IPC version 或任何 payload/result/event wire schema。

Renderer bridge 使用独立、显式的 capability manifest，而不是把整个 IPC registry 自动公开。`AGENT_API_INVOKE_ROUTES` 是公开方法名到固定 request/response channel 的唯一映射，`AgentApi` RPC 类型、`AGENT_API_KEYS` 和 preload 普通 invoke 方法都从它派生；manifest 中的 channel 必须属于 `IpcChannel`。订阅方法名同样由 `AGENT_API_SUBSCRIPTION_ROUTES` 派生，但 preload 保留 Agent/Terminal 事件转发、Backend notification 缓冲和 Domain State overflow/replay 的显式 adapter。最终 plain object 经 `Object.freeze` 后通过 `contextBridge` 暴露；Renderer 永远拿不到通用 `invoke/on`。Main business handler、sender 校验、payload/result validation 继续独立且显式，不能由公开方法名反射调用。

### 3.2 `electron/`

```text
electron/
  session/
    canonical-history.ts          # P3 MessageHistoryCompiler
    session-provider-turn.ts
    session-compact-coordinator.ts
  persistence/
    database-service.ts
    migrations/
    project-repository.ts
    session-repository.ts
    message-repository.ts
    file-change-repository.ts
    project-codec.ts
    session-codec.ts
    message-codec.ts
    file-change-codec.ts
  runtime/
    create-agent-runtime.ts
  providers/
    provider.ts
    provider-factory.ts
    http-sse-transport.ts
    deepseek-provider.ts
    generic-chat-completions-provider.ts
    chat-completions-shared.ts
    model-route-resolver.ts
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

`electron/application/` 包含 production 使用的 coordinator、Project/Session/FileChange services、run application service 和 live-session registry；Desktop 与 Headless 通过唯一 `createBackendRuntime` 组装它们。

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

唯一 Agent loop 必须注入 durable execution/FileChange ports。Desktop 使用 `userData/agent.db`；Headless 使用任务独立的临时 SQLite database，并继续共用 Prompt、Provider、Tool、Permission、compact 和 Agent loop。产品路径不存在 legacy memory/JSON fallback。

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

V1 record `schemaVersion` 固定为 1。Project、Session 和 FileChange `revision` 从 1 开始；空 Session 的 `lastSeq = 0`，首条 Message 的 `seq = 1`。所有计数使用不超过 JavaScript safe integer 的非负或正整数。Message page 最大 200 条并按 `seq` 升序返回；Session summary page 最大 200 条，按 `(updatedAt, id)` 降序并使用同一复合 cursor；Project list 最大 512 条；FileChange history 不设条数上限，但单页最多 200 条并按 `(createdAt, id)` 降序稳定分页；单次 Session commit 最多携带 512 条 Message records。

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

`name` 默认取目录名。ProjectModel、module 持久化和 Serena/code intelligence 当前整体关闭：生产 runtime 不装配 ProjectMetadataStore/CodeBackendManager，不读取、创建或改写 workspace 内的 `.zch/project-model.json`。普通 prompt harness 只在内存中做有界、只读的 module marker 探测。总路线图中的 Swarm hardening 完成后再把 ProjectModel 迁入 SQLite；旧 `.zch` 届时只作为一次性显式导入源，不能继续作为运行时真相源。

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

`modelSelection` 是下一次执行使用的当前选择。Backend 在 Run 开始时将它解析为不可变 `ModelRouteSnapshot`；除 provider/model/reasoning 和端点/配置 revision 外，snapshot 必须包含实际 `providerType`，以选择一个具体、扁平的 Provider 实现。`providerId` 是用户保存的配置实例，`providerType` 是代码实现类型；同一供应商的不同 API surface 使用不同 type。已完成 assistant message 记录该实际 route。

```ts
type ProviderPurpose = 'main' | 'approval' | 'title' | 'compression'

interface ModelRouteSnapshot {
  schemaVersion: 2
  purpose: ProviderPurpose
  providerType: string
  providerId: string
  model: string
  reasoning: ReasoningEffort
  endpoint: string
  providerConfigRevision: number
}
```

Snapshot 保存解析完成后的非凭据 route，而不是指向可变全局 Provider 配置的引用。`purpose` 表示 `main/approval/title/compression` 等模型用途，不是 wire role；API key、Authorization header 和 transport client 不进入 shared record。一次 Run 启动后，即使用户修改 Provider 配置，该 Run 仍使用已冻结的 provider type、endpoint、model 和 reasoning；新配置只影响后续 Run。

`endpoint` 必须是 HTTP(S) 绝对 URL，并拒绝 URL userinfo、fragment 和凭据型 query key。它是可进入 SQLite、renderer 和 trace 的非 secret route 信息，不能用来携带 API key、token、signature 或 Authorization 数据。

### 5.3 MessageRecord

```ts
interface ProviderContinuationEnvelope {
  schemaVersion: 2
  providerType: string
  format: string
  data: JsonValue
}

interface ProviderCompactEnvelope {
  schemaVersion: 1
  providerType: string
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
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    cacheMissTokens?: number
  }
  tool?: {
    name: string
    reason?: string
    resultProjection?: 'model-content.v1'
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
  transcript?: {
    format: 'zch-conversation-markdown'
    version: 1
    sourceThroughSeq: number
    sourceHash: string
    contentHash: string
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

interface ProviderCompactPart {
  type: 'provider_compact'
  payload: ProviderCompactEnvelope
}

type MessagePart = TextPart | ToolCallPart | ToolResultPart

interface MessageRecord {
  schemaVersion: 1
  id: MessageId
  sessionId: SessionId
  seq: number
  visibility: 'visible' | 'hidden' | 'superseded'
  turnId?: MessageId
  clientRequestId?: string

  kind:
    | 'system_instruction'
    | 'assistant_preferences'
    | 'selected_context'
    | 'runtime_context'
    | 'agents_context'
    | 'orchestrator'
    | 'interjection'
    | 'user_input'
    | 'assistant_turn'
    | 'tool_result'
    | 'compact_summary'
    | 'conversation_transcript'

  parts: Array<MessagePart | ProviderCompactPart>
  normalizedReasoningText?: string
  providerContinuation?: ProviderContinuationEnvelope
  modelRoute?: ModelRouteSnapshot
  metadata?: MessageMetadataV1

  inHistory: boolean
  createdAt: string
}
```

字段职责：

- `kind`：应用内部语义，renderer、搜索、导出、compact policy 和 `ModelProvider` 用它区分用户输入、编排注入和其他消息。`kind` 不是任何 Provider 的 wire `role`。
- `parts`：应用理解的、有序的 canonical payload atoms。V1 支持文本、工具调用和工具结果；图片、文件等多模态类型只在产品真正支持时以新的闭集 union member 增加，不接受开放任意 JSON part。
- `normalizedReasoningText`：可选、非加密、应用标准化后的可读 reasoning 文本或摘要，只用于 UI、导出和通用审计；它不是原始 CoT，也不能用于反向重建 Provider continuation。
- `providerContinuation`：可选的 provider-native continuation envelope。Core 只验证外壳并原样搬运 `data`；只有 `providerType + format` 对应的 Provider 实现可以解释它。
- `modelRoute`：已完成 assistant turn、Provider-native compact 或字面对话历史实际绑定的 route，便于重放、兼容性判断与审计。
- `metadata`：应用拥有并理解的 typed annotations，例如 attachment provenance、prompt id/hash、标准化 usage、approval/tool/compact 摘要和 reasoning projection 状态。
- `visibility`：`visible` 可进入普通 timeline/search，`hidden` 是仍可参与模型历史的内部记录，`superseded` 表示已退出当前分支的审计记录。
- `turnId`：把同一轮的 context、原始 user、assistant、tool result 和 interjection 关联起来；rewind/edit 使用它确定完整轮次边界。
- `inHistory`：是否属于下一次 provider request 的 canonical active history；它不决定本地审计记录是否存在，也不直接决定 renderer 是否展示。

`metadata`“与 Provider 协议无关”指的是：它可以来源于 Provider，例如标准化 usage，但删除 metadata 只能损失 UI、统计或审计信息，不能让下一次 Provider request 失去协议完整性。任何必须原样回传、只由对应 Provider 理解、或影响 continuation 正确性的字段都必须进入 `providerContinuation`，不能藏在 metadata 中。完整原始 Provider request/response、headers 和 stream events 属于可选 trace，也不进入 metadata。

实际 shared schema 必须是以 `kind` 为 discriminator 的闭集 union，而不是上面这个允许所有组合的宽松 interface：

- 原始 `user_input`：`clientRequestId` 必填，并用 `metadata.submission` 区分普通 `message` 与本地 `control_command`。
- 自动 compact 的 replay user 携带 `replayedFromMessageId`；控制命令生成的模型正文携带 `derivedFromMessageId + derivation = control_command_payload`。原始、replay、derived 三种 identity 严格 XOR，后两者都不复制 `clientRequestId`。
- 本地控制命令是 durable canonical log 的一部分，但永久 `inHistory = false`；普通 transcript/search 投影排除它，raw Message paging 仍保留它用于审计。Fork 会复制并 remap control/derived reference，但控制命令不能作为可见 fork point。
- `assistant_turn`：只允许 text/tool-call parts，至少一项；`modelRoute` 必填，可携带 reasoning projection 和 continuation。
- `tool_result`：每条 record 正好包含一个 terminal tool-result part；`callId` 必须对应之前 active assistant turn 中的 tool-call part。新结果必须带 `metadata.tool.resultProjection = 'model-content.v1'`，表示 `content` 已是模型可见的 canonical `TextPart | JsonPart`，不是 executor 的内部结果信封。
- `system_instruction/assistant_preferences/selected_context/runtime_context/agents_context/orchestrator/interjection`：V1 只允许非空 text parts；不存在通用 `harness` kind。
- `compact_summary`：旧记录允许 text summary；新记录保存单个 `provider_compact` part、实际 `modelRoute` 和 replacement boundary。Core 不解释 opaque payload，只有匹配的 Provider 可以重放；Chat/Anthropic 的合成摘要也使用版本化 `summary-text.v1` envelope。
- `conversation_transcript`：只允许 text parts，必须隐藏、携带目标 `modelRoute` 与 `zch-conversation-markdown` 的 source/content hash；仅用于不兼容 route 之间的字面历史迁移，不进入普通时间线。
- `normalizedReasoningText/providerContinuation` 不能出现在非 assistant record。
- `MessageMetadataV1` 也必须按 `kind` 收紧，不接受任意键。

MessageRecord 是持久化、排序、分页、compact 和 UI 派生的单位；MessagePart 是同一个逻辑消息内部的有序 payload atom。这是两层逻辑类型，不代表需要 `message_parts` 表；V1 将整个 parts array 作为受 shared schema 校验的 JSON 落在 `messages.parts_json`。

Tool executor 仍使用完整的 backend-private `ToolResult`，让权限、敏感数据检查、trace 和插件看到 `status/content/truncated/totalBytes`。进入模型历史前执行固定投影：

```text
execute / byte bound
  -> FileChange annotation
  -> sensitive-data filter
  -> ToolDefinition.projectResultForModel() or default projection
  -> projected token bound
  -> tool.completed + canonical tool_result
  -> ModelProvider.compile()
```

`projectResultForModel()` 同步、确定性、无 I/O，接收结果和参数副本；返回值经 canonical part schema 与 JSON-safe normalization 校验。默认规则是 string → `TextPart`、其他 `JsonValue` → `JsonPart`、空 string → `[no output]`。错误统一成为 `ERROR CODE: message`、`DENIED: message`、`CANCELLED: message` 或 `TIMEOUT: message` 文本。自定义 projector 失败只记录诊断并回退默认安全投影，不改变工具成功状态。单次与 Run 累计 Tool token 预算按投影后的实际模型内容计算；超限时只保留一个带统一截断标记的 head/tail TextPart。

旧记录的 metadata schema 仍允许缺少 marker，以便查看、导出和删除；但 `MessageHistoryCompiler` 遇到 active legacy tool result 时在任何 Provider 网络调用前抛出 `LEGACY_TOOL_RESULT_UNSUPPORTED`。不迁移或重写旧历史；compact/rewind 后已退出 active history 的旧记录不阻断新 epoch。

持久化 log、Provider active history 和 renderer transcript 是三个独立投影：

| 投影                    | 选择规则                                                      | 用途                              |
| ----------------------- | ------------------------------------------------------------- | --------------------------------- |
| Durable canonical log   | 所有已接受并 commit 的 records，包括 `hidden` 和 `superseded` | 幂等、审计、fork/reference 完整性 |
| Provider active history | `inHistory = true` 且非 `superseded`，再经 compiler 校验      | `ModelProvider.compile()` request |
| Renderer timeline       | `visibility = visible` 的 user/assistant/编排记录             | Chat timeline 与普通搜索          |
| Conversation Markdown   | 当前非 superseded 分支的 portable 语义投影                    | 用户确认后的本地导出与 route 迁移 |

因此“某条命令不发送给模型”不意味着“不落库”；同样，`inHistory = false` 也不等于删除或不可审计。

这两层不是从某一家 Provider DTO 原样复制出来的，而是从应用自己的两个不同问题推导出来：

| 层级            | 负责的事情                                                                 | 为什么不能合并                                                                                            |
| --------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `MessageRecord` | identity、Session 归属、全局 `seq`、幂等发送、持久化原子性、分页与 compact | 如果每个内容块都成为独立 record，Session 排序、一次 assistant turn 的原子提交和 UI 分页都会被协议细节打碎 |
| `MessagePart`   | 单个逻辑消息内的内容类型、局部顺序和 call/result 关联                      | 如果 record 只有一个字符串字段，就无法无损表达“文本 + 多个工具调用”或后续图片/文件等异构内容              |

它借鉴的是多个现代 API 都存在“外层事件/消息 + 内层有序内容单元”这一共同形态，但只保留本应用确实理解的最小语义交集。Chat Completions、Responses 和 Anthropic 的具体 message/item/block 仍由各自 Provider 生成，所以 canonical parts 不会随着某一家 wire schema 的升级而被迫迁移。

### 5.3.1 History Compiler 与 ModelProvider

持久化和请求边界固定为：

```text
SQLite row
  <-> Message codec
MessageRecord[]
  -> MessageHistoryCompiler
CompiledCanonicalHistory
  -> ModelProvider.compile(...)
provider wire request
  -> read-only hook / budget / trace
  -> ModelProvider.stream(...)
canonical ProviderEvent / CompletedAssistantTurn
```

`MessageHistoryCompiler` 只负责 provider-independent policy：按 `seq` 排序、选择 `inHistory`、应用 compact 边界、校验 record schema、payload bounds、Session/identity 和严格有序的完整 tool-call/result batch。它不生成 `role`、Provider message 或任何 SDK DTO。

```ts
type ProviderType =
  | 'deepseek.chat-completions'
  | 'generic.chat-completions'
  | 'generic.responses'
  | 'generic.anthropic'

interface ProviderToolDefinition {
  name: string
  description: string
  inputSchema: JsonValue
  intentParameter: string
}

interface ModelProvider {
  readonly providerType: ProviderType

  compile(input: {
    history: CompiledCanonicalHistory
    route: ModelRouteSnapshot
    tools: ProviderToolDefinition[]
    maxOutputTokens: number
    structuredOutput?:
      | { type: 'json_object' }
      | { type: 'json_schema'; name: string; schema: JsonObject }
  }): CompiledProviderCall

  stream(
    call: CompiledProviderCall,
    context: { signal: AbortSignal },
  ): AsyncIterable<ProviderEvent>

  compileCompact(input: {
    history: CompiledCanonicalHistory
    route: ModelRouteSnapshot
    instructions: string
    maxOutputTokens: number
  }): CompiledProviderCompactCall

  compact(
    call: CompiledProviderCompactCall,
    context: { signal: AbortSignal },
  ): AsyncIterable<ProviderCompactEvent>
}

interface CompletedAssistantTurn {
  parts: Array<TextPart | ToolCallPart>
  toolCalls: ToolCall[]
  normalizedReasoningText?: string
  providerContinuation?: ProviderContinuationEnvelope
  usage: ProviderUsage
  finishReason: string
}
```

`compile()` 与 `compileCompact()` 必须同步、无网络、无凭据且确定性地消费整个 ordered history；它们不是对每条 MessageRecord 做一对一 `map()`。编译可以提升 harness、合并相邻记录或将一条 record 展开为多个 wire items，但不能改写持久化 history。Synthetic compact 把压缩编排指令作为最后一个 wire input；原生 compact 则按对应协议的 compact request shape 编译。`stream()` 与 `compact()` 负责鉴权、HTTP/SDK、abort、流解码、usage 和恰好一次 terminal completion。Application service 校验结果后生成 ID/Session/seq/metadata 并落盘；Provider 不直接创建或插入 MessageRecord。

`GenericResponsesProvider` 优先使用原生 `POST /responses/compact`，把包含有效 `compaction` item 的 output 原样放入 `ProviderCompactEnvelope`，下一次同兼容 route 请求再原样编译回 input；接口形态以 [OpenAI Responses compaction](https://developers.openai.com/api/docs/guides/compaction) 为准。`GenericAnthropicProvider` 优先使用 beta `context_management` compaction，并以 `pause_after_compaction` 取得、保存和作为 assistant content 原样重放 `compaction` block；已知上下文低于 Anthropic 50k 最小 trigger 时直接使用 synthetic，协议依据见 [Anthropic compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)。两种原生实现只在明确的 capability/契约不兼容错误上降级到无工具 `summary-text.v1`；401/403/429、输入超窗、abort、网络错误和 5xx 不降级。进程内按 Provider type/id、endpoint、model 与配置 revision 缓存原生能力缺失；Chat Completions 与 DeepSeek 始终使用 synthetic。所有路径对 Core 都表现为同一个 opaque compact record。

| Canonical history                          | Chat Completions              | OpenAI Responses                         | Anthropic Messages                          |
| ------------------------------------------ | ----------------------------- | ---------------------------------------- | ------------------------------------------- |
| harness text                               | `system` message              | `instructions` / input message item      | top-level `system`                          |
| user/context/compact text                  | `user` message                | input `message` item                     | `user` text block                           |
| assistant text                             | `assistant` message           | output `message` item                    | `assistant` text block                      |
| assistant `tool_call` part                 | `assistant.tool_calls[]`      | `function_call` item                     | assistant `tool_use` block                  |
| one or more adjacent `tool_result` records | one `tool` message per result | one `function_call_output` item per call | one `user` message with result blocks first |
| native compact checkpoint                  | n/a                           | opaque `compaction` output items         | assistant `compaction` block                |

`role` 只是部分 wire 协议的字段，不是 canonical database field。OpenAI 官方把 Chat Completions 的基本单位称为 Message，而 Responses 使用包括 `message/function_call/function_call_output` 的 Items；Anthropic 则把 client tool result 放在 `user` message 的 `tool_result` content block 中。因此一条 MessageRecord 不要求对应一条 wire message/item。协议依据：[OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)。

三个协议使用同一个 canonical Tool Result renderer：单 TextPart 原样返回，单 JsonPart 只 `JSON.stringify(value)`，多 part 按顺序用换行连接，不序列化 `type/text/json/value` 外壳。各 Provider 只把结果放入自己的 `content/output/tool_result` 字段，并继续用 canonical `callId` 生成 `tool_call_id/call_id/tool_use_id`；Anthropic 在 `isError` 时设置 `is_error = true`。

Provider 实现保持扁平：`DeepSeekProvider`、`GenericChatCompletionsProvider`、`GenericResponsesProvider` 和 `GenericAnthropicProvider` 都直接实现 `ModelProvider`，互不继承。允许共享 HTTP/SSE、bounds、tool-call 拼接、hash/timing 等纯函数，但不引入 BaseProvider、协议方言层或任意 capability 组合。Provider factory 只按 `providerType` 做穷举选择；模型目录查询是独立服务，不扩充核心接口。目录模型容量按 `用户覆盖 > Provider 明确返回 > 内置资料 > 保守默认值` 解析；Anthropic `max_input_tokens/max_tokens` 可以直接归一化，OpenAI-compatible 与 DeepSeek 的标准 `/models` 只返回身份字段时不得猜测容量。

每个解析后的 `ModelProfile` 都携带非空的 `contextWindowTokens`、`compactThresholdTokens` 和 `maxOutputTokens`。Provider 设置页维护一个累计模型目录：目录刷新按大小写敏感的模型 ID 只追加新条目，不覆盖旧条目，也不删除本次响应缺失的条目；不提供目录接口的 Provider 可以通过显式“新增模型”动作把模型持久化到同一清单。该动作在单个配置事务中写入模型 ID、启用状态和包含三项 Token 配置及可选能力标注的 per-model override；校验失败时整个事务不落盘，空默认模型时新增项同时成为 Provider 默认模型。`provider-model-delete` 在同一个配置事务中移除非 Provider 默认、非当前辅助模型的目录项、启用状态和 override，并把引用该 route 的模型池条目置为 disabled；它是本地删除，若 Provider 目录之后仍返回相同 ID，刷新会重新追加。可筛选穿梭框只把完整清单投影为按 Provider 持久化的 `enabledModelIds`，它们是 Composer、主/辅助模型角色和 Swarm 的统一候选池；下方配置行始终覆盖全部已知模型，不再受穿梭框右侧筛选。Provider 默认模型可以从完整清单选择，选中时原子加入启用池，并在穿梭框中禁用移除；更换后旧模型仍保持启用但恢复可移除。启用池不进入 Provider revision 或 `modelOverrides`，但 route resolver 在冻结调用前确认模型仍处于启用池。AppConfig v15 将 v14 的 `modelConfigurationIds` 原样迁移为启用池；新安装允许尚未配置的 Provider 使用空默认模型和空启用池，因此不再伪造模型 ID，Renderer 在选定至少一个模型前禁用 Run。新目录模型即使只有 ID，也会立即用 256K 上下文、65,536 Token 最大输出默认值和可用 prompt budget 的 80% 压缩阈值形成完整 profile；上下文较小时输出默认值会被收窄，以至少保留 1,024 Token prompt budget。自动目录补齐的 profile 继续跟随全局默认值；手工新增对话框确认的显式配置和后续手工覆盖都不被全局设置反向改写。Provider 表单对合法修改采用 600ms 防抖自动保存，保存期间继续编辑时按最新快照追写；首次写入或替换 API Key，以及修改有凭据 Provider 的 Type/Base URL 后，会在保存成功后自动刷新目录。运行时从冻结 route binding 的 profile 读取输出上限与压缩阈值，不再从 Provider wire DTO 或当前可变表单推导。全局 `autoCompactTriggerPercent` 只负责为尚未覆盖的模型生成默认阈值。思考力度枚举为 `off|low|medium|high|xhigh|max` 六档；per-model overrides 还可标注该模型支持的思考档位子集（`reasoningEfforts`）与能力等级（`capability: light|standard|strong`），未标注的模型视为全档位支持。Provider 本身不保存 reasoning；已标注模型只在角色、Composer 和模型池对应的 reasoning 选择中呈现子集。route resolver 在冻结时拒绝标注集外的档位并明确报错，不做自动升降档，API 层不支持时的错误原样透传。`capability` 是 Model Pool 调度能力的唯一配置来源；pool entry 不再复制该标注。

S3 backend foundation 在 AppConfig v16 增加默认空的根 `modelPool`；v17 将 pool entry 的 reasoning 与全局六档枚举统一；v18 删除 entry 中重复的 capability；v19 再删除从未执行的 per-route `maxParallel`；v20 不改变模型池结构，v21 将其收拢为 `models.modelPool`，v22 只迁移模型角色 reasoning 而不改变 pool。模型池 entry 只保存稳定 ID、enabled 和 Provider/model/reasoning，不保存能力等级、并发配额、Provider revision、API key 或 credential reference；能力由对应 Provider 的 `modelOverrides[model].capability` 唯一决定，revision 只作为 `config:set(model-pool)` 的 optimistic concurrency 输入。保存路径先规范化完整数组，再通过共享静态路由规则与能力标注校验 enabled entry 并原子写盘；Provider 删除、模型移除、能力标注移除、reasoning annotation 变为不兼容和显式清凭据会在同一配置写入中禁用引用项，恢复不自动启用。启动/reload 修复 enabled 的静态不兼容或无能力标注引用，环境凭据暂时缺失仍留给 route freeze 显式失败。Renderer 的 `model-pool-settings` Pinia store 独立拥有 entry 草稿、已保存签名和保存状态；Models 设置页引用 Provider store 的公开目录，用 Naive UI Transfer/Tree 把候选投影为 `Provider → model → reasoning` 穿梭树，不复制 Provider 表单状态。叶节点使用 Provider/model/reasoning 三元组编码，因此同一模型的不同 reasoning 是可同时选择的精确 route；UI 不执行 fallback。最低 reasoning 门槛只隐藏左侧未选择候选，已选 route 始终保留在右侧，不进入 AppConfig 或调度策略。用户显式保存时发送一次完整 `config:set(model-pool)`；Provider 写入返回的自动修复配置仅在模型池草稿干净时回填，dirty 草稿保留并提示冲突检查。

Model Pool allocator 是不含 Agent task/name 的纯函数：freezer 先从同一 PublicConfig 快照把 enabled entry 与 Provider 模型能力标注组合为不持久化的 runtime candidate，allocator 再消费 candidate 与能力需求序列，让所有 `actualCapability >= requiredCapability` 的模型参与分配。它按声明顺序先 round-robin `Provider + model`，再轮询选中模型的精确 reasoning route，因此同一模型选择更多 reasoning 叶节点不会获得更高权重；符合要求的模型少于需求数时自然复用，cursor 不跨调用保存。freezer 计算覆盖全部 enabled candidate、派生能力与相应 Provider revision 的顺序敏感 SHA-256 digest，按 allocator 结果对每个唯一 entry 只解析一次 main/compression pair，并在返回前复核所有 digest Provider revision。backend-private prepared plan 保留 `ResolvedModelRoute`/API key；可序列化 safe snapshot v2 只保留 assignment 元数据和安全 route，不含 per-route 并发字段。缺少能力或能力标注在解析凭据前整体失败；已选 entry 不可用或 revision 竞态不会触发 fallback/reassignment。当前没有生产调用者，`subagent_run` 仍继承父 route。

模型路由的静态兼容性由 `shared/model-route.ts` 中的 process-neutral helper 统一解释：Provider 必须存在、模型 ID 非空且位于 `enabledModelIds`，显式选择的 reasoning 必须属于模型标注的 `reasoningEfforts`；未标注模型仍视为支持全部六档。Renderer 的角色草稿预检查、辅助角色持久化校验、Provider 删除 fallback 和运行时 route resolver 都消费同一结果及结构化失败原因。全局主模型角色是新对话偏好而非强制修复不变量：它因模型删除、停用或标注变化而失效时，新对话的 Provider/模型选择保持为空并禁用发送，等待用户显式重新选择；已有 Session 不受影响。该 helper 不检查凭据、Endpoint 安全性或 Provider 实时可用性，这些仍属于运行时边界。

Renderer 的运行限制表单以单列分节展示，`autoCompactTriggerPercent` 明确显示 `%` 单位。表单变更在 600ms 静默期后调用 versioned `config:set(limits)`；store 对发送中的快照签名，并在请求期间又有编辑时继续保存最新快照，避免用旧响应覆盖新输入。顶部按钮复用同一 action，用于立即提交和错误重试。

每个工具结果的模型投影独立受默认 64K token 上限保护，不再维护跨 Tool batch、Provider step 或整个 Run 累计的工具结果预算；通用工具输出与 `read_file` 内容边界为 128 KiB。`read_file` 默认/最多扫描 10,000 行，最终仍由字节与保守 token 估算先到者截断。执行器先保留独立 byte bound，模型 token 预算随后只计算 canonical projection，不再计算内部结果信封。完整 Provider 请求继续受冻结模型 profile 的 prompt budget 与自动压缩约束。AppConfig v14 从合法 v9–v13 配置删除退役的 `maxToolTokensPerRun`，其余限制保持既有迁移语义。

ProjectModel 与 code intelligence 暂停期间，Session tooling 不注册 `project_*` 或 `code_*`，provider tool catalog 还会无条件过滤这些保留 ID，旧 IPC 调用统一返回 `NOT_AVAILABLE`；因此 Desktop、Headless、main Agent 和 child Agent 都不能启动 Serena 或触发 `.zch` I/O。Provider parser 删除 intent metadata 后，ToolRegistry/executor 在权限与 schema 校验前再次按注册时记录的实际 intent field 清理，防止 `_agent_intent` 序列化泄漏导致偶发 `additionalProperties` 错误。

Auto approval 的审批模型是统一模型角色配置中的辅助精确 route（`models.auxiliaryModelProvider/auxiliaryModel/auxiliaryModelReasoning`），未配置或解析失败时回退到该 Run 的完整主模型 route；不再存在独立的审批配置。主/辅助角色各自保存 reasoning，Provider 不保存默认档位，也不做隐式升降档。模型角色由 `config:set(models)` 原子写入并经 Renderer Model Roles store 自动保存；创建、复制或保存 Provider 不能改写模型角色，Provider 草稿预检查只读取已保存的辅助精确 route。删除当前引用 Provider 时，辅助角色跟随当前主模型 route；主模型为空时辅助角色清空。加载修复会把不可用的辅助 route 改写为当前主 route。这样避免复制第二套 endpoint/credential 配置，同时保证审批路由不跟随 Provider 卡片草稿漂移。

Auto approval 的稳定前缀仅包含审批规则 prompt，动态 user payload 包含 tool/args/reason/workspace/policy signals。是否命中由各 Provider 的最小前缀、路由和 cache-control 语义决定；Application 不伪造命中，也不填充无意义文本。标准化 usage 将未被缓存覆盖的 input 记为 `cacheMissTokens`：OpenAI-style 用 input/prompt total 减 cached tokens，缺少 cached 指标时全部视为 miss；Anthropic 使用 uncached input 与 cache-creation input 之和，同时保留 raw usage。

Composer route 与 Provider 编辑草稿互相独立：已有对话始终读取冻结在 Session 上的 `modelSelection`，新对话读取显式 draft 或全局 active Provider；模型选项只读取该 route Provider 的 `enabledModelIds`，不能因设置页默认选中第一张 Provider 卡片而串表。历史 Session 引用已停用模型时保留显示值，但发送入口保持禁用，直到用户改选当前启用模型。

三个通用兜底 type 为 `generic.chat-completions`、`generic.responses` 和 `generic.anthropic`。Responses 固定 `store = false`，不使用 `previous_response_id` 或 Conversations API；完整 output items（含 encrypted reasoning）进入 `responses.output-items.v1` continuation 并由本地 history 精确回放。Anthropic 的非 off 思考档位使用 adaptive thinking 与 `output_config.effort`，档位值原样透传；完整 thinking、redacted thinking、signature 和 tool-use blocks 进入 `anthropic.message-content.v1` continuation。两者的 Provider Type/hash 不匹配均回退 canonical replay，同类型损坏 payload 明确报错。

Structured output 是携带 JSON Schema 的 provider-neutral 请求。Responses 编译为 `text.format`，Anthropic 编译为 `output_config.format`；DeepSeek 与 Generic Chat 为保持现有兼容行为继续降级成 `json_object`，Application 仍执行最终 schema 校验。Tool Result wire 字段只包含 canonical renderer 的正文，不包含 executor 的 `status/content/truncated/totalBytes`，也不包含 part 的 `type/value` 标签。

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

| 表                    | 用途                                                      |
| --------------------- | --------------------------------------------------------- |
| `schema_migrations`   | 数据库 schema 迁移                                        |
| `projects`            | Project/workspace 元数据                                  |
| `sessions`            | Session 元数据和当前 Goal/Plan                            |
| `messages`            | 完整、排序、可编译 Provider request 的 canonical history  |
| `file_changes`        | 文件变更与有界 revert 数据；不属于消息历史                |
| `subagent_executions` | Backend-private Agent/Swarm root-child 执行状态与安全结果 |
| `subagent_sessions`   | 隐藏 child Session 与 execution/parent 的归属关系         |

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

`provider_continuation_json` 保存完整 `ProviderContinuationEnvelope` JSON；`data` 保留 Provider 提供的原始 JSON 结构和数组顺序。若供应商状态需要逐字节保持，Provider 必须把原始字节编码成 envelope `data` 中带明确 format 的 base64/string，通用 codec 不得解析后重组。Repository 只验证 envelope 外层，对应 Provider 再按 `providerType/format` 验证 `data`。

`normalized_reasoning_text` 只保存可读明文投影，不保存签名、密文、redacted block、response cursor 或 provider item id。`metadata_json` 保存按 Message `kind` 校验的 `MessageMetadataV1` JSON；未知键默认拒绝，不能用它绕过 `provider_continuation_json` 的 Provider ownership。

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
  ON file_changes(session_id, created_at DESC, id DESC);

CREATE INDEX file_changes_retention_idx
  ON file_changes(created_at ASC, id ASC);
```

`file_changes` 只服务两个产品能力：

1. Diff 面板在应用重启后仍能按 Session 查看 Agent 的文件修改历史。
2. 用户可以不依赖 Git，安全回退某一项 `create_file/apply_patch/delete_file` 变更。

它不是 provider message、Run journal、trace 或通用 filesystem audit log，不进入 `messages`、`inHistory` 或下一次模型请求。`call_id` 只用于与对应 tool call/result 关联，不表示 Run 已持久化。

`operation = 'write'` 同时覆盖 `create_file` 和其他整体写入；`before_exists` 能区分“创建新文件”与“替换已有文件”，不需要再增加一个与恢复语义重复的 `create` 枚举。

记录流程：

1. 副作用前已有 resource precondition 中的 before content 和 diff，先计算 `payloadBytes = utf8(beforeContent) + utf8(diff)`。单条记录已超过总容量上限时，在修改文件前返回 `CHANGE_HISTORY_LIMIT_EXCEEDED`。
2. 文件工具完成原子写入/删除，并重新读取或校验实际 after existence/hash。
3. 在工具结果成为 terminal result 前，同一 FileChange transaction 先按 `(createdAt, id)` 删除最旧记录以满足全应用字节容量，再插入完整 `StoredFileChangeRecord`。删除使用有界 SQL batch，不把无界历史加载进内存。
4. Commit 后，工具结果才可以声明该变更支持 revert；随后按 §7.2 与其余 tool batch messages 一起写入对话历史。

如果 filesystem mutation 已成功但 FileChange transaction 失败，terminal result 必须同时如实返回 `mutationSucceeded = true`、`warningCode = 'CHANGE_HISTORY_PERSIST_FAILED'` 和 `revertAvailable = false`，不能宣称整个文件操作未发生，也不能自动重试副作用。Filesystem 与 SQLite 仍不是同一原子事务；崩溃可能留下文件变化但没有 FileChange/Message，这与 §7.2 的 crash tradeoff 一致。

如果副作用完成后重新读取的 after existence/hash 已不匹配审批结果，不保存 FileChange；tool result 仍保持成功并返回 `CHANGE_HISTORY_AFTER_STATE_MISMATCH`、`mutationSucceeded = true` 和 `revertAvailable = false`，React loop 可以继续。

FileChange 与 Message 故意不在同一个 transaction 落盘：前者紧跟每次已完成的文件副作用，后者要等当前 assistant tool-call batch 的所有 terminal results 齐全后才能原子提交。Message history 是 append-only 且参与 provider context；FileChange 会更新 `revertedAt`、按独立容量规则清理，并携带大容量恢复 snapshot。将两者混在 Message 中会破坏这些边界。

回退流程：

1. 在第一次 await 前取得 Session `mutating` lifecycle token，阻止同 Session Run/archive、Project path update/remove 和并发 revert。不同 Session 或 workspace 操作不参与产品级 writer 准入。
2. 当前文件 existence/hash 必须严格等于记录的 `afterExists/afterHash`；否则返回 `RESOURCE_CHANGED`，不能覆盖用户或后续工具的新修改。
3. `beforeExists = true` 时用 `beforeContent` 原子恢复，并把临时文件恢复为快照记录的 POSIX permission mode 后再替换目标；否则删除 Agent 创建的文件。ACL、owner、xattr 和特殊位不属于 v1 恢复承诺。
4. 成功后以 expected revision OCC 更新 `reverted_at`、`updated_at` 和 `revision`，最后释放 lifecycle token。

文件已经恢复但 `markReverted` 持久化失败时，不自动重做或补偿文件副作用；返回 `PERSISTENCE_FAILURE`，details 明确包含 `mutationSucceeded = true` 和 `FILE_CHANGE_REVERT_STATE_PERSIST_FAILED`。后续重试会因当前文件不再等于 after hash 而安全返回 `RESOURCE_CHANGED`。

AppConfig v9 的 `limits.fileChangeHistoryBytes` 是全应用总预算，默认 `100_000_000` bytes，允许 `1_000_000`～`10_000_000_000`。记录条数不设上限，200 仅是单页上限。降低配置不启动后台清理；下一次 insert 在同一 transaction 内收敛到新预算。Retention 只会让最旧单项失去 Diff/revert 能力，不修改 Messages 或 workspace。恢复 snapshot 永远不经 IPC；renderer 只接收 `FileChangeSummary`。

### 6.8 Message seq 与 transaction

Application service 通过 `DatabaseService.withTransaction()`：

1. 读取并递增 `sessions.last_seq`。
2. 插入一条或一组完整 messages。
3. 递增 `sessions.revision` 和 `updated_at`。
4. Commit。
5. 发布已提交 records。

`SessionRepository` 和 `MessageRepository` 接受同一个 transaction handle，不能在各自方法里提前 commit。多条 tool messages 必须在同一 transaction 获得连续 seq。

### 6.9 Hidden Agent execution

SQLite v5 增加 `subagent_executions` 与 `subagent_sessions`；SQLite v8 把 execution 升级为支持 Swarm root/child 的 schema v2。它们是 backend-private durable execution state，不加入 shared `SessionRecord` 或普通 Session replica：

- root execution 以 `(parent_session_id, parent_run_id, parent_call_id)` 唯一标识一次普通 Subagent 或 Swarm Job，保存 `kind/name`、参数 hash、`queued/preparing/running/terminal` 状态、安全 route snapshot、标准化 usage、有界结果/错误和时间戳。Swarm child 通过 `(parent_execution_id, child_ordinal)` 唯一归属 root；Job root 与全部 queued child 在同一 transaction 创建，避免半个 Job。
- execution 不重复保存 task 明文，也不保存 API key、endpoint、reasoning、trace 路径或 workspace 绝对路径；旧版 nullable `source_identity_json` 列只为数据库兼容保留，新执行不再写入。普通公开查询只分页返回 root，详情查询在校验父 Session 归属后附带有序 child 摘要。
- `subagent_sessions` 在 child 首条 canonical message commit 时原子记录 hidden Session 与 execution/parent 的归属。公开 Session get/bootstrap/list/search/export 必须排除这些 Session；backend 内部恢复使用显式 private query，不能靠调用方记得过滤。
- 相同 parent Session/Run/call 与参数 hash 可以直接复用已完成结果；相同调用标识但参数 hash 不同返回冲突，避免无意重复产生 Provider 费用。
- 应用启动时把遗留 `queued/preparing/running` execution 标记为 `interrupted`；Swarm root 使用有界的 Job interrupted 错误，不恢复 Provider stream，也不自动重试。
- 删除父 Session 或 Project 时由 foreign key/trigger 级联删除 child Session、execution 和 canonical messages；归档父 Session 时继续保留。

子 Session 自身仍使用普通 `sessions/messages` schema，从而复用唯一 Message history compiler、Session/Run loop 和 Provider runtime；hidden ownership 是正交关系，不挪用普通 fork 字段。

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

`MessageRepository` 通过 codec 将每一行无损解码为完整 `MessageRecord`。`MessageHistoryCompiler` 检查顺序、`kind/parts` 组合和 assistant tool-call/tool-result 配对，投影为 `CompiledCanonicalHistory`；当前 `providerType` 对应的 `ModelProvider` 再消费完整 history 并转换成具体 wire request。Repository 不返回 Provider DTO。

Session history 不再依赖 main-process `ProviderMessage[]` 或 Responses/Anthropic item arrays。Backend 可以缓存查询结果和已编译 request，但缓存只按 Session revision、route 和 Provider config 失效，不能成为真相源。

### 7.2 完整写入规则

#### User message

用户发送时，backend 在 transaction 中插入完整 `kind = 'user_input'` message。Commit 后才开始 provider call；不同 Session 不经过全局或 workspace 准入预留。

#### Assistant final message

Text/reasoning delta 只进入 `ActiveRunExecution` memory buffer，并通过 `run:stream` 推送。Provider 发出 completed turn 后，backend 才插入完整 `kind = 'assistant_turn'` message：公开、非加密的可读投影进入 `normalizedReasoningText`；协议连续性所需的原始结构进入 `providerContinuation`。两者都不按 delta 增量写数据库。

#### Tool call batch

不能在 provider 刚提出 tool call 时写一条缺少 tool result 的持久历史。流程固定为：

1. Provider completed event 直接携带不修改 Session 的 canonical assistant candidate。
2. Backend 在任何 completion event/plugin、canonical append、approval 或工具执行前校验 schema、parts/text/reasoning/JSON bounds、normalized tool-call 一致性，以及 active epoch 内全局唯一的 `callId`；失败只保留脱敏 raw trace/diagnostic。
3. Backend 使用 Provider usage 先完成 hard context-window 判定；达到上限时不发 completion event、不 append assistant candidate，也不执行工具，历史停在上一个完整边界。
4. 校验通过后，backend 在内存保存完整 assistant tool-call message，再执行权限、审批和全部 tool calls，得到每个 call 的 terminal result。
5. 单一 transaction 依次插入 `kind = 'assistant_turn'` message 和所有对应的 `kind = 'tool_result'` messages。
6. Commit 后才发起下一次 provider call。

拒绝、取消、超时也形成完整 tool message。这样数据库任何时刻都不存在“assistant tool call 已持久化，但 required tool result 缺失”的协议断裂状态。

Tool/approval 的实时卡片来自 runtime event；完成后 renderer 从 assistant/tool messages 的 `tool_call/tool_result` parts 和 typed metadata 重建稳定展示。

### 7.2.1 主模型 Provider attempt 重试

每个 ReAct step 只编译一次不可变 Provider request，并以该 request 进行有界 attempt：network、timeout、HTTP 408/409/425/429/5xx 最多重试两次，invalid SSE/JSON、`ProviderCompletionError`（包括 empty/reasoning-only）和无 terminal completion 最多重试一次，总 attempt 不超过三次。服务端 `Retry-After` 优先于指数退避并限制在 60 秒内；abort 会立即终止等待。鉴权、计费/配额、上下文上限、配置与 canonical invariant 错误直接失败。

每个物理 attempt 分配独立 `llm:*` call ID，写一组 `llm.request` 与 `provider.started`，失败时写单条 `llm.failure` 与 `provider.failed`，成功时才写 `llm.response`、usage 并调用 after-LLM plugin hook。Operational Provider 记录携带 `attempt/maxAttempts`；最终 Run 失败复用最后一次 attempt 的 diagnostic ID。before-LLM plugin hook 在逻辑请求编译后只调用一次，避免观察插件因网络补试重复产生副作用。

Provider delta 仍实时发送。若 attempt 失败且允许重试，Session Core 先发 `assistant.stream.reset` 清除该 attempt 的临时 text/reasoning/activity，再发带 `attempt/maxAttempts/delayMs` 的 `provider.retrying`。Public Run snapshot、Renderer overlay 和 internal Agent execution overlay 同步投影该状态；主时间线与 Agents 状态槽显示“正在重试 A/B”，不弹 NMessage。新的 assistant activity 或后续 Run status 会清除 retry 状态。失败 attempt 从不形成 canonical assistant record、工具 proposal 或审批；因此重试可能增加 Provider 费用，但不会重复执行本地工具副作用。

这个简化模型不承诺“宿主文件副作用”和 Message transaction 在进程崩溃下原子一致：如果工具已经修改文件、但应用在完整 tool batch commit 前崩溃，workspace 变化可能存在而对应 tool messages 不存在。`file_changes` 与显式文件/Git 工具可以重新发现当前 workspace 状态；runtime context 中的 Git 摘要和项目树只是提示性快照，不是 crash journal，也不能伪造丢失的执行历史。若未来要求 crash-atomic tool journal，必须重新引入 durable tool/run journal；它不是 v2.1 目标。

### 7.3 Compact 与 `inHistory`

`inHistory` 表示下一次请求使用的 canonical active history，不表示消息是否在 UI 可见。

自动 compact 只由刚完成响应的 Provider usage 驱动，不用本地 token 估算值决定是否触发：

1. Provider 未返回 `totalTokens`，且也没有完整的 `promptTokens + completionTokens` 时，本次不主动压缩。
2. Provider 已成功返回时，其响应是否适配上下文窗口具有最终权威；usage 达到或超过冻结模型的 `contextWindowTokens` 时保留完整 assistant turn，并按达到压缩阈值处理，不得因本地 profile 拒绝或回滚这次成功响应。
3. usage 达到 `compactThresholdTokens` 且响应包含 tool calls 时，先执行并原子提交完整 tool-result batch，再把包含这些结果的 active history 一起压缩。
4. usage 达到阈值且响应是本轮 final answer 时，不在回答结束后后台启动请求；下一次普通用户 Run 在插入新 user message **之前**先压缩旧历史。若应用编排要求同一 Run 继续，则在 continuation 前立即压缩。
5. 本地估算只记录为 prompt trace 与诊断信息，并继续用于工具、附件等有界输出投影；它既不触发主动压缩，也不得成为普通、压缩或历史转换 Provider 请求的硬门。真实上下文超限由 Provider 拒绝。

压缩调用以完整 active history 为输入；Synthetic compact 由 `compileCompact()` 将编排指令放在最后一个 wire input，原生 compact 使用协议专用字段。Synthetic compact 只有 terminal `finishReason = completed` 才能形成 checkpoint；截断、内容过滤、拒绝和未知终止都 fail closed。截断最多从同一完整 source history 追加更短摘要约束后纠正重试一次；网络、timeout、rate-limit 与 5xx 最多重试两次，完整但非法的响应最多重试一次，总调用数不超过三次。鉴权、计费、输入超窗、过滤/拒绝和取消不重试；`Retry-After` 等待有 60 秒上限且可被 Run abort。原生端点明确不支持或返回完整但不符合原生 checkpoint 契约的响应时，立即切换到拥有独立重试预算的 synthetic 请求。每次尝试及降级请求使用独立 trace call ID，失败尝试的文本 delta 不进入 Renderer；手动命令的 durable journal 只写一次。

Provider 成功后，单一事务把旧 active records 置为 `in_history = 0`，追加 fresh harness 和一个隐藏 `compact_summary`；失败、abort、空结果或重建超限时恢复旧 epoch。原消息始终保留在 append-only 数据库中，只是不再进入后续 Provider request。非取消的最终压缩失败统一以 `COMPACTION_FAILED` 结束 Run，Renderer 继续通过既有 Naive UI message 通道显示“压缩失败，请重试或打开新对话。”。

Responses 原生 compact 保存 opaque output items；Anthropic 原生 compact 保存 opaque assistant compaction blocks；两者不支持原生协议时与 Chat/DeepSeek 一样保存 opaque envelope 中的文本 summary。Core 只管理 record 的历史归属与可见性，不解释或重写 Provider payload。

手动 compact 使用独立 durable command journal：

1. existing Session 在完成语法、route、credential、active-history 和 compression budget 前置校验后，先提交原始 `/compact...` 为 `submission.type = control_command` 的隐藏 `user_input`；它永久 `inHistory = false`。`run:start` 返回的就是这次 command-input commit，随后才允许 compression Provider 调用。
2. 纯 `/compact` 成功后重建 `system → harness* → compact_summary` 并结束；合成文本摘要可以展示，原生 opaque checkpoint 不伪造可见文本。
3. `/compact <正文>` 成功后重建 `system → harness* → summary → derived user`；derived user 通过 `derivedFromMessageId` 指向原始命令，Provider 只看到正文。
4. compression 失败、abort、空摘要或重建超限时 epoch 不变，但已接受的原始命令记录保留；相同 `clientRequestId` 只 dedupe，不再次执行。

自动 compact 不是新的用户提交，因此不创建控制命令。

Compact summary 的 `metadata` 至少记录：

- `replacesThroughSeq`。
- source hash。
- compact prompt id/version/hash。
- compact model route 与标准化 usage。

不再需要独立 `context_checkpoints` table。

### 7.3.1 Route 兼容迁移与 Conversation Markdown

Opaque continuation/compact 只能在兼容 route 中原样回放。兼容键固定为 `providerType + providerId + model + endpoint + providerConfigRevision`；`purpose` 与 reasoning 档位不单独改变协议族。下一次 Run 若检测到 active assistant、transcript 或 compact anchor 与目标 route 不兼容，必须在插入新用户消息前执行事务式历史迁移：

1. 从 SQLite 读取该 Session 的完整、非 superseded append-only 分支，而不是只依赖当前分页或 active epoch。
2. 用共同的 `zch-conversation-markdown` 投影恢复用户输入、明文 assistant reasoning/text、orchestrator/interjection、tool call/result 和附件元数据；排除 system/runtime/AGENTS/selected context、控制命令、replay、旧 compact、旧 transcript、Provider continuation 与加密 reasoning。
3. 将 Markdown 放入 `<conversation_transcript><![CDATA[...]]></conversation_transcript>`；正文中的 `]]>` 拆为 `]]]]><![CDATA[>`，并记录 source boundary/hash 与精确 Markdown SHA-256。
4. 预检 `fresh harness → hidden conversation_transcript` 对目标模型有效后，单一 commit 停用旧 active history。随后才插入本次新 user input。

任一步失败都不修改旧 epoch，也不插入用户本次提问。普通 Session 侧栏提供同一投影的本地 Markdown 导出：导出不截断 tool result，保存前必须明确警告可能包含源代码、路径、工具参数/结果、内部编排和明文 reasoning。导出不包含 opaque compact、加密 reasoning 或 Provider continuation，也不能重新导入；hidden Subagent Session 仍不进入公开导出接口。

### 7.4 Provider continuation

`ProviderContinuationEnvelope` 统一的是可路由、可版本化的外壳，不统一不同供应商的 CoT 数据结构：

```ts
interface ProviderContinuationEnvelope {
  schemaVersion: 2
  providerType: string
  format: string
  data: JsonValue
}
```

它表示“这个已完成 assistant turn 若由兼容 Provider 继续，对应实现需要原样恢复的 provider-native 状态”。它不是 Session 全局 cursor，也不是标准化 reasoning。常见 payload：

```json
{
  "schemaVersion": 2,
  "providerType": "deepseek.chat-completions",
  "format": "assistant-turn.v1",
  "data": {
    "reasoning_content": "exact provider text"
  }
}
```

```json
{
  "schemaVersion": 2,
  "providerType": "generic.anthropic",
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
  "schemaVersion": 2,
  "providerType": "generic.responses",
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

`MessageHistoryCompiler` 不解析 `data`。具体 Provider 使用 Message 的 `modelRoute.providerType` 加 envelope 的 `providerType/format` 判断兼容性：

- 兼容：由该 Provider 使用原始 continuation。
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
session:list / session:get / session:update / session:archive / session:restore / session:delete / session:fork
message:list / message:search
file-change:list / file-change:revert
run:start / run:retry / run:continue / run:interrupt / run:interject
approval:decide
```

主进程推送分为 durable record changes 与 runtime stream，至少包括：

- `project:changed`：已经 commit 的完整 ProjectRecord list snapshot。
- `session:changed`：已经 commit 的 Session/Message records 和 revision。
- `session:removed`：已经永久删除的归档 Session 标识及其 Project 归属；renderer 必须清除相关 page/runtime cache。
- `file-change:changed`：无 retention 时发送单条 `upsert` summary；retention 删除旧记录时发送 `invalidate_all`，未来 renderer 清空全部 FileChange page cache 并按需重查。
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
  topic:
    | 'project.changed'
    | 'session.changed'
    | 'session.removed'
    | 'file-change.changed'
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

type FileChangeCommittedChange =
  | {
      mode: 'upsert'
      sessionId: SessionId
      fileChange: FileChangeSummary
    }
  | { mode: 'invalidate_all' }
```

Project 集合有明确上限，因此提交完整 list snapshot。FileChange history 无条数上限，event 只能携带单条 summary 或全局 cache invalidation，不能携带完整历史。Session event 总是携带完整 `SessionRecord`；纯标题、模型或权限等 metadata 更新使用 `mode = 'none'`，常规消息提交使用非空 `upsert` records。Compact 等操作如果影响的旧 Message 太多、会超过 IPC 上限，则使用 `mode = 'invalidate'`，renderer 丢弃该 Session 的已缓存 message pages，并通过 `session:get/message:list` 重取；不能发送无界事件。

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

Project 变更直接推送有界完整 list snapshot。FileChange `upsert` 更新命中的 page cache；`invalidate_all` 清空全部 FileChange pages，当前视图再按需调用 `file-change:list`。Renderer reload 或 main-process restart 后同样通过按需分页查询获得当前值。

Desktop 单窗口场景中，主进程崩溃会同时终止 renderer；重启后本来就会 bootstrap，因此不需要 durable outbox/change log。

### 8.7 Command 幂等

幂等使用业务键：

- User send：`UNIQUE(session_id, client_request_id)`。
- Local control command：同样先写原始 `user_input` 并使用 `UNIQUE(session_id, client_request_id)`；执行失败保留记录，同 ID 不重放副作用。
- Message：稳定 message id 和 seq unique constraint。
- Approval：active runtime 中一个 approval id 只接受一次 terminal decision。
- Session metadata update：backend 串行 command 和 revisioned response。

不持久化任意 `result_json`，也不维护需要清理的通用 command inbox。

---

## 9. 核心流程

### 9.1 Lazy Session creation

1. 点击“新对话”只在 renderer 建立 draft、候选 `sessionId`、model/mode/Goal/Plan 和附件引用；不发送 backend command，Sidebar 也不增加 Session replica。
2. 首次发送使用 `run:start { kind: "new_session", ... }` 一次提交候选 Session、initial system/harness/context 和原始 user message。
3. Backend 在外部 I/O 完成且所有 precondition 通过后，用单一 transaction 插入 Session 与首批 Messages。Session 初始 `revision = 1`，`lastSeq` 直接指向首批最后一条 Message。
4. Commit 后通过回包和 `session.changed` 发布同一个 envelope，候选 identity 此时才成为 durable Session；随后才允许 Provider request。
5. 已存在 Session 使用 `run:start { kind: "existing_session", ... }`，只追加本次 context/user records。

首次发送前的 terminal、interjection、approval 和 `/compact` 都没有 durable owner，必须返回 precondition error。失败前不得留下空 Session。

### 9.2 Draft

Draft 和 draft attachments 只属于当前 renderer 输入组件：

- 不发送 IPC。
- 不进入 SQLite。
- 不保证切换 Session、renderer reload 或应用重启后保留。
- 点击发送时，renderer 把完整 text 和 attachment refs 一次性交给 backend。
- 切换 Session、再次点击新对话或 renderer reload 时直接丢弃；draft 不进入 Sidebar 搜索结果。

Backend 校验附件、构造完整 user/harness messages 并落盘。附件正文受 AppConfig v9 的 `limits.maxAttachmentContextTokens` 约束，默认 `64_000`；聚合估算超过预算时，本次附件统一降级为仅注入类型和路径，renderer attachment chips 标记为 truncated。Draft 丢失不会造成 backend state 与 canonical history 不一致。

### 9.3 Rewind、用户消息重试、继续与编辑

- `session:rewind` 只接受当前分支中可见的原始用户或 Assistant 消息。用户边界会移除该用户整轮及之后记录；Assistant 边界保留对应用户消息，从 Assistant 开始移除。
- “移除”不删除 row：相关 records 改为 `visibility = superseded` 且 `inHistory = false`。每次 rewind 递增 Session revision、清除 Goal/Plan，并从保留前缀重建 `inHistory`；`compact_summary.replacesThroughSeq` 与 `conversation_transcript.sourceThroughSeq` 作为同等 epoch boundary，因此可以跨 compact 或 Provider transition 回退。
- `run:retry(userMessageId)` 只接受可见原始用户消息。它保留该用户消息及其本轮前置 context，supersede 之后分支，再复用该 user record 运行；不会插入第二条 user message。Assistant、replay、derived、control command 或其他消息类型都返回验证错误。
- `run:continue` 只在 idle Session 的 active history 停在可续跑边界时启动：忽略尾部 passive prompt layer 后，最后一个驱动记录必须是非 control-command 的 `user_input`、`tool_result`、`interjection`、`orchestrator`，或带 `turnId` 的自动 `compact_summary`。完整 `assistant_turn`、手动 compact summary 和 conversation transcript 都是终止边界。Application 与 Session Core 必须分别校验当前 revision 和 live canonical history。
- 继续复用该记录的 `turnId`（缺省时复用记录 ID）作为原始轮次，不追加空 user message，也不产生初始 durable commit；新的 Assistant/tool commit 仍通过正常 `session.changed` 发布。Renderer 只在最后一个匹配轮次的消息操作栏显示“继续”，点击后直接调用，不经过 composer。
- 编辑先按该用户整轮 rewind，将原文和附件引用恢复到 composer，不自动发送；下一次发送创建新的用户轮次。
- Fork 只复制当前非 superseded 分支，连续重编号并重映射 message/turn/reference IDs，以及 compact/transcript epoch boundary。
- 所有操作只修改 Session/Message 状态。文件、终端与 MCP/外部工具副作用不回滚，FileChange 审计继续保留；UI 在操作前明确提示。

### 9.4 模型和权限模式

模型下拉框发送 `session:update`，更新 Session `modelSelection`。它不修改全局 provider default，也不改变已经开始的 Active Run。

Active Run 开始时解析 immutable `ModelRouteSnapshot` 并保存在 memory；每个完成的 assistant message 记录实际 route。

权限模式同样由 backend 更新。Active Run 使用启动时的 mode snapshot。

### 9.5 发送与执行

1. Backend 校验候选/已有 Session、Project、Provider、credential/notices 和同 Session lifecycle 条件。
2. 冻结 route、credential、model profile、permission mode 和本次 Run 工具 catalog。
3. 在 transaction 外异步构造完整 harness/context；transaction 插入 Session（仅首次）和完整 user/context messages。
4. Commit 后生成 `session.changed` envelope；`run:start` 回包返回该 envelope 和 runtime snapshot，push channel 发送同一 envelope。
5. `ActiveRunExecution` 在 commit 后开始 provider/tool loop。其后 backend 自主完成的 assistant/tool commit 只需通过 push event 通知 renderer。
6. Stream delta 只存 memory 并推送 renderer。
7. 每个完整 assistant turn 或完整 tool batch 按 §7.2 写入 SQLite。
8. 完成、取消或失败后释放 runtime resources。

用户中断或可恢复的 Provider failure 后，若 durable history 符合 §9.3 的续跑边界，`run:continue` 可以从同一 canonical turn 重新进入第 5 步；streaming 中尚未完成的 Assistant text/reasoning 不会被恢复或伪造。

Durable execution port 对每个 Session 串行 commit。commit 失败时从 SQLite 单次恢复 SessionRecord、active history、next seq、mode/model/Goal/Plan，并清除未提交 request 映射；恢复也失败时 binding 标记为 invalid，当前 Run settle 后强制驱逐。tool-batch commit 失败即使恢复成功也会隔离当前 live binding，避免带着已发生但未落库的副作用继续 React。

`LiveSessionContextRegistry` 使用带 ownership token 的 `reserved → loading → live ↔ mutating → evicting/invalid/releasing` 状态机。并发候选 Session 只有 owner 能清理自己的 manager context/binding；lazy restore 从首次串行 durable read 起就参与 Session/Project lifecycle guard。Registry 的 idle 检查同时覆盖 active Run、未完成副作用、terminal 和 SessionManager 的 metadata mutation，避免 plan/mode commit 与 archive、rewind、fork 或 Project eviction 交错。Archive、Project path update/remove 会先取得 eviction lease，成功 commit 后的资源清理失败只记录诊断，不把已提交事务改报失败。

Application boundary 保留显式 `ApplicationError`；SQLite/codec 故障归一化为安全的 `PERSISTENCE_FAILURE`，其他未知异常归一化为 `INTERNAL_ERROR`。原始 cause 只进入主进程诊断，不通过 IPC 暴露路径、SQL 或其他内部消息。Backend 启动失败时始终尝试全部清理；清理或诊断失败不得覆盖最初的启动错误。

### 9.6 应用崩溃与重启

重启后：

- Session metadata 和完整 messages 从 SQLite 恢复。
- `inHistory = 1` 的 rows 重建 `CompiledCanonicalHistory`，再由当前 `ModelProvider` 编译 request。
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
  todo?: TodoState
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

## 11. Goal、Plan、Todo、Interjection 与并发

### 11.1 Goal 和 Plan

Goal/Plan 会跨越多个 provider turn，并影响下一次 prompt 和 continuation，因此属于 Session durable metadata，保存在 `sessions.goal_json/plan_json`。

模型工具和 renderer command 调用同一个 Session application service。更新成功后 backend commit Session，再向 renderer 推送 SessionRecord。

需要进入模型上下文时，backend 生成完整 harness/orchestrator Message。Goal/Plan 的当前状态不依赖 runtime memory。

### 11.2 History-derived Todo List

Todo List 是模型自行维护的当前任务执行清单，不是 Durable Plan 的别名。`shared/todo.ts` 一次定义 `TodoState`：一个不超过 65,536 字符的可选 explanation 和至多 128 个有序 item；item 只包含不超过 1,024 字符的 step 与 `pending | in_progress | completed` 状态。完整快照至多允许一个 `in_progress`，不使用稳定 item ID、增量 patch、取消态或完成证据。

Provider 只看到一个 `todo_update` 工具。每次调用必须提交完整有序快照，因此替换、重排和多项状态推进都是一次原子更新。工具按 serial 执行，校验 `sessionId/runId` 与当前 `ActiveRunExecution` 一致，使用低风险、无 workspace 副作用的既有执行路径，不进入人工审批，也不创建、修改或完成 Goal/Plan。普通 Main、Headless 和 child 使用同一 schema；child catalog 包含 Todo，但 internal Session 的 `todo.updated` 不投影到父 Session。

成功的 `todo_update` assistant tool call 与对应 `tool_result` 是 canonical history 中的事实记录。Renderer 按顺序归约当前已加载消息中已完成且非错误的调用，从参数重建快照，并将最新快照暴露为 `currentTodo`；协议工具卡片仍从普通 Tool Call 折叠栏隐藏。输入框上方用 Naive UI 的紧凑单行预览展示当前 `in_progress` item，没有时回退到第一个 `pending` item；鼠标悬停后在有界 Popover 中展开完整只读 checklist，全部完成时隐藏预览。Todo 与输入框在同一纵向布局中参与正常文档流，不使用绝对定位覆盖输入框，也不生成时间线项。失败、拒绝、取消、超时或缺少结果的调用不改变 Todo。应用重启、Session 切换和 Run 终态 reload 都从有界消息页尽力重建，不另存需要同步或删除的 Session Todo 字段；更新落在未加载的更早页、被压缩或无法从原始参数解析时，Todo 可以暂时不显示。

`ActiveRunExecution.todo`、`todo.updated` 与 `ActiveRunPublicSnapshot.todo` 只负责成功调用后的低延迟显示、窗口 resync 和终态 durable reload 完成前的过渡。Run 结束或下一 Run 开始不向历史追加清空标记，也不注入 `<todo_state>`；后续模型像处理其他工具一样，从 conversation history 中最近的成功 `todo_update` 理解当前清单。Provider compact 依靠 handoff summary 保留当前进度，route 转换依靠 complete-history transcript，不维护 Todo 专用 checkpoint。

### 11.3 Interjection

Queued interjection 属于 ActiveRun memory。只有真正注入 canonical active history 时，才作为完整 `kind = 'interjection'` message 插入 SQLite。

应用崩溃前仍未注入的 interjection 可以丢失。

### 11.4 并发边界

- 每个 Session 同时最多一个 Active Run。
- 不设置全应用 Active Run 准入上限；不同 Session 可以同时运行。
- 不按 canonical workspace 建立 writer lease、只读降级、启动拒绝或并发警告；同一 workspace 的多个可写 Session 可以并发。
- 文件工具继续使用路径守卫、调用级 precondition、原子替换和 FileChange revision；这些保护检测具体资源冲突，不充当 workspace 并发锁。
- 同一 Session 的 active Run、metadata mutation、revert、归档和关闭仍按线性历史与 lifecycle token 互斥。
- 不可中止副作用仍在执行时继续由其 Tool 生命周期跟踪到 Promise settle，但不占用 workspace 准入资源。

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
- 根据 `visibility` 与 `kind` 隐藏 internal/superseded records，并按有序 `parts` 组合 assistant text/tool calls 和 tool results；只有当前分支中可见的原始 `user_input` 渲染成用户气泡。
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

| 数据                                                 | 存储                                     | 所有者            |
| ---------------------------------------------------- | ---------------------------------------- | ----------------- |
| Projects、Sessions、Messages、Goal/Plan、FileChanges | `userData/agent.db`                      | backend           |
| 非敏感应用/provider 配置                             | backend config repository                | backend           |
| API keys                                             | Electron safeStorage-backed secret store | backend           |
| Trace                                                | `userData/traces/*.jsonl`                | backend           |
| Operational runtime logs                             | `userData/logs/runtime/*.jsonl`          | backend           |
| Skills                                               | `userData/skills/`                       | backend manager   |
| ProjectModel                                         | 暂停持久化；目标为 `userData/agent.db`   | backend（迁移后） |
| Prompt resources                                     | versioned application resources          | backend registry  |

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

## 15. Operational Log、Trace 与产品状态

SQLite 是产品持久状态的真相源；Operational Log 与 JSONL Trace 都是 failure-isolated side channel，不用于 Project/Session/FileChange 恢复。

Operational Log 由类型化 `OperationalLogService` 独占写入，Desktop 使用隔离的 `electron-log/main` instance，Headless 使用 `electron-log/node`；两者都关闭 console、IPC 和 remote transport，不调用 Renderer `initialize`/preload。默认 `info`，正常 Provider/Tool attempt 只在 `debug` 出现，错误在默认级别仍可诊断。JSONL 信封包含进程实例、单调 `seq/eventId`、稳定错误码、`diagnosticId` 与显式 correlation IDs；业务只能提交白名单字段，不能把任意 object、Provider body、工具内容或 Error 原样交给 transport。单文件 5 MB 后同步改名为唯一时间戳归档；清理只处理已关闭文件，并把活动文件计入总容量。

Operational Error 在进入 schema 前移除凭据、URL secrets 和绝对路径，只保留有界首行、最多两层 cause 与 16 个规范化 frame。写入、轮转和清理异常只令服务进入 degraded，不向 Provider、Tool、IPC 或退出流程抛出。Renderer 只能读取状态、打开目录和清理历史，不能读取日志内容。

Trace 文件采用 segmented capture，而不是“一 Session 一固定文件”。每次在 idle 状态启用日志或恢复一个已存在的 Durable Session，`SessionTraceController` 都以唯一 `traceId` 独占创建新文件，写入 `session.start`，并令该片段的 `seq` 从 1 开始。关闭日志、关闭 Session 或切换 capture 时写入带原因的 `session.end`；旧文件保持只读，不追加、不改名、不补录历史。`TraceInfo.sessionId` 负责把多个 capture 归属到同一 Session，Session transcript 入口选择最新片段，日志设置页仍列出全部片段。

`logging.operational` 的 level/retention/size 保存后立即热更新；`logging.trace` 开关广播到所有 live Sessions。idle Session 立即切换 Trace；active Run 仅记录 pending 值，并在该 Run 的 `run.end` 完整写入后应用最后一次保存的设置。因此运行中开启不会产生半截当前 Run，运行中关闭也不会丢失当前 Run 终态。未加载 Session 在 restore 时读取当前配置。主进程通过 `TraceCaptureStatus` 和 `trace.capture.changed` 暴露 `disabled | pending | active | degraded`，renderer 只显示状态，不拥有日志生命周期。

日志是 failure-isolated side channel。创建或写入失败时 controller 保留不完整文件用于诊断、切换为 Null logger 并发布有界 warning，业务请求继续；配置仍开启时，下一 Run 开始前尝试新建独立 capture。Retention 保护集合使用当前 controller 的真实 `traceId`。

Trace v3 可以记录比 messages 更细的内容：

- Run lifecycle 和失败/取消原因。
- 聚合成功响应，以及一条带稳定 code/diagnostic ID 的 `llm.failure`；失败证据最多 256 KiB 并带观察字节数、截断位与 SHA-256。
- canonical source 摘要、冻结 route、prompt build 和 request-specific selection。
- 最终 wire request、canonical completion、必要 raw response、timing 和 usage。
- pending approval、tool attempt、writer、terminal 和 runtime diagnostics。

Logging 关闭时这些细节可以不存在，但 Projects、完整 Messages、Session metadata 和未被 retention 清理的 FileChanges 仍必须落盘。

Restricted transcript 可以组合 SQLite messages 与 trace；缺少 trace 时明确省略 runtime 细节。

Trace 不记录 credentials。生产 `TraceEventInput` 不允许 `llm.stream`，正常 token/SSE 增量只存在于 backend memory 和 Renderer overlay；失败前 partial text/reasoning 不落盘。reader 会把 v2 records 投影为 v3，并保留旧 `llm.stream` 的只读查看能力，文件本身不改写；v1 仍明确拒绝。trace fork/start-fork API 和 UI 已移除，普通 Session fork 不受影响。

---

## 16. Project、Terminal、Skills、MCP 与插件

这些服务继续由 backend 拥有：

- Project explorer 继续读取普通 workspace 文件；ProjectModel/Serena/code intelligence query 暂停，等待总路线图中的 Swarm hardening 完成后迁移到 SQLite。
- PTY process、scrollback 和 ownership 属于 LiveSessionContext；应用重启不恢复真实 PTY。
- Skills manager 扫描、安装和启用 skill。
- MCP manager 拥有连接、目录 revision、tool normalization 和调用。
- Plugin event bus 是 backend hook/event mechanism。P11 的 `beforeLLMCall` 只收到不含凭据的编译请求深拷贝；它只能观察，不能 patch、阻断调用或改写 canonical history，handler 失败只产生诊断。

它们需要加入模型历史时，只能创建完整 Message；不能把半完成内部状态写进 messages。

### 16.1 `run_command` 与 Terminal 的解释器边界

`run_command.process` 始终把 `executable + args[]` 交给 `spawn(..., { shell: false })`。`run_command.shell` 也不使用 Node 的隐式 Shell：Main process 根据当前 AppConfig v24 的 `executionEnvironment.commandShell` 解析受支持 profile，再由 profile adapter 生成明确的 executable、固定启动参数和命令字符串参数，最终仍以 `shell: false` 启动。权限预览和 canonical ToolCall 保留模型提交的原始命令，不暴露 adapter wrapper。

Windows 发现只扫描 PATH 与有限的系统/安装目录，内置 profile 为 PowerShell 7、Windows PowerShell、CMD、Git Bash 和 Nushell；`auto` 固定选择 PowerShell 7 → Windows PowerShell → CMD。Git Bash 与 Nushell 只在用户显式选择时使用；System32 的旧 `bash.exe` 不会被误识别为 Git Bash。已保存 profile 消失时，解析结果临时回退到 `auto`，通过只读 `command-shell:list` IPC 把实际路径和 fallback 状态提供给设置页，但不改写保存值。WSL 与任意自定义 executable/args 仍属于 M5 后续范围。

Prompt Harness 在每个外部 Run 开始时读取同一配置并只注入实际解析后的 `command_shell: label (id)`；同一 Run 的后续 Provider 调用不重复刷新。runtime 语义指纹包含 Shell、权限、Provider、工具集合和 module markers 等稳定字段，但排除精确时间、Git 摘要与项目树；只有稳定指纹变化时才采集并追加包含最新 Git/项目树的完整快照。AGENTS 也只在外部 Run 边界检查，因此 Run 中途的规则变更从下一 Run 生效；会话创建、权限更新与 compact 新 epoch 仍按各自边界重建 Harness。`run_command` schema 不接受 shell ID，因此模型不能自行选择未安装解释器。工具执行前会再次解析 Shell，以应对调用期间安装状态变化。内部 Git、Subagent 和其他直接进程不读取该选项。

PowerShell adapter 固定传入 `-ExecutionPolicy Bypass`，并设置 Console 与 pipeline 输出编码；CMD adapter 先切到 code page 65001，Bash/Nushell adapter 设置 UTF-8 locale。应用不预检 Execution Policy，也不把相关失败改写为专用错误；原始 stderr 和 exit code 沿普通 Tool Result 返回。`BoundedProcessOutput` 对 stdout/stderr 独立流式校验 UTF-8；若实际字节无效，则使用启动时探测到的 Windows 当前代码页解码保留区。字节上限、head/tail 截断、discard hash、超时、取消、进程树终止和子进程环境 allowlist 均保持原有边界。`run_command` 是一次性 Tool，不把实时输出投影进 Renderer Terminal。

交互 Terminal 与 `run_command.shell` 共享同一个 `executionEnvironment.commandShell` 配置。`terminal_open` 没有模型可见的 `shell` 参数；TerminalPool 在每次打开时读取当前配置并经 `CommandShellService.resolve()` 解析实际 profile，配置项失效时沿用自动回退且不改写保存值。解析出的 profile `kind = powershell` 时 PTY 固定传入 `-ExecutionPolicy Bypass`，其他 kind 不附加启动参数。设置变更只影响之后打开的 Terminal，已在运行的 Terminal 不重启。

模型可见的 `terminalId` 是进程内全局递增的正整数：应用重启后从 `1` 重新开始，ID 一经分配在当前进程内不复用，启动失败允许留下编号空洞。每个 Session 最多保留 16 个 Terminal（含 opening、running 和已退出但未显式关闭的条目），显式关闭立即释放名额；打开前同步预留名额，Tool 与 Renderer 并发打开不会越过上限。Session 关闭按世代（generation）作废仍在启动中的打开尝试，Pool 释放后拒绝新的打开，两者都不会留下孤儿 PTY。`terminal_list` 按数字 ID 升序返回；不存在或不属于当前 Session 的 ID 统一返回 `Terminal not found for this session`。旧日志与旧 Tool result 中的字符串 ID 不做迁移。模型侧不再有 `terminal_resize` Tool；Renderer 面板自动 fit 后仍通过 `terminal:resize` IPC 同步 PTY 尺寸，模型无法手动控制虚拟终端尺寸。

---

## 17. Headless 与 Runtime Parity

Headless 继续复用唯一 Agent runtime：

- 每次执行使用独立临时 SQLite database。
- Desktop 和 Headless fake-provider trajectory 比较 active messages、provider requests、tool results、prompt hashes 和 patch。
- Headless 产物从 canonical messages、trace 和独立 Operational Log 生成，不依赖 renderer store；stdout JSONL 永不混入文件日志。
- Run/stream 细节来自 trace，而不是 `runs` table。
- Runtime identity 固定 source commit/tree、task/config digest、Provider/model、核心预算、prompt/tool hash 和宿主 capability。

---

## 18. Subagent Runtime 与显式工具权限

### 18.1 调用与路由冻结边界

`subagent_run` 是由主 Agent 调用的普通 Tool，接收 `{ name, task, toolAccess }`。`name` trim 后允许 1–64 个 Unicode 字符，但拒绝控制/格式字符和 `__proto__/prototype/constructor`；`task` trim 后允许 1–32,768 个字符；`toolAccess` 必须为 `readonly | inherit`。Tool description 要求任务自包含，调查任务使用 `readonly`，只有任务确需父 Run 的非只读能力时才使用 `inherit`。

```text
parent ToolCall
  → ordered Tool preparation/approval
  → SubagentExecutionPort.runOne
  → parent canonical workspace
  → hidden Session with frozen delegated Tool context + ordinary user_input(task)
  → existing Session/Run/Provider loop
  → final assistant text
  → standard ToolResult { results, meta }
```

主 Run 开始时冻结 `subagents.enabled`；设置热变更从下一个 Run 生效。child 精确复用父 Run 已冻结的 main/compression `ResolvedModelRoute`，包含模型 profile、Provider revision 和仅存在于内存的 credential binding；运行中配置变化不能换模型、reasoning 或 API key。child 不复制父 canonical history，只加载普通基础 harness、用户偏好、当前 workspace 的 AGENTS 和 skill 摘要，随后把 `task` 作为普通 `user_input` 追加。

`SubagentExecutionPort` 是 Tool Registry 与 application/runtime 之间的 backend-private 注入边界；延迟 bridge 解除 runtime 构造环。Desktop 与 Headless 都从 `createBackendRuntime` 注入同一个实现，不创建第二套 Provider loop。

### 18.2 Tool batch 与 child profile

`ToolDefinition.executionMode` 支持 `parallel | serial`，未声明时 fail-closed 为 `serial`。SessionToolRunner 按 Provider call 顺序切分最大连续 parallel 段，每个 serial Tool 独占一段并成为前后完成屏障。每段先按顺序完成 normalize、MCP resolution、权限/审批、上下文 preflight 和 mutation preparation；parallel 段只并发 Tool body；文件变更提交、输出过滤、事件、插件 after hook 和 canonical Tool Result 再按原 call 顺序完成。单项拒绝、失败或 timeout 不取消兄弟调用，父 Run 取消则中断所有 active body 并为每个 call 补齐终态结果。

内置 parallel Tool 包含文件/代码/Git/Project/Skill 读取、`fetch`、`web_search`、`delay`、MCP discovery、`run_command` 和 `subagent_run`；文件/Git/Project 写入、实际 MCP、全部 `terminal_*` 以及未知 Tool 为 serial。`run_command` 是明确例外：同一 parallel 段中的其他读取不得假设其文件副作用已经完成，有依赖的工作必须放到后续 Provider turn。

Workspace 文件发现由一个 backend-only `fast-glob` 枚举器统一：`glob` 直接流式消费匹配文件，JavaScript `grep` fallback 用它筛选 include。枚举器先用 `PathGuard` 固定 directory-relative `cwd`，拒绝绝对、负模式与父目录 traversal，关闭 symlink 跟随，并对每个输出重新验证 real path containment；固定跳过 `node_modules/.git/dist`。调用者读取第 `maxResults + 1` 个匹配判断截断，因此结果上限不再错误地变成扫描上限。`grep` 的正常 backend 是 `@vscode/ripgrep` 分发的原生 ripgrep；项目内 `RipgrepSearcher` 只定位二进制、固定 workspace cwd、构造安全参数、管理取消/子进程并解析有界 `--json` 输出。只有进程级 availability probe 失败时才启用项目内 worker-thread regex fallback；二者的结果条数都用额外一个 match 区分“恰好达到上限”和“确实还有更多”。敏感路径 ingress 不参与文件枚举，独立用 `picomatch` 编译配置 glob；路径分隔符规范化由无匹配语义的公共 helper 提供，旧的手写 glob-to-regexp 实现不再保留。

child Provider catalog 由父 Run 已冻结的可见 catalog 派生。`readonly` 以及只读父 Run 的 `inherit` 只保留无副作用工具；其他 `inherit` 保留父 Run 允许的读取、命令、网络、MCP、文件/Git 写入等工具，并沿用父 Session 的 `auto | confirm | yolo` 权限模式。Goal、Plan、`subagent_run` 和 `swarm_run` 始终排除，防止 child 扩张编排树。实际 executor 继续独立执行注册、schema、权限和路径校验，所以伪造 tool call 不能绕过 catalog。Git 命令使用 `--no-optional-locks`。

### 18.3 Live Workspace/Git view

child Session 直接绑定父 Run 已规范化的 workspace path。其 `permissionMode` 为 `readonly` 或父 Session 的冻结模式；只有计算结果为只读时才设置 `readOnlyWorkspace = true`。递归 Agent 与 Goal/Plan 等被排除的调用仍返回 `TOOL_NOT_AVAILABLE`。

文件与 Git Tool 在真正读取时观察 live workspace；不会复制目录、创建临时 Git repository、bundle、checkpoint 或 refs。serial 写 Tool 与所在前后的 parallel 段不会重叠，但显式 parallel 的 `run_command` 可能修改 workspace，因此与同段 child/read Tool 之间不提供冻结一致性。

升级后 Backend 只清理 runtime data 下旧版遗留的 `subagent-snapshots` 目录，不删除 workspace 中任何 Git refs。非 Git workspace 仍展示四个 Git read Tool，由现有 Git Tool 返回普通 repository 错误。

### 18.4 Child Run、结果与生命周期

child Session 固定 `visibility = 'internal'`，使用委派计算后的权限模式并沿用全局 `limits.maxStepsPerRun`；`0` 仍表示不限步数。Provider 输出沿用冻结模型 profile 的 `maxOutputTokens`，返回父模型时继续经过现有单次 `maxToolResultTokens` 与 Tool byte/token 保护，不增加 Subagent 专属 step/token/result budget。

AppConfig/PublicConfig v13 首次引入 Subagent 配置；当前 AppConfig/PublicConfig v24 中该部分的完整结构为：

```ts
subagents: {
  enabled: boolean // default false
  workerTimeoutMs: number // default 1_800_000, range 1 minute..24 hours
}
```

AppConfig v24 从所有合法 v9–v23 配置迁移并删除 `limits.maxConcurrentRuns` 与 `subagents.maxAgentsPerSwarm`；设置页只保留开关和 timeout。Headless config v3 引入开关与 timeout；v4 迁移 v1–v3 并删除退役的 Run 工具结果预算，外部格式无需迁移并发字段。Runtime Identity v5 的 `swarmsEnabled` 宿主能力位保持不变；当前只生成该 artifact 的 Headless 固定为 `false`，Desktop runtime 支持普通 Swarm Tool。

内部成功结果为 `{ results: { [name]: finalAssistantText }, meta }`；`meta` 只包含耗时、实际 `providerId/model`、标准化 usage 汇总和模型是否因输出上限截断。reasoning、endpoint、凭据、child Session ID、trace 路径和临时绝对路径不能回传。进入父模型历史时 `subagent_run` projector 只保留 `results[name]` 最终文本，输出上限截断时追加短尾注；Provider/model/usage 留在内部 meta 和统计。只有 reasoning 或缺少最终 assistant text 时明确失败；长度上限结束则保留已有文本并标记 `truncated`。

child stream/tool/domain event 通过去除隐藏 Session identity 的 `AgentExecutionEvent` 投影到 Renderer；其中包括运行状态、流式活动、工具活动、usage 和人工审批。审批决策使用 `parentSessionId + executionId + callId` 定位 active child，再进入同一 ApprovalCoordinator。child 不创建独立 trace capture；标准化 usage 以 `scope = 'subagent'` 和父 Session/Run/call 归属进入现有统计。父 Run 取消、worker timeout、Provider failure、应用 dispose 都通过 AbortSignal/Session interrupt 级联中断，并等待 child Provider/Tool 和 hidden Session handle 完整收敛。

### 18.5 Desktop Swarm Job 与模型池调度

`swarm_run` 是满足运行条件的 Desktop 主 Run 的普通 Tool：Subagent 必须已启用，并且模型池至少有一条 enabled route。普通用户消息也能获得该工具；`/swarm <goal>` 仅作为显式请求与目标编排快捷命令，不再授予特殊 capability。child Run、历史重放和 Headless 仍不获得该工具，catalog 与 executor 对伪造调用执行相同检查。Provider 可见 schema 要求有界非空 `sharedContext`，每项 task 包含 `name/task/requiredCapability/agentCount/toolAccess`；`tasks.maxItems`、`agentCount.maximum` 与总数校验使用固定协议上限 32，而不是用户配置。

`/swarm` 的原始斜杠命令作为 visible `user_input` 留在普通对话中；解析器额外生成的 `slash:/swarm` canonical `orchestrator` Prompt 以 `visibility = hidden`、`inHistory = true` 追加。MessageHistoryCompiler 继续把该 Prompt 交给 Provider，Renderer 时间线不投影它。兼容旧数据时不修改 append-only canonical history，而由 Renderer 同样抑制已写为 visible 的 `slash:/swarm` 记录；其他 orchestration 与 interjection 的默认可见性不受影响。Provider-transfer transcript、显式 Conversation 导出与完整 Trace 可以保留内部编排内容。

Tool description 明确要求只有用户已经提出 Swarm、多 Agent、并行调查或独立交叉检查时才能调用，不能仅因任务复杂而自行启动。父 Agent 可行时先运行可共享验证，再把命令、退出码和精简关键输出写入 `sharedContext`；无法验证时明确说明。每项 task 必须显式选择 `readonly | inherit`，可写任务尽量使用互不重叠的文件或子系统所有权。allocator 会优先轮换合格 `Provider + model`，池不足时仍可能复用，Tool 不作绝对异构承诺。

每个新 Public Run 都根据宿主能力、本轮冻结的 Subagents 开关和当前模型池重新计算一次 Swarm capability；普通发送、`run:retry` 与 `run:continue` 使用同一初始化边界。`/swarm` 只在该基础 capability 上补充本轮 goal 和编排上下文。设置不变时，续跑前后的 Provider Tool catalog 必须保持一致；内部 child Run 因冻结 `subagentsEnabled = false`，不得获得 `swarm_run`。

`swarm_run({ sharedContext, tasks })` 是 `executionMode = parallel`、`effects = []`、`defaultRisk = low` 的编排 Tool；顶层 `sharedContext` 保存全部 Child 共用的背景、证据、约束、验证结果和输出要求，每项 task 提供唯一安全名称、Child-specific 任务、`light|standard|strong` 最低能力、replica 数量和 `toolAccess`。两部分合起来自包含。编排调用本身不强制人工审批；每个 `inherit` child 实际提出的副作用工具仍按父 Run 的冻结权限模式分别审批。

Coordinator trim 并校验公共上下文和 task 后，把同一 `sharedContext` 与 task 的 `toolAccess` 复制到每个 prepared child spec，再从一次 PublicConfig 快照确定性分配并冻结全部 route。Subagent execution 将 XML-text 转义后的公共部分作为独立 `selected_context` canonical record 注入，将转义后的 `<swarm_task>` 作为该 Child 的 `user_input`；基础 system harness 把前者定义为背景、后者定义为当前委派任务与冻结权限。公共上下文和 task 不拼成不可分割字符串，Agents 详情从 user record 安全解包原始 task。随后 Backend 在一个 SQLite transaction 中创建 Swarm root 和所有 queued child。assignment 失败、配置 revision 竞态或总量超限都发生在任何 child Provider 请求之前；冻结后配置热变更不重分配，失败 child 也不自动切换 Provider 重试。

Swarm child 使用 backend-private prepared execution 路径。每个 child 根据 `toolAccess` 从父 Run 冻结工具与权限上下文，随后直接并发创建 hidden Session 并启动 worker timeout，不进入全局 FIFO Run slot。同一父 Run 的多个 Swarm Job、不同父 Run 的 Job 和 sibling child 都可以并发；父取消或应用退出会中断所有 active child。

父 Tool Result 使用声明顺序稳定的扁平 `results[]`：每个 replica 独立携带 task/agent 序号、终态、成功文本或有界错误、安全 assignment、耗时、usage 与截断标记；`meta` 聚合 Job 状态、数量、耗时和 usage。部分失败保留全部成功与失败项，全部失败返回 Tool error；不会自动重试或启动第二个聚合 Run。结果总 JSON 有 2 MB 上限，超限时公平收窄成功文本与错误正文但不删除条目。相同 root call 与参数 hash 可幂等读取 active/durable 结果，不同参数明确冲突。

独立 `agent-execution:event` 只投影安全生命周期和可见活动，不把 hidden Session 伪装成普通 Session。Agents artifact 根列表仅显示普通 Subagent 与 Swarm root；展开 Swarm root 后按 `childOrdinal` 显示 child。两级均使用手动 `NCollapse`，不自动展开；详情只显示运行时间、工具调用数、状态、模型/usage/Agent 计数和可见 Assistant 文本，不展示 reasoning、完整工具轨迹、child Session ID、prompt harness、route 凭据或 Provider continuation。

---

## 19. 迁移方案

### 19.1 新数据库启用

切流版本首次启用 v2 persistence 时，创建 `agent.db` 并执行 SQLite schema migrations。旧 `workbench.json`、renderer localStorage 和 `change-history.json` 不参与新数据库初始化或状态恢复；新架构从 SQLite 中已有的 records 开始，没有 records 时显示空 Project/Session 状态。

切流不读取、改写、重命名或删除这些旧文件。`schema_migrations` 只负责 `agent.db` 自身的 schema version，不承担旧 Conversation/Message/FileChange 数据转换。

### 19.2 切换顺序

1. 引入 shared Session/Message/MessagePart schemas 和 SQLite repositories。
2. 引入 Project 和 FileChange repositories。
3. 引入只输出 `CompiledCanonicalHistory` 的 Message history compiler、Provider contract 和完整 tool batch transaction。
4. Runtime 改为从 messages 查询 active history。
5. Renderer 改为 Project/Session/Message/FileChangeSummary replica。
6. 删除 `workbench:save`、frontend conversation persistence、legacy change-history JSON 和 memory-only canonical history。

迁移不长期双写。

---

## 20. 测试与不变量

必须覆盖：

- Project/Session/Message codec round-trip，canonical project path 去重，以及 Project path 重新关联不改写 Session `projectId`。
- `kind + parts` discriminated union round-trip；单条记录的非法组合（例如 assistant 携带 tool-result part）在 shared/repository boundary 被拒绝，跨记录的缺失/重复 call 在 MessageHistoryCompiler 被拒绝。
- MessageHistoryCompiler 只执行 active-history policy 并生成 `CompiledCanonicalHistory`，不生成 wire `role` 或 Provider DTO。
- 相同 active MessageRecords、route 和 Provider config 生成确定性的 Provider DTO；不同 Provider 的 golden tests 覆盖 Chat Completions messages、Responses items 和 Anthropic content blocks。
- Chat Completions 将 assistant tool-call parts 编译为 `tool_calls[]`、将每个 tool-result record 编译为 `role = 'tool'`；Responses 编译为 `function_call/function_call_output` items；Anthropic 把相邻 results 合并为 `user` message 中排在前面的 `tool_result` blocks。
- Tool Result 默认/自定义投影、projector fallback、JSON-safe normalization、UTF-8 head/tail token bound 和错误文本均有 exact tests；Provider golden 断言 wire 不含内部 envelope 或 part 标签。
- `read_file/grep/glob/list_dir`、terminal/process/Git、fetch/search/skill、FileChange、MCP 与 Subagent 的模型可见格式使用 exact golden；实时 `tool.completed` 与 reload 后 durable ToolCallCard 显示相同 canonical content。
- 新结果持久化 projection marker；active legacy result 在 Provider factory/stream 和 usage 前失败，inactive old epoch 不阻断新 history。
- Provider 可以将一条 canonical record 展开为多个 wire items，或把多条相邻 canonical records 合并为一条 wire message；不依赖一对一映射。
- `normalizedReasoningText` 只包含允许展示的非加密文本；缺失投影时 UI 不显示 reasoning，且不能从它重建 continuation。
- `ProviderContinuationEnvelope` 外层 schema 校验、`data` 原样 round-trip、数组顺序不变；签名、密文和 opaque item 不被 Core 改写。
- Provider type、route 或 format 不兼容时忽略 continuation 并重放 canonical history；损坏状态不得由 normalized reasoning 伪造。
- 删除或改变 metadata 不改变相同 route/adapter 下编译出的 Provider request；协议关键字段藏入 metadata 的 fixture 必须被拒绝。
- SQLite migration 顺序、checksum 不可变、单步 rollback、高版本拒绝、foreign key cascade 和 seq uniqueness。
- 移除 Project 会 cascade 删除其 Sessions/Messages/FileChanges，但不删除 workspace 目录或任何项目文件。
- Application service 的 Session/Message 多表事务回滚时，Repository 不得留下独立 commit。
- Durable mutation 的 invoke result 与 push event 携带同一个 envelope；event-first、response-first 和重复 delivery 都只更新一次 renderer replica。
- Bootstrap 在订阅后读取 snapshot/cursor；握手期间发生 commit 不丢失，cursor gap、backend instance change 或 buffer overflow 会重同步而不是轮询。
- User send 和 `run:retry` 不重复插入原始 user message；Assistant target 被拒绝。
- Assistant text、`normalizedReasoningText` 和 `providerContinuation` 只有 completed 后才落盘。
- 每个持久化 assistant tool-call message 后都有完整 tool result messages。
- Tool batch transaction 失败时不留下协议半截。
- parallel Tool body 确实重叠，serial Tool 形成前后屏障；审批和 Tool Result 始终按原 call 顺序，失败/拒绝/取消仍为每个 call 生成终态结果。
- `subagent_run` 的 Unicode/保留键/控制字符/长度 schema，普通 `user_input` history、无父历史、冻结 route 继承、配置热变更和最终 assistant text 提取。
- child Provider catalog 与 executor 双重拒绝 write/process/terminal/network/MCP/code intelligence/递归 Agent Tool；四个 Git read Tool 在非 Git workspace 返回普通错误。
- live workspace 覆盖 dirty/staged/untracked Git、child 启动后的文件变化、旧 snapshot 目录清理以及不创建新 Git refs。
- hidden Session 不进入公开 get/bootstrap/list/search/export 或 Renderer events；父/Project 删除级联、归档保留、启动 interrupted、幂等 completed result 与参数冲突均有持久化回归。
- 父取消、30 分钟默认/自定义 timeout、应用 dispose、Provider failure、全局并发 1 和 slot 耗尽都不遗留 active child handle。
- fake-provider E2E 验证 child 从实时文件和 Git diff 调查、伪造写调用被拒、结果作为标准 tool role 返回、父 Agent 继续总结，并把 usage 归属到父 Run 的 `subagent` scope。
- Compact 只在完整 turn boundary 修改 `inHistory`，active history 可直接按 seq 重建。
- Rewind/edit 跨 compact 或 Provider-transition transcript epoch 重建保留前缀；重复 rewind 被拒绝；rewind 后 fork 只复制非 superseded 当前分支并重映射引用与 epoch boundary。
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

验证采用两级门禁：日常 `npm run check` 并行执行 Vitest、lint、format check 和 typecheck，等待全部任务结束后按组汇总失败；合并与发布前的 `npm run verify` 在此基础上增加分进程 native/ripgrep/development SQLite smoke、Desktop/Headless build、Windows package、packaged SQLite 和复用构建产物的 E2E。CI 将完整门禁拆到独立 Windows runner 并行诊断，Playwright 单个任务内部仍使用单 worker 保证 Electron 状态隔离。真实 Provider 测试仍是显式 opt-in，不进入任一默认门禁。

---

## 21. 当前迁移状态

P0–P13 已完成。Desktop、Headless、IPC、preload 和 renderer 默认路径均使用唯一 `createBackendRuntime` 与 SQLite Durable Backend。Desktop 数据库为 `userData/agent.db`；数据库打开或 migration 失败时显示阻塞恢复对话框，不回退 Workbench。Headless 使用任务独立临时数据库并在退出时关闭、删除。

P11 Provider Runtime Foundation 与 P12 Generic Responses/Anthropic 已完成。Main 与 auto approver 使用扁平 `ModelProvider.compile/stream`，compact 使用同一实现上的 `compileCompact/compact`；生产实现为互不继承的 `deepseek.chat-completions`、`mimo.chat-completions`、`generic.chat-completions`、`generic.responses` 与 `generic.anthropic`。MiMo 专用实现发送官方 `max_completion_tokens + thinking.enabled/disabled` 字段，并通过 MiMo continuation 完整回传带工具调用轮次的 `reasoning_content`；其所有非关闭 reasoning 档位按供应商能力统一为启用思考。配置、route、continuation 和 compact envelope 统一使用 `providerType`；Google 和其他具体厂商实现继续按实际使用需求独立增加。

P13 Subagent Runtime 的 S1–S4 已完成。默认关闭的 `subagent_run({ name, task, toolAccess })` 复用唯一 Session/Run/Provider loop，以隐藏 Session 直接读取父 Run 的 live workspace；task 是不含父历史的普通 user input。`readonly` 使用无副作用 catalog，`inherit` 使用不高于父 Run 的冻结工具和权限模式；通用 Tool scheduler 允许同批多个 Subagent 与其他 parallel Tool 并发执行，并按原 call 顺序提交结果。S3 Model Pool 已完成配置、Agents 设置、allocator/freezer 与 prepared execution 接入。S4 Desktop Swarm 通过低风险 parallel `swarm_run`、SQLite root/child execution、并发 child 和两级 Agents artifact 完成有界批量委派；`/swarm` 只保留为显式编排快捷命令，Headless Runtime Identity 明确声明不支持 Swarm。不同 Session 和同 workspace 写入不再受产品级并发准入、警告或 writer lock；同一 Session 仍只允许一个 Active Run。递归委派、自定义 child 工具 ID 列表、取消 UI 和完整 child transcript 仍未实现。ProjectModel/Serena/code intelligence 已从生产装配、工具、IPC 可用路径和 Renderer 入口关闭；其 SQLite 迁移及重新启用排在总路线图的 Swarm hardening 之后。

Tool Result projection 已统一进入生产主链：完整内部 `ToolResult` 只供安全、trace 和插件使用，模型历史与 `tool.completed` 使用 `model-content.v1` canonical parts。文本密集型内置工具输出紧凑正文，结构化工具保留 JSON value；Chat Completions、Responses 与 Anthropic 共用无 part 外壳的 renderer。旧 active Tool Result 不迁移并明确拒绝续聊。

Renderer 只维护 Project/Session replicas、分页 Message/FileChange cache、每 Session runtime overlay 和 UI-only draft/selection。首次发送前不创建空 Session；所有 durable command response 与 `domain-state:event` 经同一 reconciler 处理 cursor/revision、重复 delivery、缺口和 backend instance 变化。

后台异步故障经版本化 `app:notification` 交付；preload 在 renderer 挂载前做 64 条有界缓存。Renderer 以 `NMessage` 展示瞬时操作反馈：warning 10 秒、error 手动关闭、最多 5 条并排队，且按 code/Session/message 去重。通知不进入 durable replica 或 Timeline；日志 capture 的持续状态留在 Header/设置。

`MessageRecord` 使用 `visibility + inHistory + turnId` 分离展示、模型历史和轮次归属。Compact 只更新 `inHistory`；rewind 将移除分支标为 `superseded`，清除 Goal/Plan 并重建 active history。只有可见原始用户消息能 retry/edit；Assistant 不能作为 `run:retry` 目标。

SQLite transaction callback 通过 authorizer 拒绝事务控制 SQL；commit listener 逐项隔离；backend dispose 使用共享 promise 排空 live runtime/coordinator 后关闭数据库。FileChange retention 由 migration 维护单行总量和 trigger，不再每次插入全表 `SUM`。Legacy Workbench、Conversation durable records、renderer snapshot persistence、JSON ChangeHistory、旧 IPC 和 identity bridge 已删除。旧 `workbench.json`、`change-history.json` 与 localStorage 数据不迁移、不读取、不删除、不改写。普通 Session 已支持受警告保护的 `zch-conversation-markdown` 单向导出；Markdown 导入仍未实现，Trace transcript 查看/导出保持独立。

AppConfig v14 会把合法 v9 Provider 配置迁移为 `providerType`，把合法 v9/v10 配置中仍等于旧默认值的单次工具 token 与工具/read 字节限制提升到 64K/128KiB，为合法 v9/v10/v11 Provider 补充默认包含主模型的 `modelConfigurationIds`，为合法 v12 增加默认关闭、30 分钟 timeout 的 Subagent 配置，并从所有合法 v9–v13 配置删除退役的 `maxToolTokensPerRun`。AppConfig v15 再把合法 v14 `modelConfigurationIds` 原样迁移为 `enabledModelIds`，并让新安装的默认 Provider 从空模型池开始；已有主模型、API-key reference、模型目录、模型覆盖、revision、其余自定义限制和 `maxConcurrentRuns` 保持不变。

AppConfig v16 是 model-pool foundation 的冻结边界：Provider reasoning 与 pool entry reasoning 仅允许当时的 `off|high|max`，per-model annotation 尚不存在。AppConfig v17 集成六档 reasoning、annotation 和 approval route 的必填 `reasoning`，仍在每个 pool entry 保存 capability。AppConfig v18 删除重复 capability，调度时只读取 Provider `modelOverrides[model].capability`；AppConfig v19 再删除从未执行的 pool entry `maxParallel`，并在 `subagents` 增加默认 10、范围 1–32 的 `maxAgentsPerSwarm`。AppConfig v20 新增默认 `auto` 的 `executionEnvironment.commandShell`；合法 v9–v19 配置都保留各自可迁移字段并补入该默认值。AppConfig v21 把模型角色统合进 `models` 段：`activeProviderId` 与其 Provider 默认模型成为 `defaultModelProvider/defaultModel`，旧 `approval` 段成为 `auxiliaryModelProvider/auxiliaryModel`，`providers` 与 `modelPool` 平移入 `models`。AppConfig v22 再增加 `defaultModelReasoning/auxiliaryModelReasoning`，并从每个 Provider 删除 `reasoning`：v21→v22 分别把主/辅助角色所引用 Provider 的旧默认档位写入对应角色，从而保持实际请求等级；v9–v20 直接迁移采用相同结果。v9–v20 的旧独立 approval reasoning 已在 v21 决策中丢弃，直接升级到 v22 仍按当时所选 Provider 档位保持 v21 行为。不可用辅助 route 在 reload 修复阶段改写为当前主 route；Provider 不再持有可被角色隐式继承的 reasoning。当时的 Headless 临时内部 AppConfig 使用 v22 结构，外部配置仍为 v4 单 Provider，并把其可选 reasoning 映射到主角色。合法 v9–v15 仍迁移到默认空 pool；合法 v16/v17 保留并规范化 pool route、剥离旧 capability 与 `maxParallel` 后迁移；合法 v18 剥离 `maxParallel` 后迁移，合法 v19/v20/v21 原样保留现有 pool 与 Swarm 上限。旧配置中仍 enabled 但对应 Provider 模型没有 capability annotation 的 entry 会在 ConfigStore reload 修复阶段被禁用；disabled entry 原样保留供后续修复。v16–v18 pool entry ID 在 trim/NFC 后必须唯一且拒绝控制/格式字符；不符合各自冻结 schema、损坏或更早版本仍执行 reset-only。Runtime Identity v5 记录 `swarmsEnabled = false`，并从 Headless tool 名称/hash 排除 `swarm_run`。SQLite v5 增加 hidden Subagent execution/session ownership，并保留 v4 对历史 route/continuation identity 的原位迁移。SQLite v6 通过表重建把 `sessions.reasoning` 的 CHECK 扩展为六档（`off|low|medium|high|xhigh|max`）；SQLite v7 再重建 `messages`，加入 `conversation_transcript` 与带 `model_route_json` 的 Provider-native `compact_summary`。SQLite v8 重建 `subagent_executions` 为 schema v2，增加 `kind/name/parent_execution_id/child_ordinal`、queued/partial 状态及 root/child 唯一索引，并把旧记录迁为根级 `subagent`。表重建由 runner 暂停外键约束、换表并重建索引，提交前以 `PRAGMA foreign_key_check` 兜底完整性；旧版本应用打开更新数据库会以 `DATABASE_VERSION_TOO_NEW` 明确拒绝。旧 JSONL trace 只在读取时投影而不改写文件。

AppConfig v23 把 v22 的三字段 `logging` 冻结为 legacy boundary，并迁移为 `logging.operational + logging.trace`。旧 `enabled/retentionDays/maxTotalBytes` 完整进入 Trace；Operational 使用 `info/14 天/50 MB` 新默认。AppConfig v24 删除 `limits.maxConcurrentRuns` 和 `subagents.maxAgentsPerSwarm`；v9–v23 各自使用冻结 legacy schema 校验并保留其他配置后迁移。Headless 外部 config 版本不变，构造的内部 AppConfig 使用 v24。

P3 review 建议、N-3/N-4 和 201+ 数据量的额外 Electron E2E 明确延后，不属于 P10 发布门禁；现有单元/集成测试继续覆盖 201+ Session、Message 和 FileChange 分页。产品路径不再保留双轨、兼容开关或 legacy fallback。
