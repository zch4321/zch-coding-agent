# Codex 当前分支 Code Review 报告

> 审查日期：2026-07-25
>
> 分支：`refactor/backend-state-v2`（HEAD `58ad8d9`）
>
> 对比基线：`master` 的 merge-base `6cb4a0819734ce68166635a82422872011a21b1b`
>
> 变更范围：50 个提交、241 个文件、`+28099/-13249` 行
> 范围：完整审阅 `master...HEAD`，重点复核 durable backend 切流、SQLite 持久化、Session/Project 生命周期、FileChange 回退、IPC/renderer replica 和分页路径。

---

## 结论

当前分支完成了从 Workbench snapshot 到 SQLite-backed durable state 的大规模切流，跨进程契约、sender 校验、SQLite schema/codec、runtime ownership 和 event cursor 的总体方向是正确的；`typecheck`、lint、SQLite smoke 均通过。

不过，当前 HEAD 仍有 **3 个 High、3 个 Medium、1 个 Low** 的未接受问题。其中最需要优先处理的是：

1. Project 重关联后，旧 FileChange 可以把原 workspace 的回退内容写入新的无关 workspace。
2. Session、Message 和 FileChange 虽然已有 cursor API，但 renderer 没有把分页接入 UI；到达 200 条后，历史记录会静默不可访问。
3. tool-batch durable commit 失败后的会话 teardown 存在竞态，失败完成后立即重试会偶发被拒绝。

在 High 问题修复并补齐回归前，不建议将此分支作为 durable backend 的生产切换基线。

## 审查与验证方法

- 审阅 `git diff master...HEAD`、提交历史、shared contract、main/preload/IPC、application/persistence/session/file-change、renderer stores 与相关 E2E/unit tests。
- 对每个下列发现复核了实际调用链、状态机与相关 schema，而非只根据静态模式判断。
- 交叉核对 `docs/architecture.md`、`docs/backend-refactor-plan.md`、`docs/requirements.md` 和 `docs/decision-log.md`，将已明确接受的风险与未接受缺陷区分开。

| 检查 | 结果 |
| --- | --- |
| `git diff --check master...HEAD` | 通过 |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm run test:sqlite` | 通过（Node 26.3.0 / Electron 42.4.0） |
| `npm test` | 首次 1/696 测试失败，第二次 688 通过、8 跳过；失败与 M-3 的 timing race 一致，详见下文 |
| 聚焦 tool-batch recovery 测试 | 连续 5 次通过；这说明窗口较窄，但不消除首次全量运行揭示的竞态 |

本轮未运行真实 provider 测试，也未运行完整 Electron E2E；二者不影响下列静态调用链和确定性 unit-test 结论，但应在修复后补跑。

## 发现汇总

| ID | 严重度 | 区域 | 摘要 |
| --- | --- | --- | --- |
| H-1 | High | FileChange / Project | Project path 重关联后，旧回退记录可改写新的无关 workspace |
| H-2 | High | Renderer replica | 201 条及更旧的 Session 无法在 Sidebar 打开，搜索也无法救援 |
| H-3 | High | Timeline | 超过 200 条 Message 的早期对话静默不可见、不可操作 |
| M-1 | Medium | FileChange UI | 超过 200 条 FileChange 无法继续加载或回退 |
| M-2 | Medium | Project service | 第 513 个 Project 会写入 SQLite，却从所有可发现 API/界面消失 |
| M-3 | Medium | Lifecycle recovery | tool-batch commit 失败后的 teardown 与下一次 start 存在竞态 |
| L-1 | Low | Persistence API | `PersistenceTransaction.exec()` 可提前结束外层事务，破坏“失败即无提交/无事件”不变量 |

## High

### H-1：Project 重关联可将旧 FileChange 回退到无关 workspace

`ProjectService.update()` 允许用户将 idle Project 重关联到新的规范路径（`electron/application/project-service.ts:103-168`）；这也是需求明确支持的“移动目录后重新关联”（`docs/requirements.md:180`）。但是 FileChange 记录只保存相对路径、hash 和回退内容，未保存创建时的 workspace identity（`electron/application/file-change-service.ts:112-180`、`electron/persistence/file-change-codec.ts:27-87`）。

回退时，`#readRevertTarget()` 从 **当前** Project 读取 workspace（`electron/application/file-change-service.ts:442-485`），随后 `restoreFileContent()` 在该路径执行写入/删除（`:355-363`）。因此其 after-hash 检查只证明“新目录里恰好有相同 after 内容”，不能证明目标仍是原来的文件。

可复现路径：

1. 在 workspace A 中记录 `note.txt` 从 `before` 变为 `after` 的 FileChange。
2. 将同一 Project 的 path 更新为无关的 workspace B。
3. 在 B 中创建内容同为 `after` 的 `note.txt`。
4. 调用 `file-change:revert`；hash 校验通过，B 中的文件被恢复为 A 的 `before`，或在 create-file 场景被删除。

这不是已接受的 FC-1 外部 TOCTOU 风险，也不需要数据库篡改或时间竞态。它会静默改写用户已重关联到的另一目录。

建议：在 `file_changes` 的 backend-private record 中持久化创建时的 workspace path 和可靠目录 identity/fingerprint；普通 Project path update 后只要 identity 不匹配就拒绝回退。若产品要支持“目录真实移动后仍可回退”，应引入显式、可验证的 FileChange migration，而不是把普通 Project 重关联视为自动迁移。短期安全方案是 path 变更时将旧 FileChange 标为不可回退。补充 A→B、B 中预置相同 after hash、必须拒绝且 B 不变的集成回归。

### H-2：Session 分页 API 未接入 renderer，旧会话不可打开

backend bootstrap 只读取并返回最近 200 条 Session summary，且丢弃 repository 的 `hasMore/nextBefore`（`electron/application/create-backend-runtime.ts:204-216`）。Repository 本身实现了稳定 cursor 分页（`electron/persistence/session-repository.ts:127-191`），并且 `session:list` 已通过 IPC 暴露（`shared/domain-state-api.ts:282-300`、`electron/ipc/app-handlers.ts:239-248`）。

但 renderer 的 `bootstrap()` 只覆盖一次 `sessions` 副本（`src/stores/agent-replica.ts:77-113`），该 store 中没有任何 `api.listSessions()` 调用；`selectSession()` 又要求 id 已存在于这个至多 200 条的数组，否则直接返回 `false`（`:126-134`）。搜索结果也不能补救：`ProjectSidebar` 把 hit 再从已加载的 `agent.conversations` 查找，未加载 hit 会被过滤掉（`src/components/projects/ProjectSidebar.vue:66-81`）。

重启后若有 201+ 个 Session，或者最近 200 个均已 archive，较旧的 active Session 不会显示，也无法从搜索结果打开。持久化数据仍在 SQLite，但正常 UI/API 流程不可达。这与设计文档“bootstrap 只给最近 Sessions、分页/搜索/按需加载走 query”的约定相悖（`docs/backend-refactor-plan.md:545,568,613-615`）。

建议：让 bootstrap 返回 `SessionPage` 元数据并按 Project 维护 cursor，或在 Sidebar 按需调用 `session:list`；至少搜索命中应 upsert `hit.session`，而 `selectSession()` 应能回退到 `session:get`。补 201/401 条 Session、200 条 archived、重启后搜索并打开旧会话的 renderer/E2E 覆盖。

### H-3：Message 分页实现存在，但 Timeline 从不加载早期页

Message repository 的默认页面上限是 200，且会返回 `hasMore/nextBeforeSeq`（`electron/persistence/message-repository.ts:104-159`）。`AgentReplica` 也实现了 `loadOlderMessages()`（`src/stores/agent-replica.ts:158-184`），但该 action 没有任何 Vue component 调用；`ConversationTimeline` 只渲染当前缓存的 `agent.messages`（`src/components/chat/ConversationTimeline.vue:234-249`），没有“加载更早消息”、滚动顶部触发器或截断提示。

因此超过 200 records 的正常对话只显示最新一页。早期 user/assistant record 不能从 UI 查看，也无法作为 fork、rewind、retry 或 edit 的目标；这些功能的 server API 并未缺失，只是 renderer 永远没有加载对应 record。工具调用和 prompt harness 会额外消耗 record 数量，因此该阈值比“200 轮对话”低得多。

建议：将 page state 暴露给 facade，在 Timeline 顶部提供可访问的“加载更早消息”入口（或可靠的滚动触发器），加载时保持视口锚点；同时对 `hasMore` 为真展示提示。补 201+ record 的页面、早期消息可见且可执行 rewind/fork 的 E2E 回归。

## Medium

### M-1：FileChange history 同样只加载第一页，旧 diff/revert 静默丢失

FileChange 的契约明确是“总记录数不设上限，单页最多 200”（`docs/architecture.md:241`、`docs/requirements.md:396`）。但 `loadFileChanges()` 每次只请求第一页（`src/stores/agent-replica.ts:185-201`）；虽保存了 `fileChangeHasMoreBySessionId`，却不存在加载下一页的 action。`DiffTab` 也没有截断状态或加载更多入口（`src/components/artifacts/DiffTab.vue:75-94,135-221`）。

当一个 Session 产生超过 200 个可恢复文件变更时，较早变更既不会展示也无法从 UI 发起 `file-change:revert`，用户没有任何“历史被截断”的信号。

建议：新增 cursor-aware `loadOlderFileChanges()`，以稳定 `(createdAt,id)` cursor 合并结果，并在 DiffTab 显示加载更多/已截断状态；补 201+ FileChange、加载早期项并成功 revert 的集成测试。

### M-2：Project 上限只在读取端截断，第 513 个 Project 成为孤儿记录

共享契约把 Project collection 上限定义为 512（`shared/durable.ts:5`），`ProjectRepository.list()` 也硬性 `LIMIT 512`（`electron/persistence/project-repository.ts:73-83`）。但 `ProjectService.add()` 在 insert 前没有容量检查，并在同一 transaction 中直接把被截断的 list 作为成功 commit 返回（`electron/application/project-service.ts:75-101`）。

创建第 513 个不同目录时，insert 成功，但新 Project 不在 command result、domain commit、bootstrap 或 `project:list` 中。renderer 的 `chooseWorkspace()` 依赖 commit 列表寻找新 Project，找不到时不会选中它或创建草稿（`src/stores/agent-runtime.ts:358-392`）。Project API 没有分页、也没有公开单项 get，所以该记录无法在正常产品流中更新、移除或再次选择。

建议：在同一 transaction 内原子计数并在达到 512 时拒绝新建（最符合有界完整列表契约）；若产品确实要超过该规模，则需要实现 Project 的分页/可发现读取，而不能静默截断。补 512/513 边界回归，断言第 513 次不会落库或仍可完整管理。

### M-3：tool-batch commit 失败后，teardown 未完成就允许 UI 看到 run 已结束

工具批次持久化失败时，execution state port 将 binding 标为 invalid 并调用 registry invalidation（`electron/application/durable-execution-state-port.ts:229-234`）。Registry 仅在 `waitForRunSettled()` 之后异步调用 `releaseOwned()`（`electron/application/live-session-context-registry.ts:358-373`）。在 `#closeOwnedContext()` 中，`SessionManager.closeSession()` 会先把 live Session 标为 closed/从 map 删除，而 registry entry 直到后续 await 完成才被删除（`:459-477`）。

这形成了可观察窗口：调用方已看到 failed run，`hasLiveSession()` 已为 false，却仍存在 `phase === 'releasing'` 的 registry entry；马上调用下一次 `run:start` 时，`ensureLoaded()` 因此返回 `CONFLICT: Session lifecycle is releasing`（`:109-122`）。全量 `npm test` 的首次运行正命中这一窗口：`durable-concurrency-recovery.test.ts` 在 `:362-375` 等待 live session 消失后立即 start，失败栈指向上述 `ensureLoaded()`。

建议：registry 应保存并暴露每次 teardown 的 promise，`ensureLoaded()` 遇到 `invalid/releasing` 时等待同 owner 的 teardown 后重新 load，或 renderer 在 teardown 完成前保持 Session busy。测试不应仅等待 manager map 消失，而应等待 registry teardown 完成；补“failed 状态后立即 retry/start”回归。

## Low

### L-1：`PersistenceTransaction.exec()` 允许 callback 提前 COMMIT，导致假失败真落库

`PersistenceTransaction.exec(sql)` 将任意 SQL 原样交给 SQLite（`electron/persistence/database-service.ts:45-60`），而 `withTransaction()` 在 callback 返回后无条件执行自己的 `COMMIT`（`:137-162`）。如果某个 callback 调用 `transaction.exec('COMMIT')`，写入会先持久化；外层 COMMIT 随后报“no transaction active”，coordinator 将其视为失败而不分配 cursor/发布 event（`electron/application/application-state-coordinator.ts:96-121`）。最终表现为调用方收到失败、SQLite 已变、renderer 永远不同步。

当前 production repositories 只使用 `prepare()`，因此这是尚未触发的核心 API footgun，而非当前用户路径。仍建议限制 transaction callback 不能执行事务控制 SQL（或将 `exec` 限制为 migration-only capability），并增加 `COMMIT`/`ROLLBACK`/`SAVEPOINT` 均被拒绝且失败后数据库无写入、无 envelope 的单测。

## 已复核但不列为未接受阻断项的风险

以下问题在当前源码仍存在或仍有边界，但 `docs/decision-log.md` 已明确记录为本轮接受/搁置，故不重复计入上面的未解决发现：

| 风险 | 当前决策 |
| --- | --- |
| FileChange 最后一次检查与 `rename`/`unlink` 间的外部 TOCTOU（FC-1） | 已接受，当前 workspace 边界是 best-effort |
| `run:start` request hash 只覆盖消息文本，未覆盖附件/全部新会话语义（REQ-1） | 暂缓；正式 renderer 每次生成新 request ID |
| 极端 1000+ in-flight 请求缓存逐出（APP-6） | 已接受；桌面/Headless 32 并发上限下不可达 |
| `beforeContent` 与 `beforeHash` 不做交叉校验（FC-3） | 已接受；前提为 SQLite 损坏或外部篡改 |
| 尚未发布 AppConfig v9 的 reset-only 策略（M-6） | 已接受为开发期策略 |

## 建议修复顺序

1. 先处理 H-1，确保 Project 重关联绝不会把回退副作用带到错误 workspace。
2. 处理 H-2/H-3/M-1，将既有 cursor API 完整接入 renderer，并为所有 200 条边界增加 UI 与 E2E 回归。
3. 修复 M-3 的 teardown ownership/promise，恢复失败路径可立即重新开始。
4. 修复 M-2 的 Project 容量语义，并把 L-1 的 transaction API 收紧，防止以后破坏 event/DB 一致性。
