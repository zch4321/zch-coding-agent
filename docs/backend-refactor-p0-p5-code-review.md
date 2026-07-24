# Backend State v2 分支 Code Review 报告（P0–P5 全分支整合版）

> 日期：2026-07-24
> 分支：`refactor/backend-state-v2`（代码 HEAD `3a469ad`；其上仅有一个 docs 提交 `84c3dc2`）
> 对比基线：`38a5e55`（与 `master` 的 merge-base），共 30 个提交、163 个文件、+21948/-3362 行
> 范围：P0–P5 全分支复审，重点深审上一轮报告之后的 10 个提交（`843829a..3a469ad`，56 文件、+6448/-531：上轮发现修复 + P5 FileChanges），并逐条核实上轮 H-1..H-7 / M-1..M-9 的修复状态
> 来源与方法：10 个区域并行深审（application×3、P5 FileChanges、session runtime、compact/history、providers、persistence、shared contracts、config/infra/docs）；全部 High/Medium 级新发现与修复核实结论均经主评审对照当前源码独立抽查确认；门禁独立复跑。与并行产出的 [`backend-refactor-p5-code-review.md`](./backend-refactor-p5-code-review.md)（P5 增量视角，P1/P2/P3 定级）重叠的发现已合并并交叉引用其编号（记作 =P1-1 等）；个别定级差异以本报告复核结论为准并注明理由。本报告仅评审，未修改任何代码。

---

## 1. 总结论

分支质量持续向好：上一轮 7 个 High **全部修复且方向正确**，均有真实失败注入/并发回归测试背书（断言 DB 内容、provider 请求、事件缺席，非形式化断言）；P5 FileChanges 的骨架（契约边界、writer/lifecycle 互斥链、retention 事务、提交顺序、隐私边界）设计严谨。

但修复层之下仍发现 **1 个 High、10 个 Medium、约 30 个 Low**。主题分布：

1. **修复的同根残余**：H-7 的前置校验漏了 provider 可控的 `reason`(intent) 字段（PRV-1）；H-5 的失败恢复不覆盖 commit 前的 append 阶段失败（SR-1）；M-4 只修了 archive/Project 侧，`SessionService.update` 半边仍撕裂且会静默回滚元数据（APP-1）。
2. **P5 文件系统执行层缺陷**：revert 的 TOCTOU 可越过 workspace 边界写/删文件（FC-1，与 P5 报告 P1-1 互证）、after 重验无界读文件、beforeHash 不交叉校验、权限位丢失、`UNIQUE(session_id, call_id, path)` 与压缩后 call ID 重用冲突。
3. **确认未修复的上轮 Medium**：M-5（exec 假失败真提交，实测复现）、M-6（配置重置策略，P5 新增必填字段使其成为直接样本）、M-7（smoke skip 顺序）、M-8（第 513 个 Project）、M-1（reasoning-only completion）、M-9（源头聚合上限）。

建议：P6 开工前处理 FC-1、PRV-1、SR-1、APP-1、PER-1、APP-6 与 M-6 的策略决策；P6/P8 接线前处理其余 Medium 与接线相关 Low。

## 2. 门禁实测（本机复跑）

| 门禁                   | 结果                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `npm run typecheck`    | 通过                                                                       |
| `npm run lint`         | 通过                                                                       |
| `npm run format:check` | 通过                                                                       |
| `npm test`             | 通过（无负载复跑：112 文件通过、2 跳过；746 测试通过、7 跳过；约 71 s）    |
| `npm run test:sqlite`  | 通过（node 24.18.0 与 electron 42.4.0 双运行时 `SQLITE_OK`）               |

备注：首轮复跑与 10 个评审子任务并发、机器重载，`shared/domain-state-contracts.test.ts`（5 s 默认超时）与 `electron/process/run.test.ts`（进程派生时序）各失败一次；两者单独复跑及无负载全量复跑均通过，判定为**负载敏感型 flake**，与上轮 Info「套件对慢机器偏脆」一致，建议 P10 统一处理这两处的超时/重试余量。本轮未复跑 `test:native` / `test:ripgrep` / `test:e2e` / `test:sqlite:packaged` / `test:real`（P5 报告记录 e2e 29/29 通过、packaged smoke 在 macOS 按设计 skip）。

## 3. 上轮发现修复核实

| 编号 | 状态       | 证据与说明                                                                                                                                                                |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H-1  | **已修复** | `0001_initial.sql:56,157,160` 新增 `sessions_parent_idx` / `messages_replayed_from_idx` / `messages_derived_from_idx`；实测 8000 条消息级联删除 9010 ms→63 ms（O(N²)→线性）；EXPLAIN 测试固定。改初始 SQL 致旧开发库 checksum mismatch，属计划内取舍（见 Info PER-4） |
| H-2  | **已修复** | `session-provider-turn.ts:324-334` 在 `adapter.complete()` 后立即 `assertCompletedAssistantTurn` + `assertAssistantTurnCandidate`（schema + 语义 + JSON bounds + active-epoch 全局 callId 去重，`canonical-history.ts:267-282`），严格先于 append（`session-run-controller.ts:492`）/approval/工具执行（`:534`）/commit（`:543`）；重启 reload 走同一函数；零副作用回归真实 |
| H-3  | **已修复** | 裸 `/compact` 在 provider 前先提交隐藏 control-command `user_input`（带 `clientRequestId`+`requestHash`、`inHistory:false`），`run:start` 正常返回 started；同 ID 重试幂等（进程内缓存 + 重启后 `lookupRequest` requestHash 比对）；失败保留命令严格 dedupe；拒绝不落库、改正后同 ID 可重试（`durable-target-runtime.test.ts:525-940` 全链覆盖） |
| H-4  | **已修复** | `start()` 在首个 await 前同步 `reserveNew` 建立单 flight；所有清理改为 ownerToken 校验的 `releaseOwned`/`forget`（owner 不匹配 no-op），「失败者误删获胜者 binding」路径已不存在 |
| H-5  | **已修复** | commit 失败经 `#recoverAfterFailure`（`durable-execution-state-port.ts:239-298`）从 SQLite 重载完整 live state 并清理未提交 clientRequests；reload 失败标 invalid 驱逐；tool_batch 失败强制驱逐。四类注入测试断言 DB 与 provider 请求均不含失败记录。**残余同类见 SR-1** |
| H-6  | **已修复** | loading 在首个异步操作前同步登记；`assertSessionIdle`/`assertProjectIdle` 覆盖所有非 live phase；restore 完成后复核 revision/lifecycle/projectId；archive/Project update/remove 事务前取 eviction lease |
| H-7  | **已修复**（留残余） | completion 边界四重校验先于一切副作用；SSE 累积阶段补齐 text/reasoning ≤1M chars、calls ≤256、单 call arguments ≤2 MB 增量上限；257 calls、重复 callId、超长 arguments 均零副作用拒绝。**残余同根缺口见 PRV-1** |
| M-1  | 未修复     | =P5 报告 P2-7。`chat-completions-adapter.ts:355-357` 原样；`parts.minItems=1` + `TextPart.minLength=1` 使「空 text 占位」不可行，需 schema 层决策                              |
| M-2  | **已修复** | append 移到 emit/logger 之后、紧贴 `executeToolCalls`，窗口内无 await；批内任何失败为全部非 terminal call 补 synthetic terminal result 且先 commit 再抛                        |
| M-3  | **已修复** | 双层防护：manager `mutationInProgress`（同步检查、无 await 窗口）+ port `commitTail` promise 链串行化（失败不断链）                                                          |
| M-4  | **部分修复** | archive/Project 侧已修（reservation + post-commit 失败仅诊断）；**update 侧未修 → 新发现 APP-1（Medium）**                                                                  |
| M-5  | 未修复     | → PER-1（Medium，实测复现「假失败真提交」）                                                                                                                                |
| M-6  | 未修复     | P5 新增必填 `fileChangeHistoryBytes` 沿用同一 reset-only 语义，=P5 报告 P1-3。**修正 P1-3 影响面**：v9 配置从未发布（release 0.2.1–0.2.3 均为 master v8 产物），当前真实影响仅限分支开发机；但「新增必填 limits 字段 = 全量清配置」的模式必须在任何 v9 发布后再次加字段前解决 |
| M-7  | 未修复     | `scripts/sqlite-smoke.cjs:107-110`：`packagedElectronPath()`（缺目录即 ENOENT）仍在非 Windows skip 判断之前求值（主评审抽查确认）                                             |
| M-8  | 未修复     | =P5 报告 P2-6。`project-service.ts:75-101` add 无容量检查，list 固定 `LIMIT 512`，契约无 project:get/分页                                                                   |
| M-9  | **部分修复** | =P5 报告 P2-8。源头仍无聚合上限；durable 组合由 H-5 恢复兜底（run 以 codec 错误失败但 session 不中毒）；**legacy 默认组合下超限附件仍使 session 内存态永久不可用直至重启**     |

上轮 Low 中已修：architecture.md P4 状态矛盾。其余（fork 标题、空 title/search 校验、512 envelope、publish listener 隔离、target mkdtemp 泄漏、CSS grid、budget 误归因、干净 EOF、usage 模型名、auto-approver listener、null config、契约三个 Low、listThrough 513、时间戳归一化、lastSeq 守卫语义）**均未修**，并入第 7 节。

## 4. 新发现汇总

| ID    | 严重度 | 区域        | 摘要                                                                              | 备注           |
| ----- | ------ | ----------- | --------------------------------------------------------------------------------- | -------------- |
| FC-1  | High   | file-change | revert 最终 rename/unlink 在校验后使用词法路径，TOCTOU 可越 workspace 边界写/删   | =P1-1，互证    |
| PRV-1 | Medium | providers   | provider 可控的 `reason`(intent) 绕过全部前置校验，工具执行后 commit 才失败       | H-7 同根残余   |
| SR-1  | Medium | session     | run_input commit 前的 append 阶段失败（粘性 logger）不回滚，下一 run 捎带落库     | H-5 同根残余   |
| APP-1 | Medium | application | `SessionService.update` post-commit 撕裂 + 下次 run commit 静默回滚元数据         | M-4 残余       |
| PER-1 | Medium | persistence | `PersistenceTransaction.exec` 允许事务控制语句，实测「假失败真提交」              | =M-5           |
| APP-6 | Medium | application | in-flight 请求被 LRU 逐出后同 key 重入共享 ownerToken，失败方可拆毁成功方 context | =P1-2，定级见注 |
| FC-2  | Medium | file-change | after 重验无大小上限整读文件，主进程内存 DoS 面                                   | =P2-1          |
| FC-3  | Medium | file-change | `beforeContent` 与 `beforeHash` 无交叉校验，损坏记录可恢复出错误内容              | =P2-2          |
| FC-4  | Medium | file-change | `UNIQUE(session_id, call_id, path)` 与压缩后 call ID 重用冲突，变更失去可回滚记录 | =P2-5          |
| FC-5  | Medium | file-change | revert 不保留权限位，0755 脚本回滚后变 0600                                       | =P2-3          |
| M-7   | Medium | infra       | smoke skip 判断顺序错误（上轮 Medium 确认未修，已抽查）                           | 沿用           |

APP-6 定级说明：P5 报告定 P1；本报告按可达性定 Medium——触发需 >1000 个并发在途 new-session 请求挤掉 LRU 中的在途条目后再同 key 重入，desktop/headless 现实负载极难达到；但一旦发生即破坏生命周期正确性（关闭成功方 session/丢首条消息），且根因（pending 与 settled 混用一张表、token 共享无引用计数）与 H-4 同类，必须在 P6/P8 接线前修。

## 5. High 级发现

### FC-1 revert 的最终 rename/unlink 在最后一次校验之后使用词法路径，TOCTOU 可越过 workspace 边界

`electron/application/file-change-filesystem.ts:88-134`（主评审抽查确认）：`restoreFileContent` 在 `:88-93`、`:111-112`、`:122-123` 完成目标与父目录 realpath 校验后，`:113`（覆盖写 `rename(temp, absolutePath)`）与 `:128-130`（删除分支 `rename` + `unlink`）使用的仍是最初词法解析的 `absolutePath`。拥有 workspace 写权限的外部进程（同步工具、agent 自己启动的构建脚本）在最后一次校验后的窗口内把父目录替换为指向 workspace 外的 symlink 时：patch/delete 回滚把快照内容写到 workspace 外；create 回滚把 workspace 外文件移入再删除。`WorkspaceAccessCoordinator` 只协调进程内写者，无法关闭该窗口。

- 影响：破坏 workspace 路径边界不变量（AGENTS.md 明确要求保留），可越界覆盖/删除文件。窗口窄但触发源现实存在。
- 建议：相对已验证目录句柄做 no-follow 原子操作（`openat`/`renameat` 风格，需原生层），或重设计为可检测、可恢复的两阶段操作并在契约中明确 best-effort 语义；增加「最后一次校验后注入父目录替换」的可控测试 hook。
- 与 P5 报告 P1-1 为独立互证的同一结论，分析以其为准，此处不再展开。

## 6. Medium 级发现

### PRV-1 provider 可控的 `reason`(intent) 字段绕过 completion 校验，在工具执行后撑爆 tool_result commit

`electron/providers/deepseek-provider.ts:139`（主评审抽查确认：`reason` 原样提取，无截断）→ `session-tool-runner.ts:490,521`（写入 `metadata.tool.reason`）→ `shared/message.ts:164`（maxLength 16384）→ `electron/persistence/message-codec.ts:41-46`（commit 时才 schema 校验）。触发链：tool-registry 向 provider 宣告 intent maxLength 2048（`tool-registry.ts:44-50`）但本地无强制；provider 写入 >16384 字符的 intent（SSE 单 call arguments 上限 2 MB，可容纳）→ H-7 新增的全部校验只覆盖 assistant_turn record（reason 不在其中）→ **工具真实执行** → commit 时 `encodeMessageRow` 抛错。三层上限互不一致：宣告 2048 / runtime 事件 65536 / durable 16384，前置强制为零。

- 影响：与 H-7/M-9 同类——副作用先于 durable 校验；legacy 组合下该 session 内存 history 永久带非法 record、此后每次 compile 失败；durable 组合下工具已执行却无 audit 落库。
- 建议：在 provider normalize 或 completion 校验处将 reason 截断/拒绝到 ≤16384（或直接按宣告的 2048），三层口径对齐；补「超限 intent 零副作用」回归。

### SR-1 run_input 提交前的 append 阶段失败不回滚，失败 run 的记录随下一 run 静默落库

`electron/session/session-run-controller.ts:406-421,549-552`（主评审抽查确认）：append 阶段（context/user 记录）之后、commit（`:421`）之前唯一的异步操作是 `session.logger.write`（`:412`）；`JsonlTraceLogger` 一次 IO 失败后所有 write 永久抛错（粘性失败）。run 的 catch 只在 `!run.requestCommitted` 时删 `clientRequests`，**不回滚 history**（对比：prepare 阶段失败有完整回滚 `:356-369`）。port 的 records filter 按 `seq > lastSeq` 捎带（`durable-execution-state-port.ts:161-163`），而 `#recoverAfterFailure` 仅在 commit 失败时触发，对此路径无效。

- 影响：durable 组合下，向用户报告「发送失败」的消息随下一 run 的 commit 变成 durable 事实；同 `clientRequestId` 重试还会在内存产生第二条同 ID user_input，下一次 commit 撞 `UNIQUE(session_id, client_request_id)` 多失败一轮才被 recovery 治愈。legacy 组合下陈旧记录被重复发给 provider。
- 建议：run catch 中 `!run.requestCommitted` 时恢复 run 入口 checkpoint（history/nextMessageSeq/goal/plan），与 prepare 回滚共用；补「logger 失败后下一 run 不捎带旧记录」回归。

### APP-1 `SessionService.update` post-commit 撕裂 + 下次 run commit 静默回滚元数据（M-4 的 update 半侧）

`electron/application/session-service.ts:368-383` + `live-session-context-registry.ts:350-356` + `session-manager.ts:696-704`（主评审抽查确认：`update` 相对 `843829a` 未变；registry **先** `executionState.applyRecord` 刷新 binding、**后**调会抛 CONFLICT 的 `manager.applyDurableSessionRecord`）。触发：`update` commit 成功后、applySessionRecord 前的微任务间隙内 `run:start` 完成 `ensureLoaded`+`startRun` → manager 侧抛 CONFLICT，调用方看到失败但 DB 已提交；且 binding 已是新 revision/新元数据而 manager 内存是旧值 → 该 run 的 metadata commit 检测到 `metadataChanged`，用旧 mode/modelSelection/goal/plan 以新 revision 写回 DB，**用户本次 update 被静默回滚**。

- 影响：错误语义撕裂 + durable 元数据与用户操作相反；当前 target 组合下窗口被 coordinator 串行化大幅收窄（近乎不可达），但 P6 接线 `session:update` 后直接暴露。
- 建议：与 archive 对齐——post-commit apply 失败仅诊断不上抛；并调换顺序为先 manager 后 binding（manager 失败则不刷 binding）；更彻底做法是 update 也走 reservation，在 commit 临界区内完成 idle 断言与状态应用。补并发交错回归。

### PER-1 `PersistenceTransaction.exec` 允许事务控制语句，实测「假失败真提交」（M-5 确认未修复）

`electron/persistence/database-service.ts:53-60`：`exec` 透传任意 SQL，不在 `843829a..HEAD` 变更清单中。区域评审用 node:sqlite 实测复现：work 内 `exec('COMMIT')` 提前提交事务，`withTransaction` 末尾的 COMMIT 抛 `cannot commit - no transaction is active`（归一化为 DATABASE_ERROR），`isTransaction` 已为 false 故不回滚——调用方看到失败但数据已落库。`ROLLBACK`/`SAVEPOINT`/`RELEASE`/`VACUUM` 同理可逃逸原子性。

- 影响：打破「事务失败 ⇒ 无提交」核心假设——coordinator 只在事务成功后发布事件，此场景 DB 已改而事件未发，renderer 副本与持久化状态永久分叉。当前仅测试用 `exec` 建表，属 footgun 而非活 bug。
- 建议：`exec` 前拦截事务控制语句（`^\s*(begin|commit|rollback|savepoint|release|vacuum)`，含注释前缀）；补「exec('COMMIT') 被拒且原子性不受影响」测试。

### APP-6 in-flight 请求被 LRU 逐出后同 key 重入共享 ownerToken，失败方可拆毁成功方 live context

`electron/application/durable-run-application-service.ts:50-90` + `live-session-context-registry.ts:57-107`：`#requests` 同时承担「进行中单飞表」与「最近请求缓存」，超 1000 项无条件逐出最旧项——包括在途条目。同 sessionId+clientRequestId 重试再次进入 `start()`，`reserveNew` 幂等分支返回**同一个** ownerToken，两个并发调用在 `createSession` 的异步路径上交叠；任一方失败清理（`releaseOwned`）会拆除另一方刚建好的 live context，且 `#startNew` 的失败清理无条件删 key，可误删后续请求的 promise。

- 定级：见第 4 节说明（P5 报告 P1-2，本报告 Medium）；P6/P8 前必须修。
- 建议：pending map 与 settled LRU 分离，绝不逐出未完成条目；同 reservation 映射到共享启动 promise 而非共享可独立释放的 token；清理一律做 promise/owner 身份比较。

### FC-2 after 重验无大小上限整读文件，主进程内存 DoS 面（=P2-1）

`electron/application/file-change-filesystem.ts:38-47`：`lstat` 已拿到 size 但未使用，`readFile(canonical, 'utf8')` 无界读取；commit 的 after 重验与 revert 的两次重验均经过。外部进程把目标替换为超大普通文件即可让主进程缓冲整个文件，hash mismatch 只在读完后发现。工具层的 10 MiB 上限只作用于 mutation 准备路径，未复用到此。建议：读取前按 size 拒绝超限（稳定报 `RESOURCE_CHANGED`），大文件用有硬上限的流式 hash。

### FC-3 `beforeContent` 与 `beforeHash` 无交叉校验，损坏记录可恢复出错误内容（=P2-2）

`electron/persistence/file-change-codec.ts:166-195` + `electron/application/file-change-service.ts:347-355`：codec 校验 schema/hash 格式/payloadBytes，但不验证 `sha256(beforeContent) === beforeHash`；`revert()` 全程不使用 `beforeHash`。DB 损坏/错误导入/部分写入恢复出的「内容被换、hash 格式合法」行会通过全部校验并写回错误内容。建议：至少在 revert 前重算比对，不一致拒绝且不触碰文件；按威胁模型评估是否需要 HMAC。

### FC-4 `UNIQUE(session_id, call_id, path)` 与压缩后 call ID 重用冲突（=P2-5）

`electron/persistence/migrations/0001_initial.sql:189` + `canonical-history.ts:267-282`：callId 全局唯一性只查 `inHistory` 的 assistant turn；压缩将旧消息置非活跃后，provider 可合法重用同一 call ID。重用 ID 对同一路径再次 mutation 时触发唯一约束失败 → catch-all 转为 `CHANGE_HISTORY_PERSIST_FAILED` warning：mutation 已成功但本次变更无可回滚记录，用户无感知。建议：统一标识语义——全 session 禁止 call ID 重用，或唯一键改为 assistant turn/message identity + call ID + path。

### FC-5 revert 不保留权限位，0755 脚本回滚后变 0600（=P2-3）

`electron/application/file-change-filesystem.ts:106-113`：临时文件以 `0o600` 创建并直接 rename 覆盖目标；record 不保存 mode。patch 覆盖回滚与 delete 重建回滚都会丢失可执行位/组权限——内容正确但元数据失真，对脚本类文件是真实功能回退。建议：record 增加受约束的 `beforeMode & 0o777`，rename 前 `fchmod`；ACL/xattr/特殊位的跨平台策略单独定义。

### M-7 `sqlite-smoke.cjs --packaged` 在非 Windows fresh 环境报错而非 skip（确认未修复）

`scripts/sqlite-smoke.cjs:107-110`（主评审抽查确认）：`packagedElectronPath()`（内部 `readdirSync(release/<version>/win-unpacked)`，缺目录即抛 ENOENT）仍在 `process.platform !== 'win32'` skip 判断**之前**求值，底部无 try/catch。fresh 非 Windows 环境独立运行必然非零码崩溃而非输出 `SQLITE_SKIP`，违反 AGENTS.md 声明。建议：平台判断移到路径解析之前；补无 release 目录的非 Windows 用例。

## 7. Low 级发现（按区域归并）

**application**

- `beginRequest` waiter 在 startRun 同步抛错路径成为 unhandled rejection（`durable-run-application-service.ts:242-249`；metadata lease 使该路径新变得易达，`--unhandled-rejections=strict` 下进程崩溃）。建议 catch 中先 `void commitPromise.catch(() => undefined)`。
- publish 循环无 per-listener 隔离（`create-durable-target-runtime.ts:82-84`，上轮 Low 未修）：首个抛错 listener 阻断后续订阅方，命令仍返回成功，副本静默分叉。
- target 构造/销毁失败路径泄漏（`:69-78,227-245`）：`DatabaseService.open` 在 try 之前（ownsDirectory 泄漏 mkdtemp，上轮 Low 未修）；`dispose()` 无 try/finally。
- fork 标题未截断（`session-service.ts:563`，上轮 Low 未修；**修正**：实际被 codec 拦为 `PERSISTENCE_FAILURE` 而非上轮所述 CONFLICT，误导性相同）。
- 服务层输入校验缺失三连（上轮 Low 未修）：title/name trim 后为空（`session-service.ts:677`、`project-service.ts:134-136`）、search trim 为空（`session-service.ts:110-124,215-227`）均被 codec 误报为 `PERSISTENCE_FAILURE`；`project-service.ts:85` `path.basename('/')` 为 '' 同类。应为服务层显式 `PRECONDITION_FAILED`。
- commit 入口仍无 512 条 envelope 服务层上限（`session-service.ts:265,329`，上轮 Low 未修；当前真实路径 ≤257 天然低于上限）。
- commit 前失败的 run 真实错误被掩码：`#startLoaded` 的 race 对 slash 校验失败等一律抛 `PRECONDITION_FAILED: Run ended before its user message was committed`（`durable-run-application-service.ts:251-263`），调用方无法区分「输入非法」与「run 异常结束」。
- `commitMutation` 允许 `deactivateThroughSeq` 与非 `'invalidate'` 的 messageChange 不配对（`session-service.ts:330-347`）：当前唯一调用方总是配对，属服务层 footgun。
- fork batch 扩展越过 `listThrough` 513 截断时误报「batch 不完整」而非 `PAYLOAD_TOO_LARGE`（`session-service.ts:513-524`）。
- `evictIdleProject` 循环中单个 session 清理异常会 wedge 整个 project（`live-session-context-registry.ts:337-340,477`：`onSessionEvicted` 不在 try/catch 内，token 残留 → 后续操作全 CONFLICT）。
- 直接调用 `runtime.closeSession()` 绕过 registry 后 session 可被永久锁死（`live-session-context-registry.ts:109-132` + `session-manager.ts:580-622`；当前无调用方，P8 latent）。

**session**

- `closeSession` 在 trace 写失败时拒绝并跳过清理（`session-manager.ts:616-620`）：session 滞留 map、trace stream 不 dispose、调用方看到假失败。建议 best-effort。
- 无 hook 也可能报 "beforeLLMCall hook exceeded the model context budget"（`session-provider-turn.ts:242-249`，上轮 Low 未修）：post-hook 对完整 wire body 再估一次且无补丁也执行。
- 纯 `/compact` 的 trace 缺 `run.start` 与 `user.message`（`session-run-controller.ts:341-344` vs `:425-429`；较 master 还多丢了 `user.message`，略有扩大）。
- 纯 `/compact` 期间排队的 interjection 被静默丢弃（`session-interjection-coordinator.ts:35-64`；master 同构存在，非本分支引入，但 durable journaling 使「命令持久而插话消失」的矛盾更显眼）。
- 错误文案仍把 `/compact` 列为支持命令（`slash-commands.ts:221-223`，不可达的死文案）。
- interjection `injected` 事件先于 durable commit 发布（`session-interjection-coordinator.ts:86-91`）：commit 失败时 renderer 已被通知「已注入」。
- compact summary 的 completion 校验失败不落 `llm.response` trace（`session-compact-coordinator.ts:384-399`），与主 turn 不对称。

**providers**

- continuation 内容双份存储使有效输出预算约为逐项上限之和的一半（`chat-completions-adapter.ts:364-372` + `canonical-history.ts:265`）：text 600KB + reasoning 600KB 等逐项合法的组合在 record 2 MB 校验处被拒，流式「成功」后莫名失败；256 calls × 2 MB arguments 可在累积阶段占 ~512 MB 内存后才被拒。建议下调 SSE 累积上限与 record 预算对齐。
- SSE 累积阶段的拒绝不走 `llm.response`/onDiagnostic 诊断路径（`session-provider-turn.ts:293-323` vs `:335-351`），trace 留下有 request 无 response 的不对称。
- `ProviderAutoApprover.evaluate` 不处理「注册前已中止」的 signal（`auto-approver.ts:125-126`）：取消路径被拖满整个超时（默认 60 s）。重构前同构，非回退。
- 上轮 Low 未修三项：无 `[DONE]`/`finish_reason` 干净 EOF 归一化为 completed（`chat-completions-adapter.ts:273-275`）；usage 模型名取全局默认而非 session pinned（`usage.ts:48`，main/compression 路径，approval 路径已正确）；auto-approver compile 在 try 外致 listener 泄漏（`auto-approver.ts:121-165`，生产 adapterId 闭集使窗口极窄）。

**persistence**

- 「prevents Session lastSeq regression」测试名固定了相反语义（`repositories.test.ts:138,161-166` 实际断言允许降序）：改测试名/注释，或在 update 的 WHERE 追加 `AND ? >= last_seq`。
- codec 语义断言抛裸 `TypeError`，与 `CODEC_INVALID` 分类不一致（`message-codec.ts:46,142` → `shared/message.ts:506-532`；`file-change-codec.ts:138,173`）：今日无行为分叉，未来按 code 捕获会漏。
- 上轮 Info 维持原判：listThrough 513 隐式耦合；时间戳归一化只在 session-codec；lastSeq 守卫弱语义；listActiveHistory 无 LIMIT；node:sqlite 超 2^53 INTEGER 裸 RangeError（仅外部篡改可达）。

**file-change**

- revert 中 PathGuard 违规被映射为 `PRECONDITION_FAILED` 而非 `RESOURCE_CHANGED`（`file-change-service.ts:362-366`），P6 后调用方无法区分「资源变了可重试」与「路径越界」。
- create 回滚删除分支补偿失败时残留隐藏临时文件且错误不披露位置（`file-change-filesystem.ts:128-134`）。
- `commitMutation` 两个 catch-all 使 `warningCode` 失真（`file-change-service.ts:203-207,251-256`）：EACCES/PathGuardError 也归为 `AFTER_STATE_MISMATCH`，生命周期错误也归为 `PERSIST_FAILED`。

**contracts**

- `assertFileChangePageSemantics` 不钉住 page 记录排序（`shared/file-change.ts:83-101`；对照 message/session page 均钉住）：P6/P7 出现第二个 producer 时校验器无法发现顺序违约。
- file-change 契约冗余 sessionId 双写且无一致性断言（`shared/domain-state-api.ts:471-478,100-113`）：P6 handler 自行组装时两值分叉无校验兜底。
- plan §10.4 与已实现契约脱节（`docs/backend-refactor-plan.md:558` 仍写 file-change 推 bounded full-list snapshot，实际已改为 `upsert | invalidate_all` union）：P6 开工前同步文档，避免误导 handler/reconciler 实现。
- 上轮契约 Low 未修：runtime-state 两个 date-time 无 maxLength；`MessageMetadataV1Schema` 无判别字段（本批新增第三分支，仍无消费方）；credential query key 黑名单漏 `key`/`auth`/`sig`。

**config / infra / docs**

- 不可解析的 config.json 使启动硬失败，与「可解析但非法 → 自动重置自愈」不对称（`store.ts:565-588`；半份截断写入场景）。
- 重置错误信息残留 "P3 requires AppConfig v9" 阶段引用，且不含实际 schemaVersion（`migrations.ts:12`）。
- `ReplaySummarySchema.skippedEvents` 成为永远为 0 的死契约字段（`shared/trace.ts:101`；skip 路径已随 trace fork 删除）。
- Prompt Inspector CSS grid 仍 6 列 vs 实际 5 个 children（=P3-1，确认未修）。
- AGENTS.md 的 `npm run build` 描述仍未提串入的 `test:sqlite` / `test:sqlite:packaged`。
- config.json 为 JSON `null` 不自愈、provider revision delete/recreate 后从 1 重启（上轮 Low 未修）。

## 8. Info 级记录（设计决策确认项）

- **PER-4**：H-1 修复直接改 `0001_initial.sql` 导致 checksum 漂移，旧开发库重开以 `MIGRATION_CHECKSUM_MISMATCH` 硬失败且无自动恢复——上轮建议的直接改法 + plan §12.2 把 blocking recovery 列为 P8 内容，属有意取舍；P8 接线前需实现「mismatch ⇒ 备份后重建」或 blocking recovery UI。
- **SC-4**：`run:start` 在新旧两套契约中同名不同形、共用 `IPC_VERSION = 1`：P6 注册时必须保证同 composition 只注册一份，且需定义 durable 契约版本演进规则。
- **SC-5 / M-6 修正**：`fileChangeHistoryBytes` 必填未升版本的影响面见第 3 节 M-6 修正（v9 未发布）；若确认 v9 不随任何中间版本发布，可在 plan 中显式记录「v9 字段可在分支内自由追加」作为决策。
- **FC-9**：retention 可删除 in-flight revert 的目标记录（`file-change-repository.ts:57-84`）：错误语义诚实（`PERSISTENCE_FAILURE` + `mutationSucceeded`）、无静默损坏，建议文档化「预算压力下正在回滚的记录不受保护」。
- **FC-10**：writer lease 以 workspace 字符串为粒度，嵌套 workspace（`/a` 与 `/a/b`）互不互斥（P4 既有，非 P5 引入）；建议 project add 拒绝嵌套路径或文档声明。
- **SR-5**：harness 类 run 无 `user_input` 记录，`beginRequest` waiter 永不 resolve——当前无活路径（headless 直调 manager），P6 若接入 commit-wait 模式需显式 resolve 通道。
- **REG**：`LiveSessionContextRegistry.dispose()` 从未被接线（`create-durable-target-runtime.ts:227-236`）；`invalidate()` 无 settle 超时（触发点都会使 run 立即收尾，可达性低）；commit 队列在执行时读 session 当前状态而非入队快照（正确性依赖 manager 互斥前提，建议注释固化）。
- **CMP-6/7**：失败的 compact 同 ID 重试返回 deduplicated（plan §8.3 明确设计）；summary 提示词不再包含 follow-up 正文（plan §7.5 的有意重设计，测试已固定）。
- **PER-5**：`insertWithRetention` 每次 `SUM(payload_bytes)` 全表聚合扫描（默认 100 MB 预算下万级行毫秒级，随库线性退化；P10 可改 running-total 表）。
- **DOCS-1**：`fileChangeHistoryBytes` 无 Settings UI 控件（值经全量 round-trip 不丢，若属有意建议文档明确）。
- **CFG-3**：`provider-settings` 同时变更 route 与 apiKey 时 revision 单次 +2（方向 fail-safe，建议注释）。
- **SR-6**：`session-manager.ts` 1034 行，超 AGENTS.md 1000 行指引，可在 P6/P7 拆分时顺手收敛。

## 9. 测试覆盖缺口（重点）

- **PRV-1**：超限 intent「零副作用」回归缺失；SSE 累积超限（257 calls、超长 arguments/text/reasoning）只有 provider 层断言，无 run-loop 组合级「无 tool.proposed/无 commit」测试。
- **SR-1**：logger 粘性失败后「下一 run 不捎带旧记录」无回归。
- **APP-1**：`SessionService.update` 与并发 run 的交错（post-commit 报错、元数据静默回滚）无测试。
- **APP-6**：容量压力下同 key 重入「只启动一次、失败分支无法拆毁成功分支」无测试。
- **durable 组合缺口（上轮指出仍未补）**：auto-compact 的 invalidate 事务与 run 衔接、interjection commit、mid-stream/mid-batch 取消后的 DB 落库断言、流式期间 DB 无 partial record 的中途断言、command_input commit 自身失败注入。
- **H-2**：重启 reload 后重复 callId 拒绝无直接断言（机制共享）。
- **FC-1/2/3/5**：TOCTOU 注入 hook、超限文件替换、篡改 before_content/before_hash 行、权限位保留均无测试；revert 的「目标被换成 symlink/目录」分支、`diffTruncated=true` 的 list/revert、retention × in-flight revert 交互无覆盖；经真实 registry 的 revert-vs-run/archive/project-update 并发集成缺失（现仅 mock guard）。
- **FC-4**：压缩后重用 call ID + 同 path 二次 mutation 无持久化用例。
- **M-1**：reasoning-only completion 路径无任何行为固定（修复时无回归网）；干净 EOF、usage 模型名、completion 校验失败写 llm.response 均无断言。
- **PER**：exec 事务控制语句防护（连防护本身都不存在）；`close()` 排空在途写事务；FK 子侧索引的其余三个依赖最左前缀的查找无 EXPLAIN 固定；derived_from 的 persistence 级单测。
- **SC**：control_command/derived 两个新 user_input 变体在 shared 层无 round-trip fixture，语义拒绝路径全仓无测试；`assertFileChangePageSemantics` 负向、`DomainStateEventSchema` topic/change 错配拒绝无测试。
- **CFG**：配置重置后 secret-store 状态无断言；fresh-env smoke skip 无测试；`fileChangeHistoryBytes` 边界包含性（恰好 1M / 10G 被接受）未断言；`getProviderApiKeyForRevision` 无直接单测；v>9 只有「会被重置」的正向固定、无「应保留/应备份」反向断言（测试目前在固化问题）。
- **其余**：archive 经真实 registry token 的成功路径端到端；session listPage 游标平局；commit 恰好一次发布的次数断言；commit 失败后同 clientRequestId 重试（现有恢复测试均换新 ID）。

## 10. 核查通过的关键不变量（对照记录）

- **H 系修复全部真实落地**：校验前移（H-2/H-7）、控制命令 journaling（H-3）、单 flight + ownerToken（H-4）、失败恢复 + 隔离驱逐（H-5）、生命周期 lease（H-6）、FK 索引（H-1），均有真实失败注入/并发/实测背书，非形式化断言。
- **P5 骨架**：FileChange commit/event 严格先于 tool-batch Message commit（顺序探针断言）；retention 与 insert 同事务、按 `(created_at,id)` 确定性淘汰、单条超限先拒绝；`payloadBytes` = UTF-8(before)+UTF-8(diff) 双侧重算；Run 起始冻结预算；revert 首个 await 前预留 mutating token、writer lease 双向互斥、不占 run slot；`beforeContent` 不进 shared 契约/page/event/tool result/canonical Message/trace（全文断言）。
- **control-command 隐藏语义全层闭环**：schema 三态闭集 union ↔ DB 三重 XOR CHECK ↔ codec 双向一致性三层对齐；compiler 按 inHistory 排除、search 排除、audit page 保留；fork remap 与 control-command fork 点拒绝有测试。
- **事务与并发**：coordinator 仅事务成功后递增 cursor 并恰好一次发布、失败零发布无空洞；`withTransaction` 拒绝异步 work 并回滚、句柄 deactivate 防逃逸；OCC revision 恰好 +1、UNIQUE 兜底、requestHash 防 ID 复用串文。
- **provider 边界**：校验零副作用（失败时未消耗 seq、无 append/approval/tool/usage）；SSE 上限无校验空档（PRV-1 唯一例外已单列）；transport abort/timeout/错误分类/finally 清理完整；route 冻结三 purpose 单快照、credential 按 (providerId, revision) 钉住；P0 golden fixtures 逐字节未变。
- **compact**：auto/manual 重建顺序与 plan §7.5 一致；多次 compact `replayedFromMessageId` 始终指向原始 user id；compact 事务原子（deactivate+insert+revision）且内存回滚覆盖全部失败分支。
- **trace/凭据**：trace v2 全链路一致、v1 显式拒绝；trace fork 删除全仓零残留；`toPublicConfig` 不输出 apiKeyRef；credential 不进 IPC/trace/公开 page。

## 11. 建议处理顺序

1. **P6 开工前（结构性/安全项）**：FC-1（TOCTOU，需设计决策：原生 no-follow 原子操作或显式 best-effort 契约 + 测试 hook）；PRV-1（reason 截断/校验，补 H-7 缺口）；SR-1（run catch checkpoint 回滚，补 H-5 缺口）；APP-1（update 对齐 archive 策略 + apply 顺序调换）；PER-1（exec 拦截，一行正则即可拆掉 footgun）；M-6/P1-3（配置策略决策：>9 拒绝保留、重置前 .bak、孤儿 secret 策略，并文档化）；APP-6（pending/settled 分离 + 共享 promise）。
2. **P6/P8 接线前必须修**：FC-2/FC-3/FC-4/FC-5（文件历史安全/可恢复性一组，建议同一次评审）；M-1（reasoning-only，需 schema 决策）；M-8（add 同事务计数拒绝）；M-9 源头聚合上限；M-7（skip 顺序）；REG 两项（dispose 接线、closeSession 自愈）；SR-5（harness run resolve 通道，若 P6 接入）；SC-3（plan §10.4 同步）；file-change 契约冗余 sessionId（SC-2）在注册前定型。
3. **随手修**：第 7 节各 Low（unhandled rejection、publish listener 隔离、fork 标题、服务层输入校验、trace 对称性、CSS grid、错误文案等）。
4. **补测试**：按第 9 节优先级——PRV-1/SR-1/APP-1/APP-6 回归、durable 组合取消/auto-compact/interjection、FC 安全组、M-1 行为固定、PER 防护与索引固定。
