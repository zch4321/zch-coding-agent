# Backend State Architecture v2.1 · 详细重构计划

> 状态：实施中 · P0–P3 已完成 · 2026-07-23
>
> 目标架构：[`architecture.md`](./architecture.md)
>
> 产品约束：[`requirements.md`](./requirements.md)
>
> 前端验收：[`frontend-spec.md`](./frontend-spec.md)
>
> 本文描述从当前代码迁移到 Backend Architecture v2.1 的实施顺序、切流点、测试门禁和旧代码删除条件。它不是当前实现说明，也不扩大已确认的产品范围。

---

## 1. 计划结论

本次重构不采用一次性重写，也不允许新旧持久化长期双写。实施策略固定为：

1. 先稳定当前测试基线并冻结关键 Provider trajectory。
2. 在不接管用户数据的情况下建立 shared contracts、SQLite 和 repositories。
3. 先把唯一 Agent loop 从 Chat-Completions-shaped `ProviderMessage[]` 改成 canonical history + Protocol Adapter。
4. 在 backend application service 中实现完整 Session/Message/FileChange transaction 和 runtime 边界。
5. 新 IPC 和 renderer replica stores 准备完成后，进行一次协调切流。
6. 切流成功后立即删除 `workbench:save`、renderer durable Conversation 和 JSON change-history 写路径。
7. 最后用 restart、SQLite migration、Headless parity、Electron E2E 和 Windows package smoke 收口。

P1–P7 可以在同一重构分支上分批提交，但新持久化路径在 P8 前不写真实用户数据库。P8 是唯一 durable-state 真相源切流点：切流前 legacy JSON 是真相源；切流后 SQLite 是真相源。不存在同时以两边为准的稳定版本。P3 等阶段可以先替换进程内实现，但不能提前让 SQLite 和 Workbench 同时承接用户状态。

### 1.1 本次范围

- Backend-owned Project、Session、Message、Goal/Plan 和 FileChange 状态。
- SQLite migration、codec、repository 和 transaction service。
- Canonical `MessageRecord + MessagePart` 和 history compiler。
- Provider transport / protocol adapter 分层与 immutable `ModelRouteSnapshot`。
- `LiveSessionContext`、`ActiveRunExecution` 和完整 message 写入规则。
- Durable-state IPC、runtime stream IPC 和 renderer replica stores。
- Desktop、Headless、trace/replay、parity、E2E 和打包兼容。

### 1.2 本轮评审重点

实现前最值得单独确认的是三个决定：

1. P8 采用单次 durable-state 协调切流，P1–P7 不写真实用户 SQLite，不引入可长期启用的双写 feature flag。
2. SQLite 首选 Node.js 24 内置 `node:sqlite`，但以 Electron Windows packaged-app probe 作为硬门禁。
3. 当前超时的 benchmark case proof 从默认 `npm test` 稳定门禁中排除；本次重构及后续发布门禁均不执行该 benchmark。

---

## 2. 当前实现基线

以下结论来自 2026-07-22 对当前分支的代码审计。实施期间如果相关代码先发生变化，P0 必须更新本节和后续任务引用。

### 2.1 当前状态所有权

| 状态                                  | 当前真相源                                        | 当前持久化                                     | 主要实现                                                                              | 目标                                       |
| ------------------------------------- | ------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| Project 列表                          | Renderer Pinia                                    | `workbench.json`；旧版本可从 localStorage 导入 | `shared/workbench.ts`、`src/stores/agent-workbench.ts`、`electron/workbench/store.ts` | Backend `ProjectService` + SQLite          |
| Conversation/标题/模型/模式           | Renderer `ConversationRecord`                     | 整体写入 `workbench.json`                      | `src/stores/agent-workbench.ts`、`src/stores/agent-runtime.ts`                        | Backend `SessionRecord` + SQLite           |
| UI messages/tools/usage/orchestration | Renderer timeline                                 | `ConversationRecord` 内多个平行数组            | `src/stores/agent-timeline.ts`、`src/stores/runtime-events/*`                         | Backend `MessageRecord[]`；renderer 只投影 |
| Provider history                      | Main-process `SessionState.history`               | 不持久化                                       | `electron/session/session-types.ts`                                                   | SQLite canonical Messages                  |
| Goal/Plan                             | Main-process Session + renderer timeline 各有副本 | 最终随 Workbench 快照保存                      | orchestration tools/events + renderer stores                                          | `sessions.goal_json/plan_json`             |
| Active Run/approval/writer            | Main-process memory                               | 不持久化                                       | `SessionState.activeRun`、`WorkspaceAccessCoordinator`                                | 继续由 backend memory 持有                 |
| FileChanges/revert payload            | Backend `ChangeHistoryStore`                      | `change-history.json`                          | `electron/session/change-history.ts`                                                  | SQLite `file_changes`                      |
| Provider/config/secrets               | Backend ConfigStore                               | `config.json` + safeStorage secret file        | `electron/config/*`                                                                   | 保持现状                                   |
| Trace                                 | Backend TraceService                              | `traces/*.jsonl`                               | `electron/logging/*`                                                                  | 保持现状                                   |

### 2.2 当前五条关键数据流

#### 创建对话与 Session

```text
Renderer createConversationRecord()
  -> 立即创建 renderer-only ConversationRecord
  -> persistWorkbench() 写整个 Workbench
  -> 第一次发送前没有 backend Session

第一次发送
  -> session:create(conversationId, workspace, mode, provider)
  -> SessionManager 在 #sessions Map 中创建 SessionState
  -> appendInitialPromptHarness() 写入内存 ProviderMessage[]
  -> 只返回 sessionId，不写 Workbench 或其他 durable Session record
```

因此 UI 中的“对话”和 backend Session 不是同一个持久实体；应用重启后 renderer Conversation 存在，原 backend Session 已消失。

#### 用户发送消息

```text
Renderer run:start
  -> backend 在内存 history 追加 harness/context/user ProviderMessage
  -> Provider loop 读取内存 history
  -> stream events 推给 renderer
  -> renderer 自己追加 user/assistant/tool timeline
  -> assistant delta 也触发 250 ms debounce 的 Workbench 整体保存
```

当前数据库式“完整后再写入”语义不存在。虽然 backend 不落 partial message，但 renderer 会把 partial assistant delta 写进 `workbench.json`。

#### 应用重启

```text
workbench.json -> Renderer 恢复可见 Conversation/timeline
SessionManager #sessions Map -> 空
下一次发送 -> 创建新的空 SessionState + 新 harness
```

可见历史恢复了，但 Provider history 没有恢复。下一次请求不会自动包含重启前的完整对话。

#### 模型选择

- Composer Provider 下拉框绑定全局 `activeProviderId`。
- Composer model 下拉框调用 `setProviderModel()`，只修改 renderer 的 provider form draft。
- `ConversationRecord.model` 在 renderer 保存，但 `session:create` 只发送 provider id，不发送该 model。
- Provider precondition 检查 `session.provider`，实际主调用、compact 和 context budget 多处仍读取 `getActiveProviderConfig(config)`。

所以当前下拉框、Conversation 字段、Session provider 和实际 Provider request 不是一次 canonical mutation。

#### FileChanges

文件工具完成后，`SessionToolRunner` 尝试调用 `ChangeHistoryStore.record()`。当前 store：

- 使用 `conversationId + workspace` 归属记录。
- 同时保存 before/after 完整内容。
- 写入失败只记 diagnostic，terminal tool result 不会明确报告 revert 不可用。
- retention 在写后裁剪，超大单条记录仍可能保留。

这些行为需要在 FileChange 切流时一起修正，不能只把 JSON 行机械搬进 SQLite。

### 2.3 当前契约与依赖规模

- `shared/ipc-contract.ts` 当前定义 56 个 invoke channels，另有 Agent/Terminal 两条 push channels。
- Durable workbench 仍通过 `workbench:get/save/migrate-v1` 整体读写。
- 当前没有 `app:get-bootstrap`、Project/Session list/get/update/archive、Message paging 或 durable revision event。
- `ProviderMessage` 直接被 Session、Prompt Harness、Compact、Auto Approver、Context Budget、Trace、Runtime Parity 和 E2E fake provider 使用。
- `ConversationRecord/PersistedWorkbench` 直接被 shared serializer、IPC、WorkbenchStore、多个 Pinia stores、组件测试和 E2E fixture 使用。
- `shared/workbench.ts` 与 `src/stores/agent-types.ts` 维护语义重复但不完全相同的 Project/Conversation/Message 类型。
- 当前依赖中没有 SQLite package；开发、CI 和发布基线是 Node.js 24，当前 Node runtime 已提供 `node:sqlite`。

### 2.4 当前测试基线

2026-07-22 审计结果：

| 命令                                          | 结果                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run lint`                                | 通过                                                                                       |
| `npm run typecheck`                           | 通过                                                                                       |
| `npm test`                                    | 613 passed、7 skipped；`benchmarks/cases/cases.test.ts` 在全量并发执行中触发 120 s timeout |
| `npx vitest run electron/process/run.test.ts` | 7/7 通过                                                                                   |

全量 `npm test` 目前不是稳定绿色基线。P0 必须将长时间 benchmark proof 从默认单测门禁中排除；该 proof 不属于本次重构或后续发布的执行门禁，不能把这一既有失败错误归因到 SQLite 重构。

当前 E2E 多处直接调用 `workbench:get/save` 注入 fixture，并通过 reload 检查 renderer 快照。它们必须在 P7 改为通过新 backend commands 或专用测试 seed helper 建立数据，不能保留一个仅供测试使用的 durable Workbench 后门。

### 2.5 差距矩阵

| 当前结构/行为                             | 目标替代                                           | 首次引入 | 目标路径启用 | 删除旧结构 |
| ----------------------------------------- | -------------------------------------------------- | -------- | ------------ | ---------- |
| `ConversationRecord`                      | `SessionRecord + MessageRecord[]`                  | P1       | P8           | P9         |
| `workbench.json` snapshot save            | Project/Session/Message repositories               | P2/P4    | P8           | P9         |
| `SessionState.history: ProviderMessage[]` | canonical history + compiler                       | P3       | P3           | P3/P9      |
| 全局 active Provider 读取                 | immutable `ModelRouteSnapshot`                     | P3       | P4/P8        | P9         |
| renderer partial delta 落盘               | backend runtime overlay，final Message transaction | P4/P7    | P8           | P9         |
| `promptLedger` 平行结构                   | Message kind + typed metadata                      | P3       | P3           | P3         |
| `change-history.json`                     | `FileChangeRepository`                             | P2/P5    | P8           | P9         |
| `workbench:get/save`                      | bootstrap + typed CRUD/query                       | P6       | P8           | P9         |
| renderer Conversation/timeline truth      | replica stores + UI projection                     | P7       | P8           | P9         |
| trace replay 依赖 `ProviderMessage[]`     | recorded wire request + canonical adapter inputs   | P3/P4    | P8           | P9         |

---

## 3. 实施原则与依赖顺序

### 3.1 不变量

所有阶段必须遵守：

1. 用户数据只有一个真相源；不得因为过渡方便而长期双写 SQLite 和 Workbench。
2. Persistence 不导入 Provider、Electron renderer 或 Vue。
3. Provider Adapter 不直接读写 repository，也不创建数据库 MessageRecord。
4. Renderer 不自行提交 assistant/tool/harness durable message。
5. Stream delta 不触发数据库写入。
6. Tool-call assistant turn 只有在全部 terminal tool results 齐全时才整体提交。
7. Headless 和 Electron 继续调用同一个 Agent runtime/application service。
8. 每个阶段结束时至少能够 typecheck、lint、执行确定性单测；默认产品路径在 P8 前保持 legacy，在 P8 后只保留 target。

### 3.2 依赖图

```text
P0 Baseline
  -> P1 Shared Contracts
    -> P2 SQLite Foundation
    -> P3 Canonical History + Protocol Adapter
      -> P4 Durable Session/Application Runtime
        -> P5 FileChanges
          -> P6 Durable IPC
            -> P7 Renderer Replicas
              -> P8 Coordinated Cutover
                -> P9 Legacy Removal
                  -> P10 Hardening and Release Gate
```

P2 和 P3 的代码可并行开发，但 P4 同时依赖二者。P6、P7 可以先通过 isolated application-service fixtures 联调；正式 Desktop composition 只能在 P8 一次切换。

### 3.3 提交粒度

- 每个提交只引入一个 schema、repository、adapter 或可验证 vertical slice。
- 禁止在同一提交中同时改 schema、重写 renderer 和删除旧实现。
- 临时 compatibility code 必须在提交说明和本计划中有明确删除阶段。
- 新代码文件尽量低于 1,000 行；SessionManager 和 renderer store 的拆分以职责边界为准。

---

## 4. P0 · 稳定基线与防漂移门禁

### 4.1 目标

在重构前建立可靠的回归信号，并冻结当前 DeepSeek/OpenAI-compatible wire 行为。P0 不改变产品数据模型。

### 4.2 任务

- [x] 调整 Vitest 配置，将慢速 `benchmarks/cases/cases.test.ts` 排除在默认 suite 和本次重构的门禁之外。
- [x] 默认 Vitest worker 数固定为 4，避免全量 suite 在开发机上因过度并行放大内存与计时抖动。
- [x] 逐项运行并记录 `lint`、`format:check`、`typecheck`、`test`、`test:native`、`test:ripgrep` 和 `test:e2e` 基线。
- [x] 为普通文本、reasoning、单/多 tool call、拒绝、超时、compact、interjection 和 Plan continuation 保存确定性 Provider request/response golden fixtures。
- [x] 保存 Electron/Headless 当前 parity capture，标记允许变化的字段，禁止宽泛 snapshot ignore。
- [x] 增加架构边界测试：`shared/` 不导入 Node/Electron/Vue；后续 Persistence 不得导入 Provider；Core 不得重新引入 Chat wire DTO。
- [x] 列出直接读写 `workbench:get/save` 的 E2E 和 store tests，建立 P7 替换 checklist。

### 4.3 验收

- 默认静态与单测门禁连续运行可稳定通过。
- 不执行 benchmark case proof；它不影响本次重构的完成判断或发布门禁。
- 在 P3 改 Provider 层时，可以逐字段比较重构前后的 DeepSeek request、stream events、usage 和 tool chain。

### 4.4 回滚

P0 只调整测试和 fixture，不触及用户数据；任何门禁调整都可直接回退。

---

## 5. P1 · Shared Canonical Contracts

### 5.1 目标

在 `shared/` 中一次定义 Project、Session、Message、FileChange、Route、commands/results/events，作为 backend、renderer、IPC 和 database codec 的共同契约。

### 5.2 任务

- [x] 新增 `shared/project.ts`：`ProjectRecord` 和 revision 约束；所有稳定 ID 统一由 `shared/ids.ts` 导出。
- [x] 新增 `shared/session.ts`：`SessionRecord`、`SessionSnapshot`、分页摘要、lifecycle、Goal/Plan 和 model selection。
- [x] 新增 `shared/message.ts`：按 `kind` 判别的 `MessageRecord` 闭集 union，以及 `TextPart/ToolCallPart/ToolResultPart`。
- [x] 定义 `ProviderContinuationEnvelope`、`MessageMetadataV1` 和 `ModelRouteSnapshot`；禁止 credentials、raw request 和任意 metadata key。
- [x] 新增 `shared/file-change.ts`：公开 `FileChangeSummary`，不包含 `beforeContent`。
- [x] 扩展 `shared/ids.ts`：稳定 Project/Session/Message/FileChange IDs；`runId` 保持 runtime-only。
- [x] 新增 domain-state command/query/event schema；定义 `BackendEventCursor`、`DurableCommitEnvelope` 和各 topic 的 bounded change payload，payload/result 全部带 IPC version 和有界字段。
- [x] 明确 Message page 方向与 cursor：V1 使用 `beforeSeq?: number`、`limit <= 200`，返回降序查询结果时在 IPC response 中恢复为升序 records。

### 5.3 测试

- [x] 所有 shared records schema round-trip。
- [x] 每个 `kind` 的合法/非法 part 组合。
- [x] `tool_result.callId` 结构、assistant 本地 call ID 唯一性、route、reasoning/continuation 位置约束；跨 record call/result 配对留在 P3 compiler。
- [x] `JsonValue` 深度、数组长度、文本大小、总字节和 unknown-key 拒绝。
- [x] Renderer/backend 目标代码只允许复用 shared 导出，不新增复制定义或导入 legacy Workbench。

### 5.4 验收与删除

P1 不删除 `shared/workbench.ts`，因为 legacy runtime 仍在使用；但任何新 target code 禁止继续导入它。删除发生在 P9。

P1 的业务状态 API 位于 `shared/domain-state-api.ts`，用于区分 backend-owned domain state、瞬时 runtime state 和 renderer UI state；其中 `DurableCommitEnvelope` 仍专指已经提交的持久事实。该 API 尚未注册到现有 `IPC_CONTRACTS`、preload 或 handler，正式接线仍在 P6。Record-local TypeBox schema 与 bounded JSON/route/page semantic validators 共同构成 P2 codec 边界；跨 Message 的 call/result 完整性由 P3 `MessageHistoryCompiler` 校验。

---

## 6. P2 · SQLite 与 Persistence Foundation

### 6.1 目标

建立独立但非独立进程的 Persistence layer。此阶段只在测试数据库中启用，不读取或修改真实 `workbench.json`。

### 6.2 Driver 决策

使用 Node.js 24 内置 `node:sqlite`：

- 当前开发、CI、发布和 Docker worker 基线都是 Node 24。
- 避免增加第二个 native addon 和额外 ABI rebuild。
- Desktop 使用 Electron 自带 Node runtime；P2 必须增加 Windows packaged-app feature probe，确认 `node:sqlite` 在目标 Electron 中可用。
- 如果 Electron package smoke 证明目标 runtime 不支持所需 API，P2 停止并单独评审 driver，不在 repository 中偷偷切换实现。

V1 使用单 connection、串行 write queue 和短 transaction。数据库不接收 token delta，因此同步 SQLite API 不应位于高频 stream path；仍需通过性能测试限制主进程单次查询和 migration 时间。

### 6.3 任务

- [x] 新增 `electron/persistence/database-service.ts`，统一负责 open、PRAGMA、migration、write queue、transaction 和 close。
- [x] Desktop database 固定为 `userData/agent.db`；Headless 每个 trial 使用隔离临时 database path。
- [x] 实现 `schema_migrations` bootstrap、递增 migration 文件、SHA-256 checksum、forward-only 和 higher-version refusal。
- [x] 新增 `0001_initial.sql`，创建 `projects/sessions/messages/file_changes` 和目标 indexes/checks。
- [x] 新增 Project/Session/Message/FileChange repositories；repository 接受 transaction handle，不自行 commit。
- [x] 新增 row codecs，在读写边界使用 P1 shared schema 校验 JSON、时间、boolean 和 enum。
- [x] 所有业务 transaction 由 application service 发起；DatabaseService 不发布 renderer event。
- [x] 对本地搜索先实现有界 text-part scan；不在 V1 增加 FTS 真相源。
- [x] 为 test harness 提供临时文件数据库工厂；不要依赖共享全局内存 database。

### 6.4 测试

- [x] migration 顺序、checksum mismatch、单步 rollback、重复启动和高版本拒绝。
- [x] `foreign_keys = ON`、WAL、busy timeout 和 close/dispose。
- [x] codec deep-equality、损坏 JSON/enum 拒绝和 nullable JSON。
- [x] Project path uniqueness、Session cascade、Message seq/clientRequest uniqueness。
- [x] 跨 Repository transaction rollback 不留下半条 Session/Message。
- [x] 200 条/50 MB FileChange retention 与单条超限预检查。
- [x] Electron development、Headless Node 24、Windows x64 packaged app 都能 open/migrate/query/close。

### 6.5 验收与回滚

P2 结束时 repositories 只能由 unit/integration tests 使用。回滚只删除新代码和临时测试数据库，不需要用户数据恢复。

P2 已按该隔离边界完成：production Desktop/Headless composition 尚未导入 Persistence，真实 `userData`、`workbench.json` 和 `change-history.json` 均未读写。`npm run test:sqlite` 覆盖 host Node 与 development Electron runtime，`npm run test:sqlite:packaged` 覆盖 Windows x64 unpacked package；探针执行文件数据库 migration transaction、query、close、reopen 和清理。Headless bundle 明确以 Node 24 为 build target；本地验证时 development Electron 与 packaged Electron 均内嵌 Node 24.16.0。

---

## 7. P3 · Canonical History 与 Provider Protocol Adapter

### 7.1 目标

让唯一 Agent loop 不再把 Chat Completions DTO 当内部历史。P3 可以在 legacy Desktop 持久化仍启用时先切换内存模型，因为它不改变用户文件格式。

### 7.2 任务

- [x] 新增 `MessageHistoryCompiler`：排序、active-history 选择、compact boundary、kind/parts 和 call/result 完整性校验。
- [x] 将 Prompt Harness、runtime context、agents context、orchestrator 和 interjection 追加为 canonical messages，不再维护独立 `promptLedger + ProviderMessage` 双结构。
- [x] 定义 `ProviderProtocolAdapter<RequestDto>` 和 `CompletedAssistantTurn`；Adapter 消费完整 `CompiledCanonicalHistory`。
- [x] 把现有 `OpenAICompatibleProvider` 拆为 Chat Completions Protocol Adapter 与 HTTP/SSE transport。
- [x] DeepSeek production route 使用 `deepseek.chat-completions` adapter，并保持当前 reasoning/tool/usage 行为。
- [x] Provider config v9 增加明确 adapter selection 和单调 revision；route/credential 修改递增 revision，credential 值不参与 shared snapshot。
- [x] 实现 route resolver：每个 Run 冻结 main/compression/approval route、credential 与 provider profile，不在 Run 内重新选择全局 active Provider。
- [x] Context budget 使用冻结 route 对应的 model profile 和完整 Adapter request/tools，不再静默裁剪 active turns。
- [x] Compact 输入/输出改为 canonical history；只在新用户输入或完整 tool-result batch 后改变 active history。
- [x] Auto Approver 使用独立 `purpose = 'approval'` route，不复用 main 的可变 Provider 对象。
- [x] `beforeLLMCall` hook 只能修改已编译 request 深拷贝/安全 params，不得改写 route、tools、credential 或 canonical records。
- [x] Trace v2 同时记录 canonical source summary、route snapshot、实际 wire request、canonical completion 和 raw response；旧 trace 明确拒绝。
- [x] Runtime parity capture 从 Core 共享 `ProviderMessage` 改为 Adapter 边界的 request/output 比较。
- [x] 用 test-only protocol fixtures 证明 Adapter 支持一对多、多对一映射；产品设置不开放 Responses/Anthropic。

### 7.3 迁移检查清单

必须逐一清理当前 `ProviderMessage` consumers：

- `electron/session/session-types.ts`
- `electron/session/prompt-harness.ts`
- `electron/session/session-compact-coordinator.ts`
- `electron/session/session-provider-turn.ts`
- `electron/session/session-manager.ts` trace fork path
- `electron/permission/auto-approver.ts`
- `electron/tools/context-budget.ts`
- `electron/logging/service.ts`
- `electron/runtime/runtime-parity.ts`
- `e2e/support/fake-provider.ts`

目标 grep gate：除 Chat wire DTO/Adapter 内部外，Core、Persistence、Renderer 中不得出现 `ProviderMessage`、`reasoning_content`、`tool_call_id` 或 `tool_calls` wire fields。
E2E fake provider 本身是 wire 边界，可以保留本地声明的 Chat DTO；它不能被 Core、Persistence 或 Renderer 导入。

### 7.4 测试

- [x] P0 golden fixtures 在 Chat Adapter 下逐字段等价。
- [x] Canonical history 同输入、route、tools 和 adapter config 生成确定 request。
- [x] Tool call/result 缺失、重复、顺序错误在 provider call 前失败。
- [x] continuation adapter/format compatible、incompatible、canonical mismatch 和 corrupt paths。
- [x] DeepSeek reasoning 原文只进入 continuation，可读投影进入 normalized field。
- [x] route 在 Run 内冻结；修改全局 config 不改变已开始 Run。
- [x] 两个 Session 使用不同 provider/model 时不会串 route。
- [x] Electron/Headless parity 保持通过。

### 7.5 验收与回滚

P3 完成后只有 Provider Adapter/transport 与协议 fixtures 理解 wire DTO。P3 使用 reset-only AppConfig v9、Trace v2 和修改后的开发数据库 `0001_initial` checksum；检测到旧版或不兼容配置时直接删除配置文件并用 v9 默认值重建。旧 trace 和旧 P2 开发数据库不做兼容迁移，仍明确要求删除重建。SQLite 在 P8 前仍不是产品用户状态真相源。

自动 compact 的重建顺序固定为 `system → harness* → root user replay → compact summary`，其中 summary 在 Chat Completions 下编译为最后一个可响应的 user-role continuation；工具进展只由 summary 恢复。手动 `/compact <正文>` 的顺序不同，固定为 `system → harness* → compact summary → new user`；纯 `/compact` 展示 summary 后结束。

---

## 8. P4 · Durable Application Service 与 Runtime

### 8.1 目标

实现 backend-owned Project/Session/Message 状态和 runtime object 分离。此阶段通过 isolated target composition 测试，不在 Desktop 默认启动路径写真实用户数据库。

### 8.2 目标模块

```text
electron/application/
  application-state-coordinator.ts
  project-service.ts
  session-service.ts
  durable-execution-state-port.ts
  durable-run-application-service.ts
  live-session-context-registry.ts
  create-durable-target-runtime.ts
```

现有 `SessionManager` 逐步缩成 facade 或被这些模块替代，不能把 repository SQL、Provider loop、Terminal、Goal/Plan 和 IPC 继续集中进单类。

### 8.3 任务

- [x] `ProjectService` 实现 list/add/update/remove，canonicalize path，并在 path update/remove 前检查 active runtime resources。
- [x] `SessionService` 实现 list/get/update/archive、Message paging/search、首次发送和普通 Session fork。
- [x] 点击新对话只创建 renderer draft/候选 ID；首次 `run:start new_session` 才把 Session 与首批 Messages 原子写入 SQLite。
- [x] `LiveSessionContextRegistry` 按需加载 durable Session/history，管理 terminal/MCP/logger/cache 和一个 active execution。
- [x] 现有 `ActiveRun` 在启动时冻结 route、permission mode、AbortController、writer/run lease，并维护有界 public stream/tool/approval/interjection snapshot。
- [x] 第一次 `run:start` 构造 initial harness/runtime/agents context；同一个 transaction 按顺序插入完整 Messages 和 user input，后续 context 变化只追加新 records。
- [x] `run:start` 先完成并发/writer precondition，再提交完整 Messages；commit 后才调用 Provider。
- [x] Stream delta 只写 ActiveRun buffer 和 runtime events。
- [x] 无 tool call 的 completed assistant turn 一次插入完整 Message。
- [x] 有 tool calls 时等待全部 terminal results 后用单 transaction 插入 assistant + ordered results。
- [x] 拒绝、取消、timeout 和 validation failure 都形成 terminal tool-result part。
- [x] Goal/Plan 的模型工具与 UI command 经同一个 durable execution-state port 调用 SessionService transaction。
- [x] Compact 在内存完成重建/预算校验后，用一个 transaction 插入完整 epoch、更新旧 prefix `inHistory` 并递增 revision。
- [x] `session:get` 可附带 ActiveRunPublicSnapshot；main restart 不恢复 active execution。
- [x] `session:archive` 禁止 active Run；idle eviction 与 durable lifecycle 分离。
- [x] Session archive/Project remove、target dispose 和首次发送异常路径释放 live resources。
- [x] 普通 fork 支持 historical/latest、完整 tool batch、replay ID remap、compact epoch、Goal/Plan 策略和 512 上限。

### 8.4 关键 transaction

#### 用户发送

```text
reserve runtime capacity
  -> BEGIN IMMEDIATE
  -> dedupe clientRequestId
  -> allocate seq(s)
  -> insert complete user/context messages
  -> update Session revision/lastSeq
  -> COMMIT
  -> publish durable records
  -> start provider loop
```

数据库失败时必须释放预留资源，并且不得让 renderer 显示已提交 user message。

#### Tool batch

```text
completed assistant tool-call turn stays in memory
  -> execute every call to terminal result
  -> BEGIN IMMEDIATE
  -> insert assistant turn
  -> insert ordered tool-result messages
  -> update Session revision/lastSeq
  -> COMMIT
  -> publish records
  -> next provider call
```

### 8.5 测试

- [x] create/update/archive/restart round-trip。
- [x] clientRequest retry 只生成一条 user message；同进程返回同一 run，重启后只返回 deduplicated。
- [x] final assistant 完成前数据库无 partial record。
- [x] tool batch 只提交完整 assistant + terminal results，不留下 assistant 半链。
- [x] cancellation 在 user commit 后可留下未回答 user message，但不伪造 interrupted assistant。
- [x] renderer-style reload 获取 runtime snapshot；main restart 只恢复 durable state。
- [x] writer lease 与 run slot 继续复用现有全部 terminal-path regression suite。
- [x] Goal/Plan/compact 通过同一 Session mutation primitive 落盘。
- [x] 临时数据库完成 A/tool/final/reopen/B，并从 SQLite active history 重建第二次 request。

### 8.6 验收与回滚

P4 target composition 必须能在临时数据库中完成“发送 A → tool chain → final → dispose → reopen → 发送 B”的核心回归。Desktop 默认 composition 仍未切流，因此失败可回退新 modules 而不迁移用户数据。

---

## 9. P5 · FileChanges

### 9.1 任务

- [ ] 用 `FileChangeService/Repository` 替换 JSON store 的目标实现，公开只返回 `FileChangeSummary`。
- [ ] 单条 payload 超限必须在 filesystem mutation 前拒绝。
- [ ] filesystem mutation 后重新验证 after existence/hash，再写 FileChange。
- [ ] FileChange 持久化失败时 terminal tool result 明确返回 `mutationSucceeded = true`、`CHANGE_HISTORY_PERSIST_FAILED`、`revertAvailable = false`。
- [ ] 不保存 `afterContent`；revert 使用 beforeContent，冲突检查使用 after existence/hash。
- [ ] retention 与 insert 在同一 transaction；只删除最旧 FileChanges，不修改 Messages/workspace。
- [ ] revert 获取 workspace writer lease，成功后 revisioned update record。

### 9.2 测试与验收

- [ ] create/patch/delete 重启后 list/revert。
- [ ] RESOURCE_CHANGED、重复 revert、超限和 persistence failure。
- [ ] `beforeContent` 不进入 IPC、renderer store、DOM 或默认 trace。

---

## 10. P6 · Durable IPC 与 Event Protocol

### 10.1 目标

建立 renderer 唯一允许使用的 backend state API。新 contracts 可先通过 handler tests 联调，P8 前不删除 legacy Workbench channels。

### 10.2 目标 invoke channels

```text
app:get-bootstrap

project:list
project:add
project:update
project:remove

session:list
session:get
session:update
session:archive
session:fork
message:list
message:search

file-change:list
file-change:revert

run:start
run:interrupt
run:interject
approval:decide
```

Terminal、Settings、Trace、Skills、MCP、ProjectModel 和 workspace read APIs 保持各自现有边界，只把 payload 中的 Conversation/workspace 归属逐步改为 Project/Session identity。

### 10.3 Command 规则

- [ ] `app:get-bootstrap` 返回 Projects、最近 Sessions、当前选择、必要 public settings 和同一 snapshot 边界的 `BackendEventCursor`，不返回全部 Message 内容。
- [ ] `session:get` 返回 SessionSnapshot、第一页 messages 和可选 ActiveRunPublicSnapshot。
- [ ] `message:list` 使用稳定 seq cursor，后台严格限制 page size。
- [ ] `session:update` 支持 title/model selection/mode 等受约束 patch，并携带 `expectedRevision`；冲突返回当前 record。
- [ ] target UI 不调用 `session:create`；首次发送使用 `run:start new_session`，后续使用 `run:start existing_session`。
- [ ] `file-change:list/revert` 只接收 `sessionId`/changeId；backend 自己解析 Project workspace。
- [ ] IPC handler 只调用 application service，不直接访问 repositories/runtime maps。
- [ ] 每个 durable command 在 commit 后只构造一次 envelope；invoke result 和 push event 复用同一对象语义，到达顺序不作保证，失败 transaction 不发布事件。
- [ ] Commit、cursor 分配和 envelope 发布属于同一个串行 application-state job；bootstrap snapshot/cursor 读取进入同一队列，不暴露 commit 与 cursor 之间的中间状态。
- [ ] `run:start` result 同时返回 user/context Message commit envelope 与 runtime snapshot/runId；后续 assistant/tool commit 由 backend event 主动推送。
- [ ] Conversation export 从 backend query 构造，不接收 renderer 自己拼出的整份 Markdown/ConversationRecord 作为事实。

### 10.4 Push channels

- Durable state 新增独立 versioned event envelope：`project.changed`、`session.changed`、`file-change.changed`。
- Envelope 带 main-process 实例 ID 和实例内全局单调 sequence；它只用于传输去重、排序和缺口检测，不落盘、不充当领域 revision。
- `project.changed` 和 `file-change.changed` 推送 bounded full-list snapshot；`session.changed` 推送完整 SessionRecord 与 bounded Message upserts，过大的 compact change 使用 cache invalidation。
- 现有 Agent event channel 继续承载 runtime status/delta/tool/approval/orchestration，避免把 durable record 和 partial stream 混为一种事件。
- Terminal event channel 保持独立。
- Renderer 在 hydrate 前先订阅并 buffer durable events；bootstrap snapshot 携带 cursor，安装 snapshot 后只重放更新且连续的 buffered events。
- Renderer 让 invoke result 和 push event 经过同一个 reconciler；重复 cursor 幂等忽略，cursor gap/instance change 重新 bootstrap，Session revision gap 调用 `session:get` 替换副本。
- Durable state 不做定时轮询；query 只用于 bootstrap、分页/搜索/按需加载和缺口重同步。
- Durable event 只在 database commit 后发布；不增加 durable outbox。

### 10.5 测试与验收

- [ ] 每个 payload/result/event schema 的 valid/invalid/size/sender cases。
- [ ] handler 返回 shared canonical records，不返回 database rows。
- [ ] command response/event 两种到达顺序与重复 envelope 都只应用一次。
- [ ] revision conflict、event cursor gap、backend instance change、bootstrap buffer overflow、renderer reload snapshot 和重同步。
- [ ] `AGENT_API_KEYS`、preload、IPC contracts 和 handlers 一一对应。
- [ ] Headless application service 不依赖 IPC。

---

## 11. P7 · Renderer Replica Stores

### 11.1 目标

让 renderer 从 durable state owner 变成 backend record replica + runtime overlay + UI-only state。

### 11.2 目标 stores

```text
app-shell-store
project-replica-store
session-replica-store
run-stream-store
settings-replica-store
composer-ui-store
ui-store
```

### 11.3 任务

- [ ] Preload 先注册 durable listener 并在 hydrate 前有界 buffer；Bootstrap 只从 `app:get-bootstrap` 初始化 Projects/Sessions，按 cursor 重放 buffer，不读 Workbench 作为正常路径。
- [ ] 实现唯一 durable-event reconciler，command result 与 push event 共用：cursor 去重/排序、Session revision 校验、缺口 resync 和 cache invalidation。
- [ ] Sidebar、新建、重命名、archive、Project add/remove 全部发送 backend command；仅设置 pending UI，收到 commit envelope 后才修改 durable replica。
- [ ] Session timeline 从 `MessageRecord[]` 投影；不复制另一套 ChatMessage/ToolActivity durable schema。
- [ ] `kind = 'user_input'` 才渲染用户气泡；text/tool-call/tool-result parts 按序投影。
- [ ] Runtime stream store 维护未完成 assistant/tool/approval overlay；收到 committed Message 后按 run/call 关联清除 overlay。
- [ ] Delta 不调用任何 durable save。
- [ ] Composer draft、attachments、IME 保留在 UI store；切换/刷新丢失可接受。
- [ ] 模型/Provider 下拉框绑定 active Session `modelSelection`，通过 `session:update(expectedRevision)` 提交；失败恢复 backend 值。
- [ ] Settings Provider editor 与 Session selector 分离；全局 default 只影响新 Session。
- [ ] Goal/Plan UI 使用 SessionRecord；runtime event 只能展示 pending，commit event/response 才更新 durable replica。
- [ ] Search 调 backend，只搜索 title 和 user/assistant text parts。
- [ ] Message paging、scroll anchor、background Session event 和 revision gap resync。
- [ ] 不增加 durable polling timer；query 仅用于 bootstrap、Session open、分页/搜索、FileChange 按需加载和 gap recovery。
- [ ] Conversation Markdown export 从 backend records 生成。

### 11.4 测试迁移

- [ ] 重写 `agent.history/conversations/requests/runtime-events/concurrency` store tests，删除 Workbench snapshot expectation。
- [ ] E2E fixture 使用 backend commands 或受限 test seed helper，不调用 `workbench:save`。
- [ ] reload E2E 验证 SQLite Session/Message，而不是 renderer partial snapshot。
- [ ] bootstrap 期间发生 commit 不丢事件；event 先于 response、response 先于 event 和重复 delivery 得到相同副本。
- [ ] background Run、approval、writer lock 和 interjection 不串 Session。
- [ ] partial assistant 在 renderer reload/main survive 情况下可从 ActiveRun snapshot恢复；main crash 后允许丢失。

### 11.5 验收

Renderer source 中不再有“写完整 Workbench”的新调用；在 P8 切流前，target renderer 可对 isolated target backend 跑完组件和 E2E harness。

---

## 12. P8 · 协调切流

### 12.1 切流前置条件

- P0–P7 全部 exit criteria 通过。
- 目标 database/application/IPC/renderer 已在临时 userData 上跑完核心 restart E2E。
- Windows x64 packaged app 可 open/migrate/query `node:sqlite`。
- 不存在阻塞级 schema/open decision。

### 12.2 Desktop 启动顺序

```text
Config/Secrets initialize
  -> DatabaseService open + migrations
  -> repositories + application services
  -> Agent runtime composition
  -> register target IPC
  -> create renderer window
  -> preload subscribe + bounded durable event buffer
  -> renderer app:get-bootstrap(snapshot + cursor)
  -> hydrate + replay newer buffered events
  -> live event apply
```

如果 database open/migration 失败，应用显示明确的 blocking recovery 状态；不得静默回退到 renderer Workbench truth。

### 12.3 切流动作

- [ ] `electron/main.ts` 默认组装 target DatabaseService/Application/Runtime。
- [ ] Renderer 默认加载 replica stores。
- [ ] 停止注册/调用 `workbench:save` 和 JSON ChangeHistory 写路径。
- [ ] Headless 为每个 run/trial创建独立数据库，并调用同一 target composition。
- [ ] Trace replay/fork 通过 target SessionService 和 Protocol Adapter，不注入第二套 history。

### 12.4 切流验收场景

1. 新用户：添加 Project、创建空 Session、发送、重启、继续。
2. Tool chain：assistant calls、多个 terminal results、final answer，重启后请求完整。
3. Crash：user 已提交但 assistant 未完成，重启后不出现 partial/interrupted message。
4. Renderer reload：main 存活时 Run 继续，UI 重新取得 ActiveRun snapshot。
5. 模型切换：Session A/B 使用不同 route，全局 default 修改不影响已有 Session。
6. Bootstrap race：snapshot 读取期间提交 Session/Message，renderer 最终副本既不遗漏也不重复。
7. Concurrent sessions：一写多读、writer delayed release、后台事件不串线。
8. FileChanges：重启 list/revert、冲突拒绝、retention 正确。
9. Headless parity：Provider requests、tools、prompt hashes 和 patch 与 Electron 一致。

### 12.5 回滚策略

- 数据库只做 forward migration，不自动 down migration。
- 如果切流版本尚未发布，只回退 composition commit并删除测试 userData。
- 如果已发布且用户产生了新 SQLite-only Session，不能简单降级旧版本；必须修复 forward 或提供独立只读导出工具。

---

## 13. P9 · 删除 Legacy 路径

P8 稳定后立即删除，不保留“以后可能用”的双实现。

### 13.1 Backend 删除

- [ ] `electron/workbench/store.ts` 及测试。
- [ ] 正常路径的 `workbench:get/save/migrate-v1` handlers/preload/API contracts。
- [ ] `ChangeHistoryStore` JSON writer 和 `change-history.json` 初始化。
- [ ] `SessionState.history` memory truth、`conversationId` identity bridge 和 `conversationIdBySessionId` mapping。
- [ ] Provider Core 中残留 Chat wire DTO。
- [ ] 直接从 global active provider 解析当前 Run 的调用。

### 13.2 Shared/Renderer 删除

- [ ] `shared/workbench.ts` 及其目标外引用。
- [ ] `src/stores/agent-workbench.ts`、`workbench-persistence.ts`、重复 `agent-types` durable records。
- [ ] `HISTORY_KEY` ongoing localStorage persistence。
- [ ] renderer timeline 到 ConversationRecord 的 `writeToConversation()`。
- [ ] `transient Conversation`、`conversationId -> sessionId` 和 fork metadata 双结构。
- [ ] E2E 中直接 Workbench mutation。

### 13.3 删除门禁

使用 grep/architecture tests 保证：

- 产品代码不再包含 `saveWorkbench`。
- 产品代码不再读取或写入 `workbench.json`/`change-history.json`。
- `ProviderMessage` 只可能是某个 wire Adapter 内部私有类型，不从 `electron/providers` 公共出口导出。
- Renderer 不引用 SQLite、Node、Electron IPC renderer 原语或 backend-private FileChange payload。

---

## 14. P10 · Hardening 与发布门禁

### 14.1 必须新增的核心回归

- [ ] SQLite reopen 后 A/tool/final/B canonical request 完整。
- [ ] migration checksum、损坏 database、future version 和磁盘写失败有可诊断错误。
- [ ] Session revision gap 可恢复，durable event 不丢失已提交事实。
- [ ] 多 tool batch 任一 repository error 都不留下协议半截。
- [ ] continuation round-trip 与 adapter switch fallback。
- [ ] compact 后旧 records 仍可展示、active history 只含 summary/new suffix。
- [ ] Project remove cascade 不删除 workspace。
- [ ] FileChange private snapshot 不进入 IPC/DOM/trace 默认记录。
- [ ] app dispose、session archive、run cancel 和不可中止 side effect 没有资源泄漏。

### 14.2 全部门禁

```text
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:native
npm run test:ripgrep
npm run test:e2e
npm run build:headless
npm run build
```

另外执行：

- Electron/Headless parity suite。
- Windows x64 安装包首次启动、SQLite migration、重启续聊和卸载后 userData 保留检查。
- `npm run test:real` 只在具备显式凭据时运行，不进入确定性默认门禁。

### 14.3 性能预算

- Bootstrap 不读取全部 Message 正文，只读取 Projects、Session summaries 和当前 Session 首屏。
- Message page 最大 200，搜索结果和摘要有硬上限。
- Stream path 零 SQLite writes。
- 单个 transaction 不包含 Provider 网络、工具执行或 filesystem IO。
- SQLite migration 输出阶段进度/诊断，不能冻结后静默等待。

### 14.4 文档收口

- [ ] `architecture.md` 状态从目标规范更新为已实现部分，并保留真实剩余差距。
- [ ] `requirements.md` 和 `frontend-spec.md` 的验收项逐项勾验。
- [ ] `road-map.md` 删除已经完成的 Backend State Refactor 计划入口，只保留后续产品方向。
- [ ] README 更新数据库位置、备份和故障恢复说明。

---

## 15. 风险登记

| 风险                              | 触发点 | 缓解                                                 | 阻塞门禁                         |
| --------------------------------- | ------ | ---------------------------------------------------- | -------------------------------- |
| Provider wire 行为漂移            | P3     | P0 golden、adapter contract、real-provider opt-in    | DeepSeek golden 与 parity 通过   |
| Harness 顺序或 compact 语义改变   | P3/P4  | canonical source metadata、prompt build comparison   | Prompt/compact suites 通过       |
| 模型仍读取全局 active config      | P3/P4  | immutable route grep gate 和 concurrent Session test | 两 Session 不同 route E2E        |
| Partial stream 再次落盘           | P7     | runtime overlay store，禁止 durable save             | crash/reload E2E                 |
| SQLite 阻塞 main process          | P2/P10 | 短 transaction、分页、无 delta writes、性能测量      | bootstrap/query budget           |
| Electron/Headless runtime 分叉    | P4/P8  | 唯一 composition + parity capture                    | parity suite                     |
| E2E 依赖旧 Workbench 后门         | P7/P9  | backend seed helper/commands                         | grep 无 `workbench:save` fixture |
| File mutation 成功但 history 失败 | P5     | terminal warning + revert unavailable                | fault-injection test             |
| 发布后无法旧版降级                | P8     | forward fix/export policy                            | upgrade drill 与 recovery 文档   |

---

## 16. 阶段完成定义

一个阶段只有同时满足以下条件才算完成：

1. 本阶段任务和测试 checklist 完成。
2. 新旧边界没有未记录的双写或 hidden fallback。
3. 相关 static/unit/integration gates 通过。
4. 新增 schema、migration、IPC 或 adapter 已有 failure-path coverage。
5. 临时 compatibility code 标注 P8/P9 删除点。
6. 文档中的实际文件/接口名称与代码一致。
7. scoped commit 已推送；工作树中的用户无关改动未被覆盖或混入。

最终重构完成的判断不是“SQLite 已接入”，而是以下事实同时成立：

- 重启后 backend 能从 SQLite 重建下一次 Provider request 的完整 canonical history。
- Renderer 只保存 backend records 的副本和 UI-only/runtime overlay。
- Session model selector 确实修改 backend Session，Run 使用冻结 route。
- `workbench.json`、`change-history.json` 和 `ProviderMessage[]` 不再是产品运行时真相源。
- Desktop、Headless、trace/replay、tools、compact、Goal/Plan、concurrency 和 FileChange 行为都通过同一组架构不变量。
