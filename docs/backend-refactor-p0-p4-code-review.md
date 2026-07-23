# Backend State v2 分支 Code Review 报告（P0–P4，整合版）

> 日期：2026-07-23
> 分支：`refactor/backend-state-v2`（HEAD `843829a`）
> 对比基线：`38a5e55`（与 `master` 的 merge-base），共 17 个提交、147 个文件、+15946/-3277 行
> 范围：P0 测试基线与门禁、P1 shared canonical contracts、P2 SQLite persistence、P3 canonical history + Provider Protocol Adapter、P4 durable application services
> 来源：本版整合了两轮独立评审——主评审（7 个区域并行深审）与 `docs/codex-backend-state-v2-review.md`（Codex 评审）。两份报告的全部发现均已逐条对照当前源码独立复核，确认属实后方收录；个别定性差异以复核结论为准（见 H-3 的重试语义修正）。本报告仅评审，未修改任何代码。

---

## 1. 总结论

分支整体质量高，架构方向与 `docs/backend-refactor-plan.md` 一致：核心不变量（user commit 先于 provider、tool batch 单事务、事件仅 commit 后发布一次、stream delta 不写库、credential 不进 snapshot/trace、persistence 无 provider/renderer 依赖）在代码走查中均确认成立，P0 golden fixtures 逐字节未变且以 `toEqual` 严格断言通过。

发现 **7 个 High、9 个 Medium、约 20 个 Low** 及若干 Info 级问题。High 项的共同主题是**异步边界上的校验/回滚/互斥缺位**：

1. SQLite schema 缺少 FK 子侧索引，长会话级联删除以 O(N²) 同步阻塞主进程；
2. 跨 turn 重复 tool callId 的唯一性校验发生在工具执行与 durable 提交**之后**，一旦触发，session 内存与磁盘同时永久中毒、无恢复路径；
3. 裸 `/compact`（无 follow-up）经 durable `run:start` 必然向调用方报错（实际已成功落库），且该 request ID 被永久污染；
4. durable commit 失败后内存 canonical history 不回滚，后续 Run 会把先前失败的记录一并提交为 durable 事实；
5. 不合法/超限的 Provider tool batch 在任何 durable 校验之前就执行工具副作用；
6. 并发 `new_session` 首次发送的失败者会误删获胜者的 durable binding，导致本应获胜的首发失败；
7. lazy restore 的加载窗口不参与 Project/Session 生命周期保护，archive/update/remove 可与加载交错产生不可用的 live session。

其中 H-1 属 P2 schema 缺陷（建议直接改 `0001_initial.sql`，P8 前开发库本就删除重建）；H-2/H-3/H-5/H-7 涉及提交前校验与回滚策略，建议在 P5 开工前修复；H-4/H-6 为 durable 组合下的并发互斥缺口，必须在 P6/P8 接线前修复。

## 2. 门禁实测（本机复跑）

| 门禁                   | 结果                                                 |
| ---------------------- | ---------------------------------------------------- |
| `npm run typecheck`    | 通过                                                 |
| `npm run lint`         | 通过                                                 |
| `npm run format:check` | 通过                                                 |
| `npm test`             | 104 文件通过、2 跳过；698 测试通过、7 跳过；约 124 s |

与 `docs/backend-refactor-p0-baseline.md` 基线一致。Codex 评审另报告 `npm run test:sqlite` 通过、`test:sqlite:packaged` 在 Darwin 主机按设计跳过。本次评审未复跑 `test:native` / `test:ripgrep` / `test:e2e` / `test:sqlite*`。

## 3. 发现汇总

| ID   | 严重度 | 区域        | 摘要                                                         | 来源   |
| ---- | ------ | ----------- | ------------------------------------------------------------ | ------ |
| H-1  | High   | persistence | `messages` 自引用 FK 缺子侧索引，级联删除 O(N²) 阻塞主进程   | 主评审 |
| H-2  | High   | session     | 跨 turn 重复 callId 在执行+提交后才检测，durable 永久中毒    | 主评审 |
| H-3  | High   | application | 裸 `/compact` 经 durable run:start 必报错且污染 request ID   | 双方   |
| H-4  | High   | application | 并发 `new_session` 首发的失败者误删获胜者 binding            | Codex  |
| H-5  | High   | application | commit 失败后内存 history 不回滚，失败记录事后变 durable     | Codex  |
| H-6  | High   | application | lazy restore 加载窗口不受 Project/Session 生命周期保护       | Codex  |
| H-7  | High   | session     | 非法/超限 tool batch 在 durable 校验前执行工具副作用         | Codex  |
| M-1  | Medium | providers   | reasoning-only/空 content 的合法 completion 被误判为错误     | 主评审 |
| M-2  | Medium | session     | append 与工具执行间的 await 窗口可致内存 batch 悬挂卡死      | 主评审 |
| M-3  | Medium | application | execution port 缺 per-session 串行化，metadata/run commit 交错可错位 | 主评审 |
| M-4  | Medium | application | update/archive 的 post-commit 动作抛错造成"已提交却报错"撕裂 | 主评审 |
| M-5  | Medium | persistence | `PersistenceTransaction.exec` 允许事务控制语句，可"假失败真提交" | 主评审 |
| M-6  | Medium | config      | 更高版本配置同样被静默删除重建，且无备份                     | 主评审 |
| M-7  | Medium | infra       | `sqlite-smoke.cjs --packaged` 在非 Windows fresh 环境报错而非 skip | 双方 |
| M-8  | Medium | application | 第 513 个 Project 写库成功但从所有 full-list API 消失        | Codex  |
| M-9  | Medium | session     | 合法附件组合可超单 Message text 上限，落入 H-5 污染路径      | Codex  |

---

## 4. High 级发现

### H-1 `messages` 自引用 FK 缺子侧索引，级联删除 O(N²) 阻塞主进程

`electron/persistence/migrations/0001_initial.sql:100-101` 定义：

```sql
FOREIGN KEY (replayed_from_message_id, session_id)
  REFERENCES messages(id, session_id) ON DELETE CASCADE,
```

但全 schema 只有 `messages_history_idx(session_id, in_history, seq)`（`:133-134`），没有以 `replayed_from_message_id` 开头的索引。SQLite 执行 FK 级联时需要按子键查找子行；无索引时每删除一条 message 都要扫描该 session 的全部消息（EXPLAIN 证实走 `messages_history_idx` 的 `session_id=?` 范围扫描），删除含 N 条消息的 session 即 O(N²)，且全部在 Electron 主进程同步执行。

区域评审用真实 schema 实测：8000 条消息的 session 级联删除 **10022 ms**；补上 `CREATE INDEX … ON messages(replayed_from_message_id, session_id)` 后同操作 **62 ms**（约 160×，且随 N 平方增长）。

- 影响：删除长会话或删除含多会话的 project 时主进程冻结数秒至数十秒，单连接 write queue 上后续 DB 工作全部排队。计划文档把「SQLite 阻塞 main process」明确列为 P2 风险项（plan:761），此处与之相悖。
- 同类次要问题：`sessions.parent_session_id` 自引用 FK（`:25`）与 `sessions_clear_parent_before_delete` 触发器（`:42-48`）的子行查找同样无索引，project 级联时为 O(S²)。
- 建议：新增 `CREATE INDEX messages_replayed_from_idx ON messages(replayed_from_message_id, session_id)`，并为 `sessions(parent_session_id)` 加索引。P8 前开发库本就删除重建（plan:375），可直接改 `0001_initial.sql`。
- 复核状态：已对照 schema 确认 FK 与索引定义属实。

### H-2 跨 turn 重复 callId 在执行并提交后才被检测，committed history 永久中毒

`electron/session/canonical-history.ts:390-396` 的 `calls` 集合跨整个 active history 去重，但该校验只在 `compile()` 时运行。而 run 主循环顺序（已复核 `electron/session/session-run-controller.ts:442-517`）是：

```text
appendAssistantTurn (442)          ← 内存追加带 tool_calls 的 assistant turn（无任何 bounds/唯一性校验）
→ emit + logger.write (451-472)
→ executeToolCalls (508)           ← 工具已真实执行
→ commit('tool_batch') (517)       ← 已写入 durable
→ 下一轮迭代的 auto-compact / selectPromptMessages 才 compile 并抛 Duplicate tool call id
```

某些 OpenAI 兼容 provider 跨请求使用确定性 tool call id（如按索引生成）。一旦与历史 turn 撞 id：该 turn 已被执行并提交；此后每次 compile（provider call、auto/manual compact、重启后 reload）都失败；compact 自身也要先 compile，**durable session 无任何恢复路径**，内存与磁盘同时中毒。

- 建议：把 callId 全局唯一性检查前移到提交之前——`appendAssistantTurn` 时对 active history 既有 callId 预检（或在 adapter `complete()` / `executeToolCalls` 之前校验），失败直接终止 run，不执行工具、不提交。与 H-7 同根（校验晚于执行），可合并修复。
- 覆盖缺口：无 fixture 模拟 provider 返回与历史冲突的 callId；现有 `canonical-history.test.ts` 只测单 batch 内的缺失/重复/乱序。
- 复核状态：已确认去重逻辑位置与 run 循环提交顺序属实。

### H-3 裸 `/compact`（无 follow-up）经 durable `run:start` 必然报错，且 request ID 被污染

`electron/application/durable-run-application-service.ts:201-242`（已复核）：`#startLoaded` 等待 `beginRequest` 返回的 `commitPromise`，它只在携带该 `clientRequestId` 的 `user_input` 被提交时 resolve（`durable-execution-state-port.ts:173-187` 的 `#resolveCommittedRequests` 只认 `user_input` 记录）；同时与 `waitForRunSettled` 竞速，后者在 run 结束时抛 `PRECONDITION_FAILED: Run ended before its user message was committed`。

而裸 `/compact` 路径不 append 任何 `user_input`（`session-compact-coordinator.ts:210-252`：followUp 为空时直接 `commit({reason:'compact'})` 后返回；run-controller 随后 `finishRun('completed')`）。于是：

- compact epoch **已成功写入 SQLite** 并发布了 invalidate commit，但 `run:start` 向调用方抛 `PRECONDITION_FAILED`——成功的操作返回错误，契约自相矛盾；
- `new_session` 已在 `:86-94` 显式拒绝 `/compact`，`existing_session` 无防护；
- **重试语义（按 Codex 发现并复核修正）**：`SessionState.clientRequests`（`session-types.ts:169`）保存 `clientRequestId → runId` 且 run 结束后不清除，`startRun` 对同 ID 直接返回已 settle 的旧 runId（`session-run-controller.ts:95-99,161`）——因此**同 ID 重试会立即再次失败**（waitForRunSettled 对已结束 run 直接竞速胜出），直到 session 被 evict/reload；**换用新 ID 重试则会再跑一次完整 compact**。两种重试都不可接受。
- 建议：二选一——(a) compact 路径也为命令本身 append 带 `clientRequestId` 的 `user_input` 并随 compact 事务提交（审计轨迹完整，推荐，符合"user commit 先行"语义）；(b) execution-state port 支持按显式 request ID resolve 非 user-message commit（如直接等待 compact command），失败路径清除未持久化的 client request。需补「裸 `/compact` 返回 started + invalidate、重试幂等」的 target-runtime 回归。
- 覆盖缺口：durable 组合下裸 `/compact` 完全无测试（现有用例只测 `/compact focus on risks` 与 draft 拒绝）。
- 复核状态：两份评审独立发现；已核验收尾 race 结构与 `clientRequests` 缓存行为属实。

### H-4 并发 `new_session` 首次发送的失败者会误删获胜者的 durable binding

`electron/application/durable-run-application-service.ts:50-75,119-175` + `electron/session/session-manager.ts:296-298`（已复核）：`#requests` 只按 `sessionId + clientRequestId` 去重。同一候选 `sessionId`、不同 `clientRequestId` 的两次首次发送会同时通过 `#assertCandidateAvailable`（`:255-268`，仅查 DB，此时双方都未提交）。先到者 `createSession` 成功并 `registerNew(seed)` 注册 binding；后到者在 `SessionManager.createSession` 处收到 `CONFLICT 'Session already exists in the live registry'`。

问题在失败者的 catch（`:157-173`）：`lookupRequest` 未命中（获胜者尚未提交）、`created === false` 跳过 `closeSession`，但 **`this.#executionState.forget(input.sessionId)` 无条件执行**——删除的正是获胜者刚注册的 binding，并 reject 其全部 waiter（`durable-execution-state-port.ts:82-92`）。获胜者的 `commitPromise` 以 'Live Session context was evicted' 失败，其 catch 再 `closeSession` 收尾——**本应获胜的首次发送失败，两个调用方都收到错误**。

- 建议：对候选 Session 建立按 `sessionId` 的 single-flight/reservation；`closeSession()`/`forget()` 用所有权 token 限制为只能清理本调用创建的资源。补「两个不同 clientRequestId 并发同一候选 ID，一个成功、另一个稳定冲突且不影响成功者」的回归测试。
- 复核状态：已确认 `forget` 的无条件调用路径与 `createSession` 的 CONFLICT 分支属实。

### H-5 durable commit 失败后内存 canonical history 不回滚，失败记录事后变 durable 事实

`electron/application/durable-execution-state-port.ts:94-166` + `electron/session/session-run-controller.ts:382-396,442-517`（已复核）：执行路径先向 `session.history`/`nextMessageSeq`/metadata 写入，再调用 port 的 `commit`。若 SQLite/codec commit 失败，port 不推进 `binding.record`，但 run 的 catch（`:523` 起）只把 Run 标记为 failed——**不恢复内存 checkpoint，也不 evict/reload**。

后果链：

- 之后用**不同** request ID 启动的 Run 会把所有 `seq > binding.record.lastSeq` 的旧 records（`commit` 开头的 filter，`:99-101`）与新输入一起提交——原本已告知调用方失败的 user/assistant/tool batch 在事后变成 durable 事实；
- 若失败原因是确定性校验错误（如 H-7/M-9 的超限内容），之后每次 commit 都以同样方式失败，session durable 写路径永久卡死，无自动恢复；
- 原 request ID 因 `clientRequests` 缓存（见 H-3）无法安全重试；若失败发生在 `run_input` commit 之后、且旧 user 记录滞留内存，同 ID 重新 append 还会撞 `UNIQUE(session_id, client_request_id)`。
- 建议：每个 execution-state commit 前保存、失败时恢复完整 Session checkpoint（history、seq、mode、goal、plan、request map），或 commit 失败立即 closeSession 并从 SQLite 重载；同时清理失败的 request ID。补「run input / assistant turn / tool batch 三种注入持久化失败后，下一 Run 不提交旧记录」的回归。
- 复核状态：已确认 commit 失败路径无回滚、records filter 会捎带旧记录属实。

### H-6 lazy restore 不参与 Project/Session 生命周期保护，archive/update/remove 可与加载交错

`electron/application/live-session-context-registry.ts:35-43,65-70,111-135`（已复核）：`#load()` 在多个 `await`（getRecord、`Promise.all(projects.get, listActiveHistory)`、`restoreSession` 内含 PathGuard/MCP/logger 异步 IO）**之后**才把 Session 写入 `#projectBySession`（`:130`）。而 `assertProjectIdle` 只遍历 `#projectBySession`（`:65-70`），`assertSessionIdle` 也不感知 `#loading`——加载中的 Session 对两个 guard 完全隐形：

- **archive**：加载窗口内 `assertSessionIdle` 通过（`hasLiveSession` 尚为 false）→ DB 落 archived → `releaseSession` 全部清理落空（仅 `forget` 掉 `#load:123` 刚注册的 binding）→ 随后 `restoreSession` 完成、`#projectBySession.set`——留下一个 live 但已归档的 Session（后续 DB 写被 lifecycle 检查挡住，属 fail-safe，但 live context 残留至 dispose 且用户看到矛盾状态）；
- **Project path update/remove**：guard 通过后 DB 提交（remove 还会级联删除 session 行）→ restore 随后以旧 workspace 完成——留下一个对应行已被删除的 live Session；
- 建议：在第一次异步操作前为 loading Session 建立 project/session lease，archive、Project update/remove 与 run load/start 共用同一生命周期锁；`restoreSession` 成功后按 `binding.record` 复核 revision/lifecycle，`manager.startRun()` 前再次核对最新状态。补 deferred restore 期间调用 archive/path update/remove 的回归。
- 备注：主评审曾将其中 archive 子情形定为 Low；经复核 Codex 的版本覆盖面更全（含 project remove 级联删除），升级为 High 并合并。
- 复核状态：已确认 `#projectBySession` 登记时机、guard 数据来源与三条交错路径属实。

### H-7 不合法或超限的 Provider tool batch 在 durable 校验之前执行工具副作用

`electron/providers/deepseek-provider.ts:294-383`、`electron/session/canonical-history.ts:157-215`（`appendAssistantTurn`）、`electron/session/session-run-controller.ts:442-517`、`electron/persistence/message-codec.ts:39-45`、`shared/message.ts:322-324`（已复核）：

- SSE adapter 对累计 tool calls 的数量、参数大小、重复 call ID、text/reasoning 大小均不做 canonical schema/semantic 校验（providers 目录内唯一的上限是 SSE 单事件 4MB 与 catalog 上限）；
- `appendAssistantTurn` 直接构造 parts，无任何校验；
- run 循环先 `executeToolCalls`（**真实副作用**），`commit` 时才由 `encodeMessageRow` 的 `assertSchemaValue + assertMessageRecordSemantics` 首次校验。

具体可触发场景：provider 返回 257 个 tool calls（`assistant_turn.parts` 上限 `MAX_MESSAGE_PARTS = 256`，`shared/durable.ts:12`）、或两个不同 index 使用同一 call ID、或单条 arguments 超 JSON bounds——写入/命令工具已经执行完毕，commit 才抛错，随后落入 H-5 的未回滚污染状态，且没有可恢复的 assistant/tool audit batch。

- 建议：在 Provider completed 边界将 turn canonicalize 并按 durable schema、总字节数和唯一 call ID 校验，任何 tool execution 之前拒绝非法/超限结果；SSE accumulation 阶段同样限制 call 数与字节数。补 257 calls、重复 call ID、超长 arguments 的「无副作用」回归（断言未执行任何工具）。
- 复核状态：已确认 adapter/`appendAssistantTurn` 无校验、codec 校验位于 commit 路径、`MAX_MESSAGE_PARTS=256` 属实。

---

## 5. Medium 级发现

### M-1 reasoning-only / 空 content 的合法 completion 被 `complete()` 误判为错误

`electron/providers/chat-completions-adapter.ts:345-357`（已复核）：

```ts
const parts: MessagePart[] = []
if (turn.content) parts.push({ type: 'text', text: turn.content })
for (const call of event.toolCalls) { parts.push(...) }
if (parts.length === 0) {
  throw new TypeError('Provider completed with an empty assistant turn')
}
```

`MessagePart` 只有 `text | tool_call | tool_result`，reasoning 不进 parts。DeepSeek reasoning 模型在 thinking 阶段耗尽 token（`finish_reason: 'length'`、只流出 `reasoning_content`、content 为空、无 tool_calls）是真实场景；此时 `complete()` 抛错，整个 Run 以 confusing error 失败，已流给 UI 的 reasoning 也不落 canonical 记录。重构前旧路径会以空答案正常收尾，属行为回退。

- 建议：`parts.length === 0 && reasoning_content` 时生成带 `normalizedReasoningText` 的合法收尾（或以空 text 占位），仅在既无 content 又无 reasoning 又无 toolCalls 时抛错；补该路径测试。

### M-2 assistant tool-call turn 的 append 与 batch 执行之间存在可失败的 await 窗口

`session-run-controller.ts:442` append 之后、`:508` `executeToolCalls` 之前，当 turn 含 text/reasoning 时有 `this.#emit` 与 `await session.logger.write`（`:451-472`，已复核）。`JsonlTraceLogger.write` 在既往 IO 失败/closing 时会抛；eventSink 同步抛错同理。一旦抛出，run 的 catch 直接结束 run，内存 history 停留在「assistant_turn 带 tool_calls、无 terminal results」状态；之后该 session 每次 compile 都抛 `Canonical history ends inside a tool batch`（`canonical-history.ts:398-400`），后续所有 run 必败，直到 session 被 evict 重载。

- 影响：仅内存受损（durable 干净），但无自动恢复，用户表现为「session 永久报错」。
- 建议：把 `appendAssistantTurn` 移到 emit/log 之后、紧贴 `executeToolCalls`（窗口内不再有 await）；或在 `#run` catch 里为未闭合 batch 补 synthetic cancelled results。

### M-3 execution port 缺 per-session 串行化，metadata commit 与 run commit 可交错破坏一致性

`electron/session/session-manager.ts:490,547` + `electron/application/durable-execution-state-port.ts:94-166`：`updateSessionMode`/`updatePlanStatus` 在 run 环之外调用 `commit({reason:'metadata'})`，入口检查 `session.activeRun` 后有多个 `await` 才到达 commit。窗口内 `startRun` 可启动 run，两个 commit 共用同一个可变 `SessionState` 与 `binding.record`：

- 坏交错：run 的 `run_input` commit 先成功（把 updateSessionMode 已 append 进共享 history 的 runtime-context 记录一起提交），随后 updateSessionMode 的 commit 收到 `CONFLICT`，其回滚逻辑**把已被 run 提交到 DB 的记录从内存 history 删除并回退 `nextMessageSeq`**。此后 seq 与 DB `lastSeq` 错位，`assertAppendBatch` 永远失败，该 session 的 durable 写路径卡死，直到 evict 重载才自愈。
- 反向交错则 run 以虚假 `CONFLICT` 失败；`updatePlanStatus` 回滚 `session.plan` 还会导致下次 run commit 用旧 plan 覆盖 DB 新值（用户改动被静默回滚）。

- 建议：port 内对同一 sessionId 的 `commit` 串行化（promise 链），或由 run 环独占 commit、metadata 变更排队到 run 边界；至少 port.commit 失败时不要回滚可能已被他人提交的共享 history。
- 备注：desktop 默认 composition 未接 `executionState`，该竞态仅在 P4 target composition（及未来 P8 接线）中存在。

### M-4 `SessionService.update`/`archive` 的 post-commit 动作可抛错，造成"已提交却报错"撕裂与静默回滚

`electron/application/session-service.ts:337,373` + `electron/application/live-session-context-registry.ts:76-81`：

- `update`：commit 成功后 `applySessionRecord` → `applyDurableSessionRecord` 在 run 恰好于间隙启动时抛 `CONFLICT`；调用方看到失败但 DB 已提交。且 `applySessionRecord` 先 `registerExisting` 再更新 manager——binding 已刷新、manager 内存仍是旧 metadata，下次 run commit（port 每次必带 metadata）会把 DB 新值**静默写回旧值**。
- `archive`：commit 后 `releaseSession` 重新 `assertSessionIdle`，间隙启动的 run 使 archive 抛 `CONFLICT`（DB 已 archived；重试又报 'Session is already archived'）。DB 侧有 lifecycle 检查 fail-safe，问题在错误语义与被跳过的资源释放。
- 建议：post-commit 的 release/apply 失败不应向上抛（诊断 + 后台重试/延迟驱逐），或在 commit 同一临界区内完成 idle 断言与状态应用。

### M-5 `PersistenceTransaction.exec()` 允许事务控制语句，可造成"假失败真提交"

`electron/persistence/database-service.ts:53-60` 的 `exec` 透传任意 SQL。在 `withTransaction` 的 work 回调内执行 `exec('COMMIT')` 时（区域评审实测）：事务被提前提交，`withTransaction` 末尾的 `COMMIT` 抛 `cannot commit - no transaction is active`（归一化为 `DATABASE_ERROR`），调用方看到失败但数据已落库。同理 `ROLLBACK`/`SAVEPOINT`/`RELEASE`/`VACUUM` 均可绕过原子性。

- 影响：直接打破「失败事务 ⇒ 无提交」这一核心假设——coordinator 只在 `withTransaction` 成功后发布事件，此场景 DB 已改而事件未发，renderer 与持久化状态永久分叉。目前仅测试用 `exec` 建表，属潜在 footgun 而非现存 bug。
- 建议：`PersistenceTransaction.exec` 拒绝事务控制语句（正则拦截 `begin|commit|rollback|savepoint|release|vacuum`）。

### M-6 更高版本（未来）配置同样被静默删除重建，且无备份

`electron/config/store.ts:581-586`（已复核）：

```ts
if (error instanceof UnsupportedConfigSchemaError) {
  await rm(this.#filePath, { force: true })
  const defaults = migrateConfig(undefined)
  await writeJsonAtomic(this.#filePath, defaults)
```

`migrateConfig` 对任何 `schemaVersion !== 9` 都抛 `UnsupportedConfigSchemaError`（含 `> 9`；`store.test.ts:316-326` 固定了 v99 也被重置）。影响：

- 用户用更新版本（v10 配置）后回退到本 build，全部配置（providers、MCP servers、remembered permission rules、privacy notices）被不可逆清空；对更高版本的惯例是拒绝启动而非销毁数据；
- 手写的 v9 配置仅一个字段校验失败也会触发整文件清空，爆炸半径与错误严重度不成比例；
- 删除前不保留 `.bak` 副本，无任何恢复途径；
- 附带问题：重置不触碰 `#secretStore`，旧 `apiKeyRef` 指向的条目成为孤儿永远留在 `secrets.json`——用户感知"凭据已清除"但凭据仍在磁盘。

- 建议：区分 `schemaVersion > 9`（拒绝并保留文件）与 `< 9`/校验失败（重置）；至少在 `rm` 前复制 `config.json.v9-reset.bak`；重置时 best-effort 清理孤儿 secret 或在文档中显式说明。属设计决策，需在计划文档中记录该权衡。

### M-7 `sqlite-smoke.cjs --packaged` 在非 Windows fresh 环境报错而非文档承诺的 skip

`scripts/sqlite-smoke.cjs:105-121`（已复核）：`runElectronChild()` 先执行 `packagedElectronPath()`（内部 `readdirSync(release/<version>/win-unpacked)`，缺目录即抛 ENOENT），**之后**才做 `process.platform !== 'win32'` 的 skip 判断。非 Windows 主机上若无打包产物（fresh checkout、未先跑 electron-builder），进程以非零码崩溃并打印 stack trace，而不是 `SQLITE_SKIP`。

- 影响：违反 AGENTS.md 声明的 "non-Windows hosts report an explicit skip"。`npm run build` 流程内因 electron-builder 刚产出产物而不触发（本机也因 `release/0.2.3/win-unpacked` 存在而被掩盖）；开发者独立运行 `npm run test:sqlite:packaged` 时 CI 信号被污染。
- 建议：把平台判断移到路径解析之前；补无 release 目录的非 Windows smoke 测试。

### M-8 第 513 个 Project 会成功写库但从所有 full-list API 结果中消失

`electron/persistence/project-repository.ts:73-82`、`electron/application/project-service.ts:67-93`、`shared/domain-state-api.ts:52-60,481-496`（已复核）：repository 的 `list` 固定 `LIMIT MAX_PROJECT_RECORDS`（512），`add` 没有容量检查，插入后仍只返回截断列表。第 513 个 Project 的服务端生成 ID 不在 command result、commit event 或 bootstrap 中；domain-state API 只有 `project:list/add/update/remove`，**没有 pagination 或 project:get**（`ProjectService.get` 仅内部使用），调用方无法获得该 ID 来 update/remove。数据库永久保有 API 不可见的记录。

- 建议：在同一 transaction 中计数并拒绝超过 512 的新增（推荐，符合有界契约），或提供分页/created-record 增量结果。补 512/513 边界与原子性测试。
- 备注：触发需 512+ projects，无数据丢失，故定 Medium（Codex 定为 P1，理由是命令结果不完整）；但一旦触发无任何 API 恢复路径。

### M-9 合法附件组合可在写库时超过单 Message text 上限，并触发 H-5 污染路径

`shared/context.ts:39-44`、`electron/config/schema.ts:129-146`、`electron/session/session-user-turn-preparer.ts:117-145`、`shared/message.ts:64-69`、`shared/durable.ts:13`（已复核）：RunContext 最多允许 32 个附件；默认每文件输出上限 `readFileOutputBytes = 64 KiB`（配置允许提高），全部拼进**一个** `selected_context` text part；`TextPart.text` 上限 `MAX_MESSAGE_TEXT_LENGTH = 1,000,000` 字符。约 16 个默认大小文件（32 × 64 KiB ≈ 2 MB）即可超限。错误直到 Session 已 append context/user 后才在 codec commit 处出现，随后落入 H-5 的未回滚状态。

- 建议：在收集 context 或 append 前实施聚合 durable byte/character 上限（或拆分为多个受限 records）；补最大附件数/大小组合的回归。
- 备注：用户经正常 UI 操作即可到达（选中多个大文件），故定 Medium；与 H-5 合并修复后实际危害消除。

---

## 6. Low 级发现（按区域归并）

**providers**

- 无 hook 的正常路径也可能触发 "beforeLLMCall hook exceeded the model context budget"：`session-provider-turn.ts:236-243` 对完整 wire body 再估一次预算，body 多出 `model`/`stream`/`thinking` 等字段约 40 token；selection 估值落在 `(budget-40, budget]` 区间时未装插件的 Run 也会失败且错误归因于 hook。建议无 patches 时跳过或将口径对齐 `{messages, tools}`。
- 流干净 EOF 但无 `finish_reason`/`[DONE]` 时被归一化为 `'completed'`（`deepseek-provider.ts:379-396`、`chat-completions-adapter.ts:273-275`）：代理半路干净关闭连接时截断响应会被当作完整 turn 提交。重构前行为相同，但 P3 已引入 finishReason 跟踪，本可识别缺失终止标记。
- `normalizeLlmUsage` 的 `model` 取 `binding.provider.model`（全局默认），而实际请求模型是 `binding.snapshot.model`（session pinned），usage 记录的模型名可能错（`electron/providers/usage.ts:48`；对照 `session-tool-runner.ts:171-176` approval 路径已显式用 snapshot.model 覆盖）。

**shared / config**

- Session commit 未在服务层强制 512 条 message envelope 上限（Codex P2-1）：`commitFirstTurn`/`commitMutation` 只验证连续 seq/active，`messageChange.upsert.records` 契约上限 `MAX_COMMIT_MESSAGE_RECORDS = 512` 无服务层检查（`session-service.ts:216-244,264-321`）。**可达性说明**：当前真实路径单批最大约 257 条（1 assistant + 256 tool parts），天然低于上限，故定 Low；但契约缺口存在——若未来路径超限，会生成无法通过 P6 IPC schema 的 commit，在数据库已提交后才失败。建议在两个写入口于 transaction 前拒绝第 513 条，或将超大变化转为 `invalidate`。
- `config.json` 为合法 JSON `null` 时不会被自愈写回（Codex P2-4）：`migrateConfig(null)` 返回内存默认值而不抛错（`migrations.ts:25-28`），`#read`（`store.ts:565-568`）因此不写回默认文件；每次启动重读无效的 `null`，磁盘配置在用户下次写入前始终不是 v9。建议仅把 `undefined` 视为文件不存在，把 `null` 当作不支持的 root 走删除/重建分支。
- credential query key 黑名单漏 `key`（Gemini 风格 `?key=…`）、`auth`、`sig`（`shared/model-route.ts:39-40`）。当前唯一构造 endpoint 的 `resolveChatCompletionsEndpoint` 用相对解析丢弃 baseURL query，现时可达泄露路径很窄；属纵深防御缺口。建议注释明确 best-effort 定位或收紧策略。
- `runtime-state.ts:35,52` 两个 date-time 字段无 `maxLength`，是 runtime-state 契约中仅有的无界字符串，与「payload 全部有界」不一致。建议复用 `DateTimeSchema`。
- `MessageMetadataV1Schema` 导出 union 无判别字段且分支歧义（`shared/message.ts:267-275`）；当前无验证边界使用它，建议注释或收窄以防未来误用。
- provider `revision` 在 delete/recreate 同 id 后从 1 重启，非严格单调（`electron/config/store.ts:41,399`）；`getProviderApiKeyForRevision` 校验存在极窄的巧合通过窗口。建议至少注释说明"id 生命周期内单调"语义。
- `ProviderAutoApprover.evaluate` 中 adapter 编译在 try 之外（`electron/permission/auto-approver.ts:121-165`）：compile 抛错时 timer 与 abort listener 泄漏（listener 随失败累积，可触发 `MaxListenersExceededWarning`）；fail-closed 方向正确。建议把注册移到 compile 之后。

**persistence**

- `FileChangeRepository.update` 不重新执行聚合 retention（`file-change-repository.ts:118-156`）：增大 payload 的 update 可让全表超预算，要到下一次 insert 才恢复。
- 时间戳归一化只在 session-codec 做，project/message/file-change codec 直接透传（`session-codec.ts:63-67` 对比 `project-codec.ts:42-43` 等）：非 UTC 偏移时间会破坏 TEXT 字典序排序与 retention 驱逐顺序。当前生产者全部 `toISOString()`，属潜在风险。
- `listThrough` 硬编码 513 上限（`message-repository.ts:84`）：fork 点 ≤512 但其 tool batch 的 terminal results 落在 seq >513 时，合法 fork 被 `PRECONDITION_FAILED` 拒绝（失败方向安全但行为不正确）；常量与 `MAX_FORK_MESSAGE_RECORDS` 的关系应显式命名。

**application**

- `#startNew` 失败路径泄漏 registry 的 project 映射（`durable-run-application-service.ts:154-174`）；同一 catch 中 dedupe 命中时直接 return，跳过 `closeSession` + `forget` 清理（`:157-174`）。
- fork 标题未截断：源 title 可达 256 字符，`Fork: ${source.title}` 拼接后超 DB CHECK → `CONFLICT`，长标题源 session 永远 fork 失败且报错误导（`session-service.ts:489`）。建议 `.slice(0, 256)`。
- 服务层输入校验缺失：`title/name` trim 后为空串被 DB CHECK 拦为 `CONFLICT`（误报冲突），`search` trim 后为空抛 `CODEC_INVALID`→`PERSISTENCE_FAILURE`（误报存储故障）；应服务层显式校验抛 `PRECONDITION_FAILED`（`session-service.ts:603`、`project-service.ts:120`、`application-error.ts:33-45`）。
- `ProjectService.update` 路径变更后的驱逐同样存在 post-commit 撕裂；patch.path 与现值相同也会全量驱逐该项目 live session（`project-service.ts:130-133,157`）。
- 发布循环中单个 listener 抛错阻断后续 listener（`create-durable-target-runtime.ts:79-81`）：错误仅进 onDiagnostic，命令仍返回成功，部分订阅方永久丢该 commit。建议循环内逐个 try/catch。
- target 构造在 `try` 之前打开数据库：`ownsDirectory` 时 `DatabaseService.open` 抛错泄漏 mkdtemp 目录（`create-durable-target-runtime.ts:66-75`）。

**session**

- `closeSession` 取消宽限超时后 zombie run 仍可能在 session closed 后提交 durable（`session-manager.ts:570-583` + `session-run-controller.ts:517`）：数据本身一致，但与「closed 后不再变更」的直觉及 archive idle 前置存在潜在竞态，应文档化或在 port 侧拒绝。
- 纯 `/compact` 的 trace 只有 `run.end` 没有 `run.start`（`session-run-controller.ts:335-338` 在 `:398-402` 写 run.start 前 return），trace 不对称。

**infra / docs / benchmark**

- Prompt Inspector 删除一列后未同步 CSS grid（Codex P2-5）：`LoggingSettingsPanel.vue:245-251` 现有 5 个 grid children（kind/source/messageId/tokens/hash），`settings-content.css:287-305` 仍定义 6 列——`source` 落在 48px 的旧 role 列、token 文本落在另一个 48px 列且末尾保留空白列，两项信息在正常窗口宽度下被省略号截断。建议 grid 改为与 5 列对应并加组件/视觉回归测试。
- `docs/architecture.md` 对 P4 状态自相矛盾（Codex P3-1）：`:162` 仍称"这是 P3 完成后的真实布局"、P4 文件"尚未存在"；`§3.4 :188-193` 以现在时描述 Desktop 使用 `userData/agent.db`、Headless 使用临时 SQLite；而 `§20 :1490-1492` 正确说明 P4 target 仅用于 unit/integration 测试、尚未接入 production composition。读者无法据此判断当前运行时事实。建议按「当前实现 / 目标架构」明确分节，更新前部表述。
- `AGENTS.md` 的 `npm run build` 描述未随脚本改动更新（build 现已串入 `test:sqlite` 与 `test:sqlite:packaged`）。
- `benchmarks/runner/runner.ts:863-867` 的 `maxStepsPerRun` 0=unlimited 封顶逻辑与 `benchmarks/worker/coordinator.ts:191` 的 `MAX_PROVIDER_REQUESTS || 32` 回退均无测试（后者是 config v9 下的必要修复，建议补断言防回归）。

## 7. Info 级记录（设计决策确认项）

- **trace v2 / config v9 是有意的破坏性升级**：旧 trace 在 reader/replay 处以 "requires trace v2" 显式失败，旧配置删除重建，均有测试固定。提示产品侧确认「用户历史 trace 不可读/replay」可接受。
- `ProviderContinuationEnvelope.adapterId/format` 为自由字符串而非闭集：判断为有意前向兼容（旧 DB 行在 adapter 移除后仍可 decode），标记供确认。
- node:sqlite 读取超 2^53 的 INTEGER 抛原生 `RangeError`，绕过 `normalizePersistenceError` 归一化（仅能由外部篡改产生）；可在 codec 读取路径捕获映射。
- `createTestDatabase` 在 `open` 抛错时泄漏 mkdtemp 目录（仅测试设施）；两进程并发首开同一 DB 时后提交者得到 `MIGRATION_FAILED` 而非重读跳过（当前单实例不触发）。
- `sessions.update` 的 lastSeq 守卫只保证 `>= MAX(messages.seq)`，不与旧值比较；「prevents lastSeq regression」的注释略强于实际语义。
- `listActiveHistory` 无 LIMIT（`message-repository.ts:159-172`）：超长会话内存占用无界，当前属设计选择。
- transport timeout 与外部 abort 同时发生时错误码偏向 `TIMED_OUT`（Run 层终态仍正确）；生产路径 transport 无墙钟超时（与重构前一致，挂起连接只能等用户取消）。
- 环境变量 credential 漂移不受 revision 保护（`store.ts:207-222`），freeze 校验无法察觉，属固有局限。
- 架构边界测试未覆盖「Provider Adapter 不访问 repository」反方向，也未拦截 persistence 导入 electron/vue（计划不变量要求）；shared 边界扫描本身正确。建议补规则。
- runtime parity 两处归一化豁免（orchestrator prompt 层不参与 traceRequests 对比但 wire messages 仍逐条对比；`sourceHash` 用归一化后 layers 重算）经评估可接受，记录备查。
- 旧版 trace 的 replay 错误以裸 Error 穿透 IPC，renderer 收到未分类错误；可包装为 `INVALID_TRACE`。
- sqlite-smoke 子进程继承完整 `process.env`（含 `DEEPSEEK_API_KEY` 等）：本地无外发风险极小，但与 AGENTS.md「credentials 不进子进程环境」的原则性要求有出入。
- 错误类型双轨：manager 路径抛 `IpcFault`、application 层抛 `ApplicationError`，`runs.start` 调用方需识别两种 code 载体；过渡期可接受。
- durable 测试默认 5s 超时在高负载机器上偶发失败（放宽至 30s 后稳定通过）；套件对慢机器偏脆。

## 8. 测试覆盖缺口（重点）

两轮评审共同指出：现有全绿测试未覆盖跨异步边界的竞态与失败注入场景。优先补充：

- **H-2**：跨 turn 重复 callId 的永久中毒路径完全无覆盖。
- **H-3**：durable 组合下裸 `/compact`（existing session）无测试——需断言「返回 started + invalidate、同 ID 重试幂等」；interjection commit 与 auto-compact（`commit:true`）在 durable 组合下亦未覆盖。
- **H-4**：两个不同 clientRequestId 并发同一候选 sessionId 的首发竞态无测试。
- **H-5**：run input / assistant turn / tool batch 三种 commit 失败注入后「下一 Run 不提交旧记录」无测试。
- **H-6**：deferred restore 期间调用 archive / Project path update / remove 的交错无测试；registry 并发 `ensureLoaded` 去重、`restoreSession` 失败后 `forget` 清理、`evictIdleProject`、`dispose` 跳过 active-run session 均无直接单测。
- **H-7**：257 calls、重复 call ID、超长 arguments 的「未执行任何工具即拒绝」无副作用回归。
- **M-1**：reasoning-only completion 路径无测试；「无 `[DONE]`/无 `finish_reason` 干净 EOF」行为无测试；stream 中途 abort/网络错误「不发 completed」无 provider 级测试。
- **M-2**：append 后、batch 执行前 logger 失败导致内存 batch 悬挂无测试。
- **M-3**：durable 组合下 `updateSessionMode`/`updatePlanStatus` 经 port 的 metadata commit 无任何测试，与并发 run 的交错更无覆盖。
- **M-4**：archive 后 releaseSession 失败、update 后 applySessionRecord 失败的行为无测试。
- **M-5**：`exec('COMMIT')` 滥用无防护也无测试。
- **M-6**：配置重置后的 secret-store 状态无任何断言；`getProviderApiKeyForRevision` 无直接单测（仅 mock 形式出现在 resolver 测试）。
- **M-8**：Project 512/513 边界与「add 结果含新 record」原子性无测试。
- **M-9**：最大附件数 × 最大单文件大小的聚合超限无回归。
- **其他**：null config 初始化与重启；非 Windows 无 release 目录的 smoke skip；retention 单条超限「不驱逐任何既有行」缺事务级测试（plan 6.4 明确要求）；session `listPage` 游标平局分支；`close()` 排空在途写事务；project 级联 × 父子 session 链（含孙代）；`assertModelRouteSnapshotSafe` 的 fragment 拒绝/仅 password userinfo；`ProjectUpdatePatchSchema` 等 schema 的 round-trip/拒绝；`DomainStateEventSchema` 的 topic/change 错配拒绝；durable 组合下 cancellation 语义（user commit 后留未回答 user message、不伪造 interrupted assistant，plan §8.5 明确要求）；「流式期间 DB 无 partial record」在 provider 阻塞中途断言；fork 边角（fork 点位于 compact summary 之前的 `inHistory` 重算、长标题、archived 源、replay 记录 fork 点拒绝）。

## 9. 计划不变量落实评估（核查通过项）

以下为本次评审逐条走查确认**已正确落实**的关键不变量，作为对照记录：

- **事务边界符合 plan §8.4**：`run_input` commit 在 provider 循环之前（有测试断言 `session.commit` 先于 `provider`）；容量预留（run slot/writer lease）在 commit 之前；BEGIN IMMEDIATE 在串行写队列内、work 之前；异步 work 被拒绝并回滚；事务内无网络/工具/文件 IO。
- **tool batch 原子性**：任何未完成 call 在重抛前补齐 synthetic terminal result（ok/denied/cancelled/timed_out/validation failure 均成 terminal）；assistant + ordered results 同事务；无 assistant 半链。
- **事件语义**：失败事务零发布；成功命令恰好发布一次；envelope 深冻结、sequence 单调；coordinator 队列出错不破坏后续任务，无重入/死锁。
- **去重**：DB 层 `UNIQUE(session_id, client_request_id)` + requestHash 比对、同进程 promise 缓存（有界 1000）、重启后 `lookupRequest` 命中返回 deduplicated，均有测试。
- **并发安全**：revision 乐观锁（`WHERE revision=?` + 恰好 +1 断言）、`UNIQUE(session_id, seq)` 兜底、expectedLastSeq 服务层断言。
- **Compiler 完备性**：空 history 拒绝、单 session、seq 严格递增、id 唯一、单 compact_summary、boundary 正反两向校验、tool_result 按 callId 顺序紧跟 assistant turn、batch 未闭合拒绝。
- **compact 重建顺序**与 plan:377 一致（auto = system → harness* → root user replay → summary；manual follow-up = system → harness* → summary → new user）；多次 compact 下 `replayedFromMessageId` 始终指向原始 user id；内存回滚覆盖所有失败分支。
- **P0 golden 等价性**：fixtures 与 golden test 自 P0 提交到 HEAD 逐字节未变，`toEqual` 严格断言，非宽松忽略。
- **SSE 边界**：跨 chunk 分割、多行 data 拼接、注释行、`[DONE]` 尾随空白、4MB 事件上限、无效 JSON 拒绝，均有实现和测试。
- **credential 卫生**：apiKey 只进 authorization header；trace 全路径 `redactJsonSecrets`；endpoint 安全校验先于 credential 读取；`beforeLLMCall` 有深拷贝 + protected 字段相等校验 + credential-key 注入扫描。
- **route 冻结**：Run 启动时一次性 resolve 三条 purpose route；credential 按 `(providerId, revision)` 钉住；「修改全局 config 不影响已开始 Run」有集成测试。
- **context budget**：旧的静默 drop 已删除，超预算显式抛 `ContextBudgetError`，符合「不再静默裁剪 active turns」。
- **migration**：bootstrap 幂等、checksum 不匹配/高版本/断档/单步回滚均正确有测试；`.gitattributes` 固定 SQL 文件 LF，checksum 跨平台稳定。
- **架构边界**：shared 不导入 Node/Electron/Vue、persistence 不导入 providers、Core 无 wire DTO 字段（`ProviderMessage`/`reasoning_content`/`tool_calls` 等）均有扫描测试；trace fork 功能与 `selectContextMessages` 等删除后全仓零残留。
- **删除一致性**：renderer traces store fork 删除无残留；e2e fixture 与 trace v2/config v9 schema 严格匹配；`maxStepsPerRun=0` 语义在 UI/schema/默认/runtime/runner 五处一致；benchmark cases 排除为单文件精确路径，未误伤其余 12 个 benchmark 测试文件。
- **docs 抽查**：architecture.md 关于 trace v1 拒绝、config v9 重置、`electron/application/` 仅测试使用（§20）、benchmark 退出门禁等声明均与代码相符（§3 前部表述矛盾见 Low 级 docs 项）。

## 10. 建议处理顺序

1. **P5 开工前（结构性问题，越晚修成本越高）**：H-1（加索引，直接改 `0001_initial.sql`）、H-2 + H-7（校验前移到执行/提交之前，同根可合并修）、H-3（裸 `/compact` 契约修正，直接阻塞 P6 `run:start` 契约）、H-5（commit 失败回滚/重载策略，是 H-2/H-7/M-9 的共同放大器）。
2. **P6/P8 接线前必须修**：H-4（首发 single-flight 与所有权清理）、H-6（loading 生命周期锁）、M-2、M-3、M-4（durable 组合并发/撕裂，接通真实 IPC 后直接暴露）、M-6（配置重置策略需产品决策并文档化）。
3. **随手修**：M-1（reasoning-only completion）、M-5（exec 拦截）、M-7（smoke skip 顺序）、M-8（add 计数拒绝）、M-9（附件聚合上限）及各 Low 级服务层校验、fork 标题截断、CSS grid、文档矛盾。
4. **补测试**：优先第 8 节列出的 H-2/H-3/H-4/H-5/H-6/H-7 回归用例，其次 durable 组合取消语义、partial record 断言、M-8/M-9 边界与 fork 边角。
