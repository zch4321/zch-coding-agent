# 领域状态、持久化与 IPC

本文保留状态语义、事务和同步约束。字段以 [shared 契约](../../shared/domain-state-api.ts)、[Message schema](../../shared/message.ts) 和 [SQLite migrations](../../electron/persistence/migrations/index.ts) 为准，不在文档复制类型和建表 SQL。代码入口见[状态与 IPC 地图](../code-map/state-and-ipc.md)。

返回[架构总览](../architecture.md) · [文档入口](../README.md)。

## 领域术语

### Project

Project 对应一个 canonical workspace。数据库使用稳定 `projectId`，路径是可变属性，不作为跨表主键。

### Session

Session 是持久化对话，也是 UI 中“对话”的唯一领域实体。不再存在独立 Conversation record 或 `conversationId -> sessionId` 映射。

Session 保存：

- project、title、lifecycle。
- 当前 provider/model/reasoning selection。
- 当前 permission mode。
- 当前 Goal/Plan。
- fork metadata。
- `revision` 和 `lastSeq`。

每个公开 Session 还在 OS temp 下映射一个按应用 profile hash 与 Session hash 确定的私有目录；它不属于 `SessionRecord`，hidden child 通过 owner Session 共享该目录。

### Message

Message 是 SQLite 中唯一的对话历史单位。它既能投影为 UI timeline，也能重建 provider-independent canonical history。

Message 必须完整后才写入数据库：

- 用户点击发送时，user message 已完整。
- Provider 一个 assistant turn 完成后，assistant message 才完整。
- 一个 tool call 得到 terminal result 后，tool message 才完整。
- Harness/context layer 构造完毕后才写入。

数据库中不存在 partial message。

### Run

Run 是一次活动执行，不是持久化领域实体。Backend 为它分配临时 `runId`，用于：

- IPC stream routing。
- 中断、interjection 和 approval。
- 关联当前 provider/tool loop。
- trace correlation。

Run 完成或应用退出后，`ActiveRunExecution` 销毁。完成的结果已经体现在 messages；失败、取消和详细执行轨迹由可选 trace 记录。

`runId` 只出现在 runtime IPC events 和可选 trace，不写入 Messages。完成后的持久化关系已由 Message `seq`、tool `callId` 和 user `clientRequestId` 表达；不保留没有持久化消费者的 `turnId`。

## Canonical 数据结构

V1 record `schemaVersion` 固定为 1。Project 和 Session `revision` 从 1 开始；空 Session 的 `lastSeq = 0`，首条 Message 的 `seq = 1`。所有计数使用不超过 JavaScript safe integer 的非负或正整数。Message page 最大 200 条并按 `seq` 升序返回；Session summary page 最大 200 条，按 `(updatedAt, id)` 降序并使用同一复合 cursor；Project list 最大 512 条；单次 Session commit 最多携带 512 条 Message records。

TypeBox schema 负责单 record 的闭集字段、枚举、长度和 `kind + parts` 组合；`assertBoundedJsonValue`、route/page semantic validators 负责 JSON 深度/总字节、secret-safe endpoint、本地 call ID 唯一性和升序 page 等不能可靠表达为可组合 JSON Schema 的约束。跨 records 的 tool call/result 配对不属于 单 record schema，由 `MessageHistoryCompiler` 校验。

### ProjectRecord

`path` 是 Backend 在添加项目时通过平台路径规则和 `realpath` 规范化的绝对 workspace 路径；数据库以它去重，但 Session 只保存稳定 `projectId`。目录移动或用户显式重新关联后可以更新 `path`，不能通过路径级联重写 Session。

`name` 默认取目录名。ProjectModel、module 持久化和 Serena/code intelligence 当前整体关闭：生产 runtime 不装配 ProjectMetadataStore/CodeBackendManager，不读取、创建或改写 workspace 内的 `.zch/project-model.json`。普通 prompt harness 只在内存中做有界、只读的 module marker 探测。总路线图中的 Swarm hardening 完成后再把 ProjectModel 迁入 SQLite；旧 `.zch` 届时只作为一次性显式导入源，不能继续作为运行时真相源。

### SessionRecord

`modelSelection` 是下一次执行使用的当前选择。Backend 在 Run 开始时将它解析为不可变 `ModelRouteSnapshot`；除 provider/model/reasoning 和端点/配置 revision 外，snapshot 必须包含实际 `providerType`，以选择一个具体、扁平的 Provider 实现。`providerId` 是用户保存的配置实例，`providerType` 是代码实现类型；同一供应商的不同 API surface 使用不同 type。已完成 assistant message 记录该实际 route。

Snapshot 保存解析完成后的非凭据 route，而不是指向可变全局 Provider 配置的引用。`purpose` 表示 `main/approval/title/compression` 等模型用途，不是 wire role；API key、Authorization header 和 transport client 不进入 shared record。一次 Run 启动后，即使用户修改 Provider 配置，该 Run 仍使用已冻结的 provider type、endpoint、model 和 reasoning；新配置只影响后续 Run。

`endpoint` 必须是 HTTP(S) 绝对 URL，并拒绝 URL userinfo、fragment 和凭据型 query key。它是可进入 SQLite、renderer 和 trace 的非 secret route 信息，不能用来携带 API key、token、signature 或 Authorization 数据。

### MessageRecord

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

### History Compiler 与 ModelProvider

Canonical history 编译和具体协议边界见 [Provider 规范](./providers-and-context.md#history-compiler-与-modelprovider)。状态层不持久化 Provider DTO。

### Git Review 查询结果

`shared/git-review.ts` 定义 Project 级的临时只读结果。状态包含是否为 repository、canonical workspace、Git top-level、可用时的 HEAD ref/OID、upstream、detached/unborn 标志、至多 500 个本地/远端 base refs，以及至多 10,000 个 porcelain status entries。每个 entry 保存 Git 的 index/worktree status、当前路径、可选原路径和归一化变更类型。

Diff 查询只支持四种明确基准：

- `head`：当前 working tree（含 index）相对 `HEAD`。
- `unstaged`：working tree 相对 index。
- `staged`：index 相对 `HEAD`。
- `merge_base`：先解析所选 ref 与 `HEAD` 的 merge-base OID，再将当前 working tree 与该 OID 比较。

结果返回实际使用的 mode/path/base ref/base OID、Git 输出正文、观察到的 UTF-8 bytes、截断位和 binary 标记。命令固定关闭 pager、颜色、external diff 与 textconv，不请求 `--binary`，有 15 秒 timeout 和 900,000 bytes 输出上限。未跟踪文件只出现在 status；加入 index 前没有 Git Diff。无 Git、unborn HEAD、无 merge base、非法 ref/path 或历史不足时返回明确状态或错误，不生成应用自有 fallback。

这些对象不带 Session、Run、Agent、call ID 或 revision，不进入 durable commit/event reconciler，也不写 SQLite。Renderer 只在打开面板、Project/文件变化或用户手动刷新时重新查询；查询结果随时可以过期。

### SessionSnapshot

`SessionSnapshot` 只包含数据库可无损恢复的 canonical data。`SessionOpenResult.runtime` 是独立的 backend-memory snapshot，仅用于 renderer reload 后恢复当前活动展示；它不是 Session data。

历史使用 exclusive `beforeSeq` 按 `seq` 降序查询，再在 response 中恢复为升序 records。`hasMore = true` 时 `nextBeforeSeq` 等于当前页第一条 record 的 seq。Renderer 持有的是 canonical records 的部分副本，不是另一套结构。

## SQLite 表设计

### 文件与连接

Desktop database：

```text
userData/agent.db
```

主进程使用一个 connection 和串行 write queue：

业务模块不能各自创建 connection 或绕过 transaction service。

### 核心表

目标持久化模型刻意保持小：

| 表                    | 用途                                                      |
| --------------------- | --------------------------------------------------------- |
| `schema_migrations`   | 数据库 schema 迁移                                        |
| `projects`            | Project/workspace 元数据                                  |
| `sessions`            | Session 元数据和当前 Goal/Plan                            |
| `messages`            | 完整、排序、可编译 Provider request 的 canonical history  |
| `subagent_executions` | Backend-private Agent/Swarm root-child 执行状态与安全结果 |
| `subagent_sessions`   | 隐藏 child Session 与 execution/parent 的归属关系         |

### `schema_migrations`

这是 SQLite infrastructure state，不是产品领域记录，不进入 shared schema、IPC 或 renderer。`version` 定义顺序，`name` 提供可读识别，`checksum_sha256` 检测已应用文件被修改，`app_version/applied_at` 用于诊断数据库由哪一版应用在何时升级。

Migration 规则：

1. `DatabaseService` 打开 connection、设置 PRAGMA，并 bootstrap 这张表。
2. Migration 文件以递增版本命名，例如 `0001_initial.sql`。
3. 每个 pending migration 使用 `BEGIN IMMEDIATE`，schema/data change 与对应 migration row 在同一 transaction commit。
4. 已应用 migration 不得修改；启动时发现相同 version 的 checksum 不一致必须失败，不得静默覆盖。
5. 数据库版本高于当前应用支持版本时拒绝启动该 repository，并返回明确升级/降级错误。
6. Desktop runtime 只执行 forward migration，不自动执行 destructive down migration。

### `projects`

Backend 在 insert/update 前规范化并校验 `path`。`UNIQUE(path)` 防止同一个 canonical workspace 被重复添加；`id` 才是其他表使用的稳定 identity。

`project:remove` 表示删除应用中的 Project、Sessions、Messages 和 Subagent/Swarm execution，不删除 workspace 目录或其中任何文件。Application service 必须先确认该 Project 没有 active Run/approval/runtime resource，再在单一 transaction 删除 Project；外键 cascade 清理其应用记录。

### `sessions`

`goal_json` 和 `plan_json` 使用 shared schema 校验。当前产品只按 Session 读取，不需要为 Plan item 建立跨 Session 查询，因此不拆表。

### `messages`

`parts_json` 是 `MessagePart[]` 的唯一持久化表示；Repository codec 必须在读写边界按 `kind` 验证允许的 part 组合，SQL 中的 JSON CHECK 只是最低结构保护。V1 不建 `message_parts` 表，也不保存派生的 wire `role/content/tool_calls/tool_call_id`。

本地对话搜索只读取 `kind = 'user_input'/'assistant_turn'` records 中 `type = 'text'` 的 parts；不索引 tool-call 参数、tool-result/JSON payload、reasoning、continuation 或 metadata。V1 可在 Repository 中解码后查询；数据量需要 FTS 时，FTS 只能是可从这些 text parts 重建的派生索引，不能成为新的真相源。

`provider_continuation_json` 保存完整 `ProviderContinuationEnvelope` JSON；`data` 保留 Provider 提供的原始 JSON 结构和数组顺序。若供应商状态需要逐字节保持，Provider 必须把原始字节编码成 envelope `data` 中带明确 format 的 base64/string，通用 codec 不得解析后重组。Repository 只验证 envelope 外层，对应 Provider 再按 `providerType/format` 验证 `data`。

`normalized_reasoning_text` 只保存可读明文投影，不保存签名、密文、redacted block、response cursor 或 provider item id。`metadata_json` 保存按 Message `kind` 校验的 `MessageMetadataV1` JSON；未知键默认拒绝，不能用它绕过 `provider_continuation_json` 的 Provider ownership。

所有 JSON 列在 application boundary 按 shared schema 校验，并使用 `CHECK(json_valid(...))` 或等价 codec 约束。Nullable JSON 需要允许 SQL `NULL`。`provider_continuation_json` 通常只在 `kind = 'assistant_turn'` 时非空；它不得包含凭据、Authorization header、完整 wire request、usage 或 timing。

`UNIQUE(session_id, client_request_id)` 只对 `kind = 'user_input'` message 的非空 request id 生效，用于阻止一次发送被重复插入；其他 message 的该字段为 `NULL`。

### FileChange 删除迁移

标准 SQLite v11 删除遗留的 `file_changes`、`file_change_retention_state` 及其 retention triggers；SQLite v12 对已执行历史 v11 分叉的数据库重复同一幂等清理，并解除该分叉遗留的 Subagent public-id insert trigger。旧 migration 文件保持不可变；runner 只按精确名称与 checksum 接受已知 alternative，未知 migration 继续 fail closed。无论从旧数据库升级还是新建数据库执行全部 migration，最终 schema 都不包含 FileChange、Diff、patch、before/after snapshot 或恢复状态。

文件工具只提交正常的 assistant tool-call/tool-result Message。`apply_patch` 参数因此可能作为对话历史的一部分出现在 `messages.parts_json`，但数据库没有另一份用于恢复或 Diff 展示的 patch 副本。当前 Git status/Diff 由只读 Git Review 即时查询，不进入 SQLite。

### Message seq 与 transaction

Application service 通过 `DatabaseService.withTransaction()`：

1. 读取并递增 `sessions.last_seq`。
2. 插入一条或一组完整 messages。
3. 递增 `sessions.revision` 和 `updated_at`。
4. Commit。
5. 发布已提交 records。

`SessionRepository` 和 `MessageRepository` 接受同一个 transaction handle，不能在各自方法里提前 commit。多条 tool messages 必须在同一 transaction 获得连续 seq。

### Hidden Agent execution

SQLite v5 增加 `subagent_executions` 与 `subagent_sessions`；SQLite v8 把 execution 升级为支持 Swarm root/child 的 schema v2，SQLite v10 增加按 `parent_session_id + active leaf status` 的容量查询索引。它们是 backend-private durable execution state，不加入 shared `SessionRecord` 或普通 Session replica：

- root execution 以 `(parent_session_id, parent_run_id, parent_call_id)` 唯一标识一次普通 Subagent 或 Swarm Job，保存 `kind/name`、参数 hash、`queued/preparing/running/terminal` 状态、安全 route snapshot、标准化 usage、有界结果/错误和时间戳。Swarm child 通过 `(parent_execution_id, child_ordinal)` 唯一归属 root；Job root 与全部 queued child 在同一 transaction 创建并原子预留 active leaf 容量，避免半个 Job或超额并发。
- execution 不重复保存 task 明文，也不保存 API key、endpoint、reasoning、trace 路径或 workspace 绝对路径；旧版 nullable `source_identity_json` 列只为数据库兼容保留，新执行不再写入。普通公开查询只分页返回 root，详情查询在校验父 Session 归属后附带有序 child 摘要。
- `subagent_sessions` 在 child 首条 canonical message commit 时原子记录 hidden Session 与 execution/parent 的归属。公开 Session get/bootstrap/list/search/export 必须排除这些 Session；backend 内部恢复使用显式 private query，不能靠调用方记得过滤。
- 相同 parent Session/Run/call 与参数 hash 始终复用同一 execution handle，包括并发 start 与终态 retry；相同调用标识但参数 hash 不同返回冲突，避免无意重复产生 Provider 费用。
- 应用启动时把遗留 `queued/preparing/running` execution 标记为 `interrupted`；Swarm root 使用有界的 Job interrupted 错误，不恢复 Provider stream，也不自动重试。
- 删除父 Session 或 Project 时由 foreign key/trigger 级联删除 child Session、execution 和 canonical messages；归档父 Session 时继续保留。

App 启动 Subagent/Swarm 前先提交 execution identity，再创建 artifact 并返回 handle。artifact 捕获失败只设置 `artifactAvailable = false/captureError`，不得回滚已经成功的 durable reservation，也不得把可修改文件当作 lifecycle 状态。旧完成 execution 没有 artifact 时按 unavailable 投影，不做数据库重写。

子 Session 自身仍使用普通 `sessions/messages` schema，从而复用唯一 Message history compiler、Session/Run loop 和 Provider runtime；hidden ownership 是正交关系，不挪用普通 fork 字段。

## Command、Query 与状态推送

### Typed API

目标 IPC 至少包括：

```text
app:get-bootstrap
project:list / project:add / project:update / project:remove
session:list / session:get / session:update / session:archive / session:restore / session:delete / session:fork
message:list / message:search
git-review:get-status / git-review:get-diff
run:start / run:retry / run:continue / run:interrupt / run:interject
approval:decide
```

主进程推送分为 durable record changes 与 runtime stream，至少包括：

- `project:changed`：已经 commit 的完整 ProjectRecord list snapshot。
- `session:changed`：已经 commit 的 Session/Message records 和 revision。
- `session:removed`：已经永久删除的归档 Session 标识及其 Project 归属；renderer 必须清除相关 page/runtime cache。
- `run:stream`：active run status、text/reasoning delta、tool/approval、terminal 等瞬时事件。

Git Review 是显式 query，没有 durable push topic。Renderer 在进入面板、内置工具完成、Project 切换或用户手动刷新时重新查询；Terminal、外部程序或用户直接修改文件后，旧查询结果可以暂时过期。

### Commit 回包与 Commit Event

Renderer 发起的 command 不能只等待 push event，也不能只依赖 invoke 回包。两条路径解决不同问题：

- invoke 回包让发起操作的组件明确知道 command 成功、冲突或失败，并立即结束 pending 状态。
- durable push event 覆盖 backend 自主发生的提交，例如 assistant turn 完成、tool batch 完成、compact、Goal/Plan tool 更新，以及后台 Session 的变更。

所有 durable mutation 在 transaction commit 后只构造一次提交结果：

`backendInstanceId` 在 main process 每次启动时重新生成，`sequence` 是该实例内所有 durable commit 共用的严格单调序号。它们只是 IPC 传输顺序游标，不写 SQLite，也不是领域 revision、change log 或可恢复的事件历史。

对应 change payload 为：

Project 集合有明确上限，因此提交完整 list snapshot。Session event 总是携带完整 `SessionRecord`；纯标题、模型或权限等 metadata 更新使用 `mode = 'none'`，常规消息提交使用非空 `upsert` records。Compact 等操作如果影响的旧 Message 太多、会超过 IPC 上限，则使用 `mode = 'invalidate'`，renderer 丢弃该 Session 的已缓存 message pages，并通过 `session:get/message:list` 重取；不能发送无界事件。

Application service 的固定顺序是：

1. 在串行 write queue 中校验 `expectedRevision` 等前置条件。
2. 执行 transaction 并 commit。
3. 为已提交结果分配 event cursor，构造 immutable envelope。
4. 将同一个 envelope 交给 event publisher 和 IPC handler。
5. Event 与 invoke response 谁先到 renderer 都是合法行为。

Commit、cursor 分配和 envelope 发布必须在同一个串行 application-state job 释放前完成；bootstrap snapshot 读取也进入这条队列，不能在“数据库已 commit、cursor 尚未分配”的中间状态取快照。Commit 失败时不分配 envelope、不发送 durable event。`run:start` 等同时产生 runtime 结果的 command 在 `DurableCommandResult` 之外返回 `ActiveRunPublicSnapshot/runId`；其中 durable 部分仍必须是相同的 commit envelope。

### Renderer Reconciliation

Renderer 不为 durable state 做 optimistic write。点击创建、重命名、切换模型或发送消息后，只设置 UI-only `pending`；收到 command error 时清除 pending 并保留 backend record，收到 commit 回包或事件时才更新副本。

Command 回包和 push event 进入同一个 durable-event reconciler：

1. `backendInstanceId` 不同：当前副本属于旧 backend，重新 bootstrap。
2. `sequence <= lastAppliedSequence`：同一提交已由另一条路径处理，幂等忽略。
3. `sequence = lastAppliedSequence + 1`：按 topic 应用 change，并推进 cursor。
4. `sequence > lastAppliedSequence + 1`：存在提交缺口，不猜测缺失内容；重新 bootstrap，清空已加载 Session message pages，再按当前页面需要查询。

Invoke promise 的成功/失败仍负责结束该组件的 pending 状态；如果同一 envelope 已由 event 先应用，回包在 reconciler 中被忽略只表示“不重复写副本”，不表示 command 失败。

应用 `session.changed` 时还要检查 Session 自身的持久化 revision：

- 本地不存在该 Session：安装 record；按 `messageChange` 安装 records 或标记 message cache invalid。
- incoming revision 小于或等于本地 revision：不重复应用 records。
- incoming revision 等于本地 revision + 1：应用完整 SessionRecord 和 message change。
- incoming revision 大于本地 revision + 1：该 Session 存在领域变更缺口，调用 `session:get` 替换 Session，并重建其 message cache。

每个 Session transaction 只把 `sessions.revision` 递增一次，即使它插入了一组连续 Messages。Message 仍用 `(sessionId, seq)` 幂等 upsert。查询得到的 snapshot 可以直接替换副本；事件 delta 不能跨 revision 缺口强行合并。

### Bootstrap 无窗口丢事件

Renderer 启动不能采用“先 query、后 subscribe”，否则两步之间的 commit 会永久漏掉。固定握手为：

1. Preload bridge 先订阅 durable events，并在 renderer 完成 hydrate 前暂存有界 buffer。
2. Renderer 调用 `app:get-bootstrap`。
3. Backend 在与 write queue 一致的边界读取 snapshot，并一并返回当时的 `BackendEventCursor`。
4. Renderer 安装 snapshot。
5. 只重放同一 `backendInstanceId` 且 `sequence` 大于 snapshot cursor 的 buffered events。
6. 确认序号连续后切换为 live apply；实例变化、buffer 溢出或序号缺口都重新 bootstrap。

这套 buffer 只跨越一次 bootstrap 窗口，不是 durable queue。窗口 reload 后重新执行同一握手。

### Query 时机与禁止轮询

Renderer 不定时轮询 Project、Session、Message 或 Goal/Plan。Durable query 只用于：

- 应用 bootstrap 和 renderer reload。
- 切换 Session、消息分页和搜索。
- revision/event cursor 缺口后的重同步。

Git Review 是允许过期的 workspace read model，只在界面需要或用户显式刷新时查询，不进入 durable reconciler。

Backend 自主产生的 durable state 一律通过 commit event 通知；invoke response 只确认当前 command，不能代替对其他 Session 和后台执行的订阅。

`run:stream` 不进入 durable reconciler。它按 `sessionId/runId` 更新 runtime overlay，允许包含独立的瞬时 sequence；缺口只触发一次 `session:get` 获取可用的 `ActiveRunPublicSnapshot`，不能轮询补 token。收到对应 Session 的完整 assistant/tool Message commit 后，renderer 清除已经被持久化事实取代的 overlay。Backend 不再持有 buffer 时，部分流式文本允许丢失。

### 无 durable change log

Durable-state changed events 由 commit 后的 backend event publisher 发送，不写 `session_change_log` 或通用 durable outbox。

Project 变更直接推送有界完整 list snapshot。Git Review 没有 change log、page cache 或恢复协议；renderer reload 或 main-process restart 后按需重新查询当前 repository。

Desktop 单窗口场景中，主进程崩溃会同时终止 renderer；重启后本来就会 bootstrap，因此不需要 durable outbox/change log。

### Command 幂等

幂等使用业务键：

- User send：`UNIQUE(session_id, client_request_id)`。
- Local control command：同样先写原始 `user_input` 并使用 `UNIQUE(session_id, client_request_id)`；执行失败保留记录，同 ID 不重放副作用。
- Message：稳定 message id 和 seq unique constraint。
- Approval：active runtime 中一个 approval id 只接受一次 terminal decision。
- Session metadata update：backend 串行 command 和 revisioned response。

不持久化任意 `result_json`，也不维护需要清理的通用 command inbox。

## Renderer 架构

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

## 配置、Secrets 与其他存储

| 数据                                    | 存储                                     | 所有者            |
| --------------------------------------- | ---------------------------------------- | ----------------- |
| Projects、Sessions、Messages、Goal/Plan | `userData/agent.db`                      | backend           |
| 非敏感应用/provider 配置                | backend config repository                | backend           |
| API keys                                | Electron safeStorage-backed secret store | backend           |
| Trace                                   | `userData/traces/*.jsonl`                | backend           |
| Operational runtime logs                | `userData/logs/runtime/*.jsonl`          | backend           |
| Session artifacts/scratch               | OS temp/profile hash/Session hash        | backend + tools   |
| Skills                                  | `userData/skills/`                       | backend manager   |
| ProjectModel                            | 暂停持久化；目标为 `userData/agent.db`   | backend（迁移后） |
| Prompt resources                        | versioned application resources          | backend registry  |

Renderer 只能读取 public config snapshot。API key、Authorization 和 safeStorage 密文不进入 renderer、Session/Message records 或 trace。
