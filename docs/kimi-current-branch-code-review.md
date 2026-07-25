# Kimi 当前分支 Code Review 报告

> 审查日期：2026-07-25
>
> 分支：`refactor/backend-state-v2`（代码 HEAD `58ad8d9`；审查时 HEAD `c3f0e8d`，后者仅新增 docs）
>
> 对比基线：`master` 的 merge-base `6cb4a0819734ce68166635a82422872011a21b1b`
>
> 变更范围：50 个提交、241 个文件、`+28099/-13249` 行
>
> 范围：完整审阅 `master...HEAD`，覆盖 SQLite 持久化、application services、session 核心、provider 层、IPC/shared 契约、renderer stores、主进程基础设施、测试与构建配置八个领域。
>
> 说明：本报告已合并原 `docs/codex-current-branch-code-review.md` 的全部 7 条发现（逐条独立核实后并入，标题处标注来源），原文件已删除。
>
> 复检：修复提交 `c3f0e8d..db8072a`（5 个提交）已于 2026-07-25 复检完毕，结论与逐项状态见文末"复检结果"一节。

---

## 结论

本次切流（Workbench snapshot → SQLite durable state）架构方向正确：新持久化层 schema 约束严密、SQL 全部参数化、事务与迁移生命周期有完整测试；IPC 边界保持了 sender 校验 + AJV 载荷/结果双端校验；`shared/` 全程无 Node/Electron/Vue 污染；凭证未进入日志/trace/子进程环境。静态检查与测试全部通过。

但当前 HEAD 存在 **11 个 P1、30 个 P2、46 个 P3** 问题（无 P0）。P1 中包含四类必须修复的回归，建议修复前不要合入：

1. **Workspace 边界**：Project 重关联路径后，旧 FileChange 的回退可以把内容写入新的无关 workspace（P1-1）。
2. **审批门控两处回归**：审批 provider 缺凭证时所有 run 启动即失败（P1-2）；审批模型 reasoning 从 `'off'→'high'` 的强制转换丢失，自动审批在推理关闭状态下做放行决策（P1-3）。
3. **Renderer 交互回归**：双击/双回车可创建重复 run 甚至重复 session（P1-4）；`interjection.carryover` 事件被丢弃导致用户输入静默丢失（P1-5）；interjection 去重为死代码导致重复渲染（P1-6）；长会话中工具卡片排序错位（P1-7）。
4. **分页未接入 UI**：超过 200 的 session 从侧栏和搜索都不可达（P1-8）；会话内超过 200 条的早期消息不可见、不可作为 fork/rewind/retry 目标（P1-9）。
5. **兼容性与测试基础设施**：headless 默认 reasoning 从 `'high'` 静默变为 `'off'`（P1-10）；`npm run test:docker-worker` 确定性失败（P1-11）。

## 审查与验证方法

- 按八个领域并行深审 `git diff master...HEAD` 与当前源码，每个发现要求引用当前文件行号并在代码中核实后方可上报。
- **全部 11 条 P1 由主审逐条独立复核**（对照 master 旧实现与当前代码确认行为差异）；P2/P3 由领域审查者核实并附证据。
- 交叉核对 `docs/` 设计文档与 `docs/decision-log.md` 已接受风险（FC-1、APP-6、REQ-1、FC-3、M-6），已接受项不计入发现，见文末专节。
- 原 codex 报告的 7 条发现（3 High / 3 Medium / 1 Low）全部经独立核实：6 条确认成立并入本报告（H-1、H-2、H-3、M-1、M-2、L-1），M-3 代码结构确认成立但竞态窗口未在本环境复现（按 P2 并入并注明）。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck`（vue-tsc + node + runtime 三套） | 通过 |
| `npm run lint`（eslint） | 通过 |
| `npm run format:check`（prettier） | 通过 |
| `npm test`（vitest 确定性套件） | 通过：102 文件、688 通过、8 跳过（跳过项为 opt-in docker/real-api） |

本轮未运行 Electron E2E、真实 provider 测试与 `test:sqlite`/`test:native` smoke；其中 `test:docker-worker` 的静态失败已在 P1-11 中确认（读取不存在的 artifact 文件）。

## 复检结果（2026-07-25，修复提交 `c3f0e8d..db8072a`）

修复分 5 个提交：`c766cc0`（persistence）、`0be95e4`（runtime/providers）、`5afb2b1`（renderer）、`7278071`（infrastructure）、`db8072a`（logging），共 114 个文件、`+4,644/−1,082` 行。复检方式：按领域逐条核对修复代码与回归测试（验证根因是否真正关闭，而非仅看是否有测试），P1 关键项由主审抽查确认，并运行全量验证。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` / `lint` / `format:check` | 通过 |
| `npm test` | 通过：108 文件、732 通过、8 跳过（较初审 +44 测试；`benchmarks/cases/cases.test.ts` 已回归门禁，单独耗时约 47s） |

**总结论：11/11 P1 全部修复且均有回归测试；P2 中 28 条修复、2 条部分修复、1 条按决策记录关闭（config 备份，M-6 修订）；master 遗留 4 项（含 `terminal_send`）全部修复；用户实测反馈 5 项中 4 项修复（事件空洞误报、工具卡片排序、`terminal_send` 裸 `\n`、日志开启不生效），sendFirst 为有意保留的设计（TerminalPanel 零改动）。复检另发现 2 个修复引入的新问题（N-1、N-2，建议合入前处理）与 2 个轻微项。**

### P1 复检状态（11/11 RESOLVED）

| 编号 | 修复要点 |
| --- | --- |
| P1-1（回退跨 workspace） | ✅ `file_changes` 持久化 `workspacePath`（新迁移 `0002_file_change_workspace.sql`），回退前与提交事务内双重比对当前 `project.path`（`file-change-service.ts:482-487`），不匹配即 `RESOURCE_CHANGED` 拒绝；回归测试正是报告的 A→B 预置相同 after-hash 场景（`file-change-revert.test.ts:312-356`）。主审抽查确认 |
| P1-2（缺凭证阻断 run） | ✅ 审批路由改为可选增强：provider 缺失/凭证不可用降级为诊断并返回无 approval 的路由，run 正常启动、自动审批安全禁用（`model-route-resolver.ts:90-121`；消费点 `session-tool-runner.ts:179`）。主审抽查确认 |
| P1-3（reasoning 降级） | ✅ `'off'→'high'` 强制转换恢复（`model-route-resolver.ts:99-102`）；集成测试断言审批请求体 `thinking: enabled` + `reasoning_effort: 'high'`。主审抽查确认 |
| P1-4（双提交） | ✅ `sendMessage`/`retryUserMessage` 纳入 `startPending` 守卫（`agent-runtime.ts:684-696`），pending 标记在 IPC 前设置、finally 防误清；在途 IPC 双提交有真实测试 |
| P1-5（carryover 丢失） | ✅ 新增完整 carryover 处理：chip 标记、FIFO `flushCarryovers`、稳定 `clientRequestId`、防重入（`agent-runtime-events.ts:179-206`、`agent-runtime.ts:791-837`） |
| P1-6（重复渲染） | ✅ 后端把 interjectionId 写入记录 metadata（`canonical-history.ts:98,132`），renderer 按 metadata 去重并在 commit 到达时移除 overlay chip |
| P1-7（工具排序） | ✅ durable/live 分区渲染：durable 容器消息与工具统一 `record.seq`，live 容器恒在底部不再混排（`ConversationTimeline.vue:295-342`）；overlay 工具不再覆盖 durable。主审抽查确认 |
| P1-8（session 分页） | ✅ bootstrap 返回 `sessionPage`（hasMore/nextBefore），`loadOlderSessions` + 侧栏"加载更早对话"按钮，`selectSession` 回退 `getSession`，搜索命中 upsert 进 sessions |
| P1-9（message 分页） | ✅ Timeline 新增"加载更早消息"按钮 + 视口锚点保持（`ConversationTimeline.vue:282-291,163-179`） |
| P1-10（headless reasoning） | ✅ 从 configStore 的 provider 取 reasoning，与 `buildAppConfig` 的 `'high'` 对齐；省略时请求体断言 `'high'`（`headless.test.ts:502-524`） |
| P1-11（docker-worker 失败） | ✅ `conversation.restricted.md` 读取与断言已删，仅保留仍真实写出的 `session-transcript.restricted.md` |

### P2 复检状态

- **已修复（28 条）**：session 核心全部 7 条（含 2 条 master 遗留的 settlement 泄漏、终态 interrupt；cancelling 冲掉、carryOver 窗口、rootUserMessageId、prepareMutation——后者改为 run 级 fail-closed 并已记入 decision-log 新条目 M-1）、application 4 条（含 M-3 teardown 竞态：`LifecycleEntry.teardown` promise + `ensureLoaded` 等待后重试，主审抽查确认；M-2 第 513 个 project 事务内容量检查；new_session/retry 去重）、persistence 2 条（时间戳归一化、sqlite-smoke 顺序）、provider 2 条（usage 归因、catalog 流式上限）、IPC 2 条（bootstrap 风暴：`bootstrapInFlight` 合并，主审抽查确认；app-handlers 测试重建含导出隐私门禁）、renderer 3 条（file-change 分页、writer.changed 误报——事件已加 `sessionId`、终态清流竞态）、基础设施 5 条（auto-approver 泄漏、trace 清理分类、损坏 JSON 恢复、runtime-parity 删除、config——见下）、测试/构建 3 条（cases.test.ts 回归门禁、artifact 残留引用清理、长工具结果布局 e2e 补回且强于原用例）。
- **部分修复（2 条）**：
  - `PersistenceTransaction`：`exec()` 已删除（原通道关闭），但 `prepare('COMMIT').run()` 在 node:sqlite 上仍可执行事务控制 SQL——同类 footgun 的第二通道仍在（`database-service.ts:48-51`，复检者在本机实测可提交），且无拒绝测试。
  - renderer 测试覆盖：新增 12 个测试覆盖了双提交、carryover、投影、分页、seq 记账等关键路径，但审批回滚与事件去重/gap→reload 分支仍无直接覆盖。
- **按决策记录关闭（1 条）**：config v9 无备份 reset 代码未改，但 M-6 已修订（覆盖损坏 JSON 场景），"面向真实用户分发前必须重新决策"的条件保留——与本报告"发布门禁项"的定位一致，发布前待办须有跟踪。

### 用户实测项复检状态

| 项目 | 状态 |
| --- | --- |
| "对话事件不连续"误报 | ✅ `workspace.writer.changed` 已加 `sessionId`，renderer 在提前 return 前推进 `lastEventSeq`；有钉住测试 |
| 工具卡片排在最终输出下 | ✅ 即 P1-7，分区渲染消除两个方向的错位 |
| `terminal_send` 裸 `\n` 不提交 | ✅ Windows 下 `(?<!\r)\n` → `\r` 归一化（`terminal-tools.ts:248-254`），文档同步更新——与复检建议一致 |
| 日志开启对 live 会话不生效 | ✅ 新增 `SessionTraceController` 分段捕获：开启后 idle 会话即时开新段，run 进行中记 `pending` 在 run 边界切换，关闭写 `session.end('logging_disabled')`；notice 门禁仍强制；UI 有提示与降级告警；`session-manager.logging.test.ts` 端到端覆盖用户场景 |
| sendFirst（草稿禁用终端） | ⬜ 有意保留未改（TerminalPanel 零改动），报告中仍记录为 UX 回归，建议产品决策 |

### 修复引入的新问题（复检发现）

- **N-1 [P2] carryover flush 失败会永久锁死会话输入**（`src/stores/agent-runtime.ts:819-821`）：`flushCarryovers` 的 `startRun` 失败时仅设 `globalError` 并返回 false，队列项保留；而 `canSend`/`sendMessage`/`retryUserMessage` 在队列非空时全部拦截，flush 只由新 carryover 事件、终态 `run.status` 或前次成功触发——确定性失败（如 provider 配置错误）下队列永远非空且无再触发途径，该会话输入被永久锁死，只能重载恢复。建议：失败时出队或提供手动重试/清空入口。
- **N-2 [P2] `retry()` 缓存被拒绝的 promise，同 `clientRequestId` 无法再试**（`electron/application/durable-run-application-service.ts:113-120`）：retry 去重缓存不做失败淘汰（对照 `start()` 会删除），`#retry` 拒绝后陈旧的 rejected promise 永久缓存；去重 key 不含 `expectedRevision`，客户端刷新 revision 再试仍拿到旧的 rejected promise。建议：promise 拒绝时从缓存删除（与 `start()` 一致）。
- **N-3 [轻微]** live 工具区内部仍混 hydrate `index+1` 与后续 `overlay.order` 两个序（`agent-runtime.ts:291`、`agent-runtime-events.ts:126`），run 中途刷新后 live 区短暂错乱，落库后自愈。
- **N-4 [轻微]** cursor 重同步走 bootstrap 会把 sessions 整体替换为第一页并切走选中会话（`agent-replica.ts:165,177-188`），正在查看 200+ 会话时会被跳走。

### 复检后仍未处理项（P3/可接受延后）

- persistence：`setInHistoryThrough` footgun、`assistant_message_id` 仍无 FK（0002 重建表时未顺手补）、`PersistenceReader` 可写、双进程迁移竞争、`listThrough` 死代码、parent-clearing trigger。
- application：listener 异常阻断投递、`dispose()` 不排空队列、`application-error` 误标、idle 守卫不看 `mutationInProgress`。
- renderer：`agent-project` projectId 竞态、`closeRuntimeSession` 死 stub（`MessageComposer` 仍 await）。
- 基础设施：headless 临时 DB 目录泄漏、main.ts 恢复对话框误标+重试循环、`*.sql?raw` 重复声明、auto-plan-approval 拒绝路径。
- providers：纯 tool-call TTFT、`prefixFingerprints`、`'title'` purpose 死契约、resolver 死分支、key 顺序敏感比较。
- 公共 API doc 注释：少量补充（`resolveRunRoutes`、`normalizeLlmUsage` 等），多数仍缺——本分支自定规则的存量违规依旧最多。
- 分页 201+ 的 E2E 回归未补（只有单元测试）。

## 发现汇总

| 严重度 | 数量 | 分布 |
| --- | --- | --- |
| P1（必须修复） | 11 | workspace 安全 ×1、审批路由 ×2、renderer ×4、分页 ×2、headless ×1、benchmark 测试 ×1 |
| P2（应当修复） | 31 | session 核心 ×7、application ×4、renderer ×5、基础设施 ×5、persistence ×3、provider ×2、IPC ×2、测试/构建 ×3 |
| P3（建议/规范） | 46 | 含公共 API 缺文档注释、死代码、文件超长等 |

## P1（必须修复，均已逐条独立复核）

### P1-1：Project 重关联路径后，旧 FileChange 可回退写入新的无关 workspace（原 codex H-1）

`ProjectService.update()` 允许将 idle Project 重关联到新的规范路径（`electron/application/project-service.ts:103-143`，`docs/requirements.md:180` 明确支持"移动目录后重新关联"）。但 FileChange 记录只保存相对路径、hash 和回退内容，不保存创建时的 workspace identity；回退时 `#readRevertTarget()` 从**当前** Project 读取 workspace（`electron/application/file-change-service.ts:442-486`，`:483` 返回 `project.path`），随后 `restoreFileContent()` 在该路径执行写入/删除（`:355-363`）。其 after-hash 校验只证明"新目录里恰好有相同 after 内容"，不能证明目标仍是原来的文件。可复现路径：workspace A 中记录 `note.txt` 的 FileChange → 将 Project path 改为无关目录 B → 在 B 中预置内容同为 after 的 `note.txt` → 调用 `file-change:revert`，hash 校验通过，B 中文件被改写为 A 的 before（create-file 场景则被删除）。这不是 decision-log 已接受的 FC-1 外部 TOCTOU 竞态，而是确定性的逻辑路径，会静默改写用户已重关联到的另一目录。建议：在 backend-private record 中持久化创建时的 workspace path 与目录 identity，identity 不匹配即拒绝回退；短期方案是 path 变更时将旧 FileChange 标为不可回退；补 A→B、B 中预置相同 after hash、必须拒绝且 B 不变的集成回归。

### P1-2：审批 provider 缺凭证时所有 run 启动即失败

`resolveRunRoutes`（`electron/providers/model-route-resolver.ts:89-93`）在 run 启动时无条件解析审批路由（调用点 `electron/session/session-run-controller.ts:315`）；审批 provider 无 API key 时 `resolve()` 抛 `credential is not available`（`model-route-resolver.ts:55-57`），provider 不存在时抛 `Approval Provider is not configured`（`:79-83`）。master 是在工具审批时刻惰性取 key，缺 key 仅禁用自动审批器（master `session-tool-runner.ts` 中 `session.mode === 'auto' && apiKey && ...`）。设置 UI 允许选择任何 provider 作为审批 provider（包括无凭证的），因此用户在 plan/默认模式下（自动审批根本不会触发）也被阻断所有 run。建议：审批路由凭证失败改为非致命（冻结路由快照但容忍缺 key，使现有 `apiKey && ...` 守卫自然禁用自动审批），或延迟到首次审批需求时解析。

### P1-3：自动审批 reasoning 从 `'off'→'high'` 的强制转换丢失

`electron/providers/model-route-resolver.ts:84-88` 将 `approvalProvider.reasoning` 原样写入审批路由；`electron/session/session-tool-runner.ts:174-198` 直接使用该值。master 在 `session-tool-runner.ts:180-183` 有强制转换：`reasoning === 'off' ? 'high' : reasoning`。当审批 provider 的 reasoning 配置为 `'off'`（合法配置值）时，基于模型的自动审批器现在会在推理关闭的状态下审核工具调用——这是对"是否无需人工放行变更"这一安全门控的静默降级。全仓 grep 确认转换已不存在。建议在 `resolveRunRoutes` 恢复强制转换，或显式记录该行为变更并加测试钉住。

### P1-4：`sendMessage` 丢失 `startPending` 守卫，双击/双回车可创建重复 run/session

`src/stores/agent-runtime.ts:639-647` 的守卫只检查 `activeRunId || pendingApproval`，没有检查 `startPending`（getter 存在于 `:74-79` 但仅用于 `:240`）。`activeRunId` 要等 `startRun` IPC 返回并 hydrate 后才设置，而 `MessageComposer.vue:380` 直接调用 `agent.sendMessage()`（textarea 未禁用），在 IPC 在途窗口内第二次回车会发起第二个 `startRun`。对草稿会话，每次调用还会 mint 新的 `sessionId`（`:663`）和新的 `clientRequestId`，后端幂等无法去重——同一条消息可创建两个 durable session。master 在 store 层用 `runtimeBusy`（`startPending || activeRunId || pendingApproval`）守卫。建议：将 `this.startPending` 纳入 `sendMessage` 守卫（并考虑同样保护 `retryUserMessage`）。

### P1-5：renderer 丢弃 `interjection.carryover` 事件，用户输入静默丢失

后端仍在发送 `interjection.carryover`（`electron/session/session-interjection-coordinator.ts:101-119`，由 `session-run-controller.ts:552` 触发），语义是"让 renderer 用该内容开启新 run"。master 的 `runtime-events/interjection-events.ts` 会将 carryover 入队并 `flushCarryoverInterjections()` 启动新 run；重写后的 `src/stores/agent-runtime.ts` 对该事件没有任何处理分支（全文件无 `carryover`），在 final-answer 边界排队的 interjection 会永久停留在 `overlay.interjections` 中显示 "queued"，其内容永远不会开启新 run。`agent-types.ts:37` 的 `'carryover'` 状态值成为死代码。建议：处理该事件——标记 chip 为 carryover 并在 run 空闲后自动将其内容作为新消息发送。

### P1-6：interjection 去重是死代码，injected interjection 重复渲染

`src/stores/agent-runtime.ts:151-161` 的去重谓词要求 `record.kind === 'interjection' && 'clientRequestId' in record`，但 `InterjectionMessageRecordSchema`（`shared/message.ts:434-435`，经 `textMessageRecordSchema` 构造）没有 `clientRequestId` 字段（仅 `user_input` 有，见 `shared/message.ts:466-480`），条件永假。injected interjection 会以 `visibility: 'visible'` 持久化（`electron/session/canonical-history.ts:107-110`）并经 `session.changed` 进入 replica，timeline 于是同时显示 durable 记录（`:118-132` 投影）和 overlay chip（`:162-173`）；且 `overlay.interjections` 在终态 `run.status` 时未清理（`:912-921`），重复展示会持续存在。建议：状态为 `'injected'` 后放弃 overlay chip、只依赖 durable 记录，或在记录 metadata 中持久化 interjection id 并据此去重。

### P1-7：工具卡片排序混合三个 order 域，两个方向都会错位（用户已实测复现）

durable 消息与 durable 工具用 `record.seq`（`agent-runtime.ts:114,191,200`），hydrate 快照工具用 `index + 1`（`:279`），live 工具用 `overlay.order`（`:904,943`），而 `ConversationTimeline.vue:244,256` 通过 flexbox `order` 在同一容器内混排消息与工具卡片。`record.seq` 按**提交记录**递增（一轮对话只有几条），`overlay.order` 按**流式事件**递增（每条 reasoning/text delta 都 +1，一次 run 可达几十上百）——两个序号域量纲不同，混排必然错位，且两个方向都已复现：

1. **新会话/进行中**：`overlay.order`（~79 个事件）远大于 `record.seq`（~4 条记录），live 工具卡片沉到**最终 assistant 输出下面**（用户截图实证：结论文本在上、`run_command` 卡片在最下）。`tool.completed` 不更新 order（`:945-953`），且 overlay 工具按 callId 覆盖本有正确 seq 的 durable 工具（`:203-205`），错位会保留到 overlay 生命周期结束。
2. **长会话/重启后**：`overlay.order` 从 0 重新计数（几十），`record.seq` 已达数百，live 工具卡片排到历史记录的中上部（流式文本靠 `MAX_SAFE_INTEGER` 保持在最后）。

master 用单一 `nextTimelineOrder()` 计数器覆盖消息与工具避免了此问题。建议：live 工具/流式内容的 order 基于会话 `lastSeq` 起算（工具完成时按 tool_result seq 落定），或将 live 区块渲染为独立的底部区域。

### P1-8：超过 200 的 session 从侧栏与搜索都不可达（原 codex H-2，并入并升级）

backend bootstrap 只返回最近 200 条 session summary 且丢弃 repository 的 `hasMore/nextBefore`（`electron/application/create-backend-runtime.ts:204-217`）。repository 有稳定游标分页且 `session:list` 已经 IPC 暴露，但 renderer 的 `bootstrap()` 只覆盖一次 `sessions` 副本，store 中没有任何 `api.listSessions()` 调用；`selectSession()` 要求 id 已存在于该数组，否则直接返回 `false`（`src/stores/agent-replica.ts:126-134`）。搜索也无法救援：`ProjectSidebar.vue:73-79` 把搜索命中再向已加载的 `agent.conversations` 查找，未加载的命中被静默过滤。因此重启后若有 201+ 个 session（或最近 200 个均已 archive），较旧的 active session 无法显示也无法打开——数据仍在 SQLite，但正常 UI 流程不可达，与设计文档"bootstrap 只给最近、分页/搜索/按需加载走 query"的约定相悖（`docs/backend-refactor-plan.md:545,568,613-615`）。建议：bootstrap 返回 `SessionPage` 元数据并按 project 维护游标，侧栏按需调 `session:list`；搜索命中应 upsert `hit.session`，`selectSession()` 应能回退到 `session:get`；补 201/401 条 session 的 renderer/E2E 覆盖。

### P1-9：会话内超过 200 条的早期消息不可见、不可操作（并入 codex H-3 并升级）

`getSession` 快照单页上限 200（`shared/durable.ts:8`；`electron/persistence/message-repository.ts:104-159` 返回 `hasMore/nextBeforeSeq`）。`AgentReplica.loadOlderMessages()` 实现了 `beforeSeq` 分页并经 facade 暴露（`src/stores/agent-replica.ts:158-184`、`agent.ts:238`），但没有任何组件调用它；`ConversationTimeline` 只渲染当前缓存页，没有"加载更早"、滚动触发器或截断提示。超过 200 records 的会话只显示最新一页：早期 user/assistant 记录既无法查看，也无法作为 fork、rewind、retry、edit 的目标（这些 server API 都在，只是 renderer 永远加载不到对应 record）。工具调用与 prompt harness 记录也计入 200 条配额，实际阈值远低于"200 轮对话"。建议：向 facade 暴露 page state，在 Timeline 顶部提供"加载更早消息"入口并保持视口锚点，`hasMore` 为真时展示截断提示；补 201+ record 的 E2E 回归。

### P1-10：headless 默认 reasoning 从 `'high'` 静默变为 `'off'`

`electron/headless/runner.ts:190` pin 了 `modelSelection.reasoning: provider.reasoning ?? 'off'`（HeadlessConfig 中该字段为 Optional），而 `buildAppConfig`（`electron/headless/config.ts:158`）给同一 provider 的默认值是 `'high'`，且路由冻结以 selection 为准（`model-route-resolver.ts:38`）。master 的 headless 没有 modelSelection，reasoning 来自 provider 配置（`'high'`）。未显式配置 `reasoning` 的 benchmark/CI 现在静默以推理关闭运行——且同一次 run 内审批路由仍用配置的 `'high'`，主/审批路由发生分叉。建议：默认取 `prepared.configStore.getPublicConfig()` 中的 provider reasoning（或 `'high'`），与 `buildAppConfig` 对齐。

### P1-11：`docker-worker.e2e.test.ts` 读取已被移除的 artifact，确定性失败

本分支从 runner 删除了 `conversation.restricted.md` 的写出（当前 `benchmarks/runner/runner.ts:327-375` 只写 `session-transcript.restricted.md`），但 `benchmarks/worker/docker-worker.e2e.test.ts:288` 仍 `readFile(... 'conversation.restricted.md')` 并断言其内容。该测试经 `runBenchmarkTrials` 真实执行，`npm run test:docker-worker` 会以 ENOENT 确定性失败。建议：删除相关断言（及 orchestrator 内容检查）或恢复该 artifact。

## P2（应当修复）

### Session 核心

- **审批决议冲掉 `'cancelling'` 状态**（`electron/permission/session-approval.ts:146,217`）：`requestToolApproval`/`requestContextApproval` 在决议后无条件 `setRunStatus(..., 'running_tools')`，包括决议为 `'cancelled'`（`interrupt()` 中止）的情况——把 `interrupt()` 刚设置的 `'cancelling'` 改回并为将死 run 发出 `running_tools` 事件。更糟的是 `interjectRun` 只在 `status === 'cancelling'` 时拒绝，此窗口内的 interjection 被接收入队却永远不会 drain/carryover/supersede，静默丢失。建议：仅在决议非取消且 signal 未 abort 时恢复 `'running_tools'`。
- **carryOver/finishRun 窗口内 interjection 丢失**（`session-run-controller.ts:546-556`，**master 已存在**）：final-answer 分支先检查 `pendingInterjections.length > 0` 再 `carryOver` 后 `finishRun`；在两个 await 期间经 IPC 到达的 interjection 落在检查/摘除之后，既未 carryover，run 也照常完成，用户消息以 `'queued'` 状态消失。建议：在终态 `setRunStatus` 前再做一次 drain/carryOver，或在 final-answer 检查前先把 run 标记为不可 interject。
- **auto-compact 后 `rootUserMessageId` 指向已停用记录**（`session-compact-coordinator.ts:510-519,164-171`）：`#rewrite`（`replayRootUser: true`）追加新 id 的 replay 根 user 输入，但返回值丢弃了该 id，`run.rootUserMessageId` 仍引用原（已 `inHistory: false`）记录；后续 `assistant_turn`/`tool_result`/interjection 的 `turnId` 都挂到已停用消息上，下次 compaction 还会从陈旧记录 replay。`/compact` 路径会更新它（`:250`），auto-compact 没有。建议：`#rewrite` 返回 replay 根 id 并在 auto-compact 调用方赋值。
- **`prepareMutation` 失败阻断已批准的文件写入**（`session-tool-runner.ts:313-321,342-344`）：`prepareMutation` 在 `#toolExecutor.execute` 之前运行，任何抛出（前置条件/diffHash 不匹配、额度超限，或 `FileChangeService.prepareMutation` 的瞬时 DB 错误）都会使已批准的写入不执行。master 在写入后记录、失败仅诊断。对前置条件/额度 fail-closed 合理，但瞬时 DB 错误现在会阻断真实文件 I/O，且 prepare 失败路径没有任何测试。建议：补回归测试，并考虑把瞬时持久化错误排除在阻断之外。
- **被拒绝的 side-effect settlement 泄漏 writer lease**（`session-tool-runner.ts:333-339` + `session-run-controller.ts:243-257`，**master 已存在**）：`settlement.then(() => pendingSideEffects.delete(...))` 在 rejection 时不删除（并产生 unhandled rejection）；`#releaseWriterWhenSettled` 用 `Promise.allSettled` 重等同一已拒绝 promise，立即 resolve 后无限递归，`releaseWriter()` 永远不被调用，workspace 保持写锁。建议：`settlement.finally(...)` + `.catch(() => undefined)`。
- **drained interjection 在 `'interjection'` commit 失败时丢失**（`session-run-controller.ts:473-490`）：`drain()` 追加记录并发出 `'injected'` 状态；若随后的 commit 失败，`#recoverAfterFailure`（`durable-execution-state-port.ts:256`）从 durable 重载 `session.history`，不含未提交记录——provider 看不到该 interjection，但 renderer 已显示 injected。这是 durable commit 边界引入的新失败模式。建议：commit 失败时将已 drain 的 interjection 重新入队。
- **`interrupt()` 接受终态 run**（`session-run-controller.ts:176-186`，**master 已存在**）：无 `isTerminalRunStatus` 守卫；在 `#finishRun` 发出 `'completed'` 与 `.finally` 清除 `activeRun` 之间调用 `interruptRun` 会把状态改为 `'cancelling'` 并在终态事件后再发 `run.status`，污染 `publicSnapshot.status`。建议：run 已终态时返回 `false`。

### Application services

- **tool-batch commit 失败后 teardown 竞态，立即重试被 CONFLICT 拒绝（原 codex M-3，代码结构确认、本环境未复现）**：批次持久化失败时 execution state port 将 binding 标 invalid 并调 `registry.invalidate()`（`durable-execution-state-port.ts:229-234`）；`invalidate()` 把 entry 置为 `'invalid'`，待 `waitForRunSettled()` 后异步 `releaseOwned()` → `'releasing'` → `#closeOwnedContext()`（`live-session-context-registry.ts:358-373,459-478`）。`closeSession()` 先把 live session 关闭/移出 map，而 registry entry 直到后续 await 完成才删除——形成可观察窗口：调用方已看到 failed run、`hasLiveSession()` 已为 false，但 `ensureLoaded()` 遇到 `'invalid'/'releasing'` entry 直接抛 `CONFLICT: Session lifecycle is ...`（`:109-122`）。codex 首轮全量测试命中过该窗口（`durable-concurrency-recovery.test.ts:362-375`）；本环境一次全量通过，窗口窄但结构确实存在。建议：registry 暴露每次 teardown 的 promise，`ensureLoaded()` 遇到 `invalid/releasing` 时等待 teardown 完成后再 load；测试应等待 registry teardown 而非仅等 manager map 消失。
- **第 513 个 Project 写入成功却从所有 API 消失（原 codex M-2）**：契约将 project 集合上限定为 512（`shared/durable.ts:5`），`ProjectRepository.list()` 硬性 `LIMIT 512`（`electron/persistence/project-repository.ts:73-83`），但 `ProjectService.add()` 在 insert 前没有容量检查，并在同一事务中把被截断的 list 作为成功 commit 返回（`electron/application/project-service.ts:91-96`）。创建第 513 个目录时 insert 成功，但新 project 不在 command result、domain commit、bootstrap 或 `project:list` 中；renderer 依赖 commit 列表寻找新 project，找不到则不会选中；project API 无分页也无单项 get，该记录无法在正常产品流中管理。建议：事务内原子计数、达到 512 拒绝新建（最符合有界完整列表契约），或实现 project 分页；补 512/513 边界回归。
- **`new_session` 重复请求在缓存裁剪后返回 CONFLICT 而非去重结果**（`durable-run-application-service.ts:72-81`）：`start()` 在 durable `lookupRequest` 去重（`:154`）之前先 `registry.reserveNew()`；内存 `#requests` 项是唯一把重复请求引向去重路径的机制，而该项按 `MAX_CACHED_RUN_STARTS` 裁剪。被裁剪后，携带同一 `clientRequestId` 重试的"建会话+首消息"会在 `reserveNew` 抛 `CONFLICT`，而不是返回重启后可得到的去重结果。建议：对 `new_session` 先 durable 查重再 reserve，或在 reserve CONFLICT 且 session 匹配时回退 durable 查重。
- **`retry()` 无 `clientRequestId` 去重且丢失 `mutationSucceeded` 标注**（`durable-run-application-service.ts:108-134`）：与 `start()` 不同，`retry()` 不缓存请求也不查 durable；携带同一 `clientRequestId` 和刷新 `expectedRevision` 的重复 retry 会再次 rewind 并为一个逻辑请求启动第二个 run。另外 rewind 已提交后 `ensureLoaded`/`retryRun` 抛错时，原始错误不带 `mutationSucceeded` 标注直接传播（对照 `session-service.ts:645-649`），IPC 客户端无法得知 rewind 已成功。建议：按 `sessionId+clientRequestId` 缓存 retry 结果，并为提交后失败加标注。

### Persistence

- **`PersistenceTransaction.exec()` 允许 callback 提前 COMMIT，导致"假失败真落库"（原 codex L-1，升级为 P2 预防项）**：`exec(sql)` 将任意 SQL 原样交给 SQLite（`electron/persistence/database-service.ts:53-56`），而 `withTransaction()` 在 callback 返回后无条件执行自己的 `COMMIT`（`:154`）。若某 callback 调用 `transaction.exec('COMMIT')`，写入先持久化；外层 COMMIT 随后报"no transaction active"，coordinator 视为失败而不分配 cursor/发布事件，且 `isTransaction` 已为 false 不会回滚（`:157`）——调用方收到失败、SQLite 已变、renderer 永远不同步。当前 production repository 只用 `prepare()`，属未触发的 API footgun。建议：禁止 transaction callback 执行事务控制 SQL（或将 `exec` 限定为 migration-only），并补"COMMIT/ROLLBACK/SAVEPOINT 均被拒绝"的单测。
- **`--packaged` 跳过逻辑顺序错误**（`scripts/sqlite-smoke.cjs:107-110`）：`runElectronChild()` 在平台检查（`:110`）之前先求值 `packagedElectronPath()`（`:107-109`，内部 `readdirSync(release/<version>/win-unpacked)`）。非 Windows 主机上 `npm run test:sqlite:packaged` 会 ENOENT 崩溃，而不是打印文档承诺的 `SQLITE_SKIP`（与 `AGENTS.md` 的表述矛盾）。建议：把平台检查移到路径解析之前。
- **时间戳未 UTC 归一化但排序/游标依赖字符串比较**（`file-change-codec.ts:84`、`project-codec.ts:30-31`、`message-codec.ts:93`）：只有 session codec 用 `dateTimeColumn` 归一化；而 file_changes 保留驱逐（`file-change-repository.ts:74` `ORDER BY created_at ASC`）、分页（`:192` DESC）、`ProjectRepository.list` 都依赖字典序，且 file-change 游标在比较前被归一化（`:179-181`）——存储值却是原始值。带非 UTC 偏移的 `createdAt` 能通过 ajv 校验但排序/比较错误（错误驱逐顺序、游标误过滤）。当前生产者都用 `toISOString()`，属潜伏问题。建议：三个 encoder 同样使用 `dateTimeColumn`。

### Provider

- **usage 记录归属 provider 默认模型而非实际使用模型**（`electron/providers/usage.ts:48`）：`normalizeLlmUsage` 记录 `input.provider.model`，而请求用的是 `binding.snapshot.model`（session pin 的选择，可与 provider 默认值不同）。审批调用点已做补偿（`session-tool-runner.ts:174-180`），但主路径（`session-provider-turn.ts:371-377`）与压缩路径（`session-compact-coordinator.ts:416-422`）未补偿，pin 非默认模型时主/压缩 `llm.usage` 记录与日志被误标。建议：优先使用 `input.modelProfile?.id` 或显式传快照模型。
- **catalog 大小上限在 body 全量入内存后才检查**（`electron/providers/model-catalog.ts:81-85`）：`await response.text()` 全量缓冲后才检查 `MAX_CATALOG_BYTES`，1 MB 上限并不真正约束内存；baseURL 用户可配，恶意/错误端点可返回任意大 body。建议：用 `response.body.getReader()` 累计字节数，超限即 abort。

### IPC / shared 契约

- **preload 缓冲事件重放引发 bootstrap 风暴**（`electron/preload.ts:64`）：`subscribeDomainState` 同步重放最多 256 条缓冲事件；每条 commit 进入 `replica.reconcile()`，cursor 为空时（`agent-replica.ts:220-227`）各自触发一次 `bootstrap()`——N 条缓冲 commit 产生 N 个并发 `getBootstrap` + `loadSession` IPC。渲染器崩溃/开发重载且有活跃 run 时可达。最终一致但浪费且闪烁。建议：replica 内合并 bootstrap（单在途 promise），或 preload 在无 cursor 时将缓冲 commit 折叠为一次 resync 信号。
- **`app-handlers.test.ts` 删除未补，transcript 导出隐私门禁失去回归覆盖**（`electron/ipc/app-handlers.ts:714-754`）：240 行测试被删且未替代，`createAppIpcHandlers` 零直接测试；被删文件包含唯一的导出警告门禁回归（"每次导出都警告，取消时不保存"）。当前处理器仍实现该门禁，但没有测试能抓住静默删除它的重构。建议：补一个覆盖导出门禁与 domain-state 透传接线的小型测试。

### Renderer

- **FileChange 只加载第一页，200 条之前的 diff 不可见、不可回退（原 codex M-1）**：`loadFileChanges()` 每次只请求第一页（`src/stores/agent-replica.ts:185-201`，固定 `limit: 200`、无游标参数），虽保存了 `fileChangeHasMoreBySessionId`，但不存在加载下一页的 action；`DiffTab` 也没有截断状态或加载更多入口。会话产生超过 200 个文件变更时，较早变更既不展示也无法从 UI 发起 `file-change:revert`，用户没有"历史被截断"的信号。建议：新增 cursor-aware `loadOlderFileChanges()`，以稳定 `(createdAt,id)` 游标合并，并在 DiffTab 显示加载更多/截断状态；补 201+ FileChange 加载早期项并成功 revert 的集成测试。
- **`workspace.writer.changed` 不推进 `lastEventSeq`，每次 run 误报事件空洞**（`agent-runtime.ts:875-884`）：后端经 `emitAgent` 发送该事件并递增 `eventSeq`，但 renderer 在 `:890-903` 的 seq 记账前提前 return（事件 schema 无 `sessionId`，无法归因）。从第二个 writer 模式 run 起，下一个带 seq 事件是 `lastEventSeq + 2`，每次 run 都触发误报 "Runtime event gap" 横幅和冗余 `getSession`+hydrate。建议：为此类事件也推进 per-session seq（需给事件加 `sessionId`，或经 `writerSessionId` 跟踪）。
- **终态 `run.status` 异步清流式文本，与下一次 run 竞争**（`agent-runtime.ts:912-921`）：终态时 `loadSession(...).then(() => { overlay.text = ''; ... })` 在 IPC 往返后执行；用户立即重试/发送时，新 run 的早期 delta 已累积进同一 overlay，随后被这个过期的 `.then` 清空（直到 `assistant.message.completed` 前不再渲染）。建议：捕获完成的 `runId`，`overlay.runId` 不匹配时跳过清理，或在 IPC 前同步清理。
- **重写后的 runtime store 与事件管线几乎无测试**：删除了约 2,600 行测试（concurrency/conversations/facade-settings/history/requests/runtime-events + App.test.ts），仅新增 `agent-replica.test.ts`（2 个测试）。`handleAgentEvent`（去重/空洞/writer 事件）、`messages`/`tools` 投影、`sendMessage` 草稿流、审批提交/回滚、interjection 流均无覆盖——上述 P1-4/5/6/7 全部位于无覆盖区。建议：把价值最高的已删测试移植到新 store API。
- **草稿状态下终端完全不可用，UX 回归（用户实测反馈）**（`src/components/TerminalPanel.vue:508,553`）：master 在无 session 时打开终端面板会自动创建 session 和终端，可以直接敲命令；本分支删除了该自动创建，改为只显示"先发送一条消息以创建 Durable Session"且禁用新建按钮。即用户必须先中断当前操作去聊天框发一条消息，才能回来用终端——对"只想先开个终端跑命令"的场景是明显的工作流倒退。终端 send 链路本身已在本机 e2e 验证可用（`durable-session-terminal.spec.ts` 3/3 通过，真实 node-pty 打字/回显）。建议：恢复"打开终端时按需创建会话"的能力（durable 会话可以以空首消息或显式 create 入口创建），或在面板内提供"创建会话并打开终端"的一键操作。

### 主进程基础设施

- **config v9 reset-only 路径无备份、无用户提示、secret 引用成孤儿（发布门禁项）**：`electron/config/store.ts:581-586` 对 `UnsupportedConfigSchemaError` 直接 `rm` 配置再写默认值，旧 `apiKeyRef` 密钥永久滞留 `secrets.json`。注意：`docs/decision-log.md` M-6 已将"v9 未发布前 reset-only、不备份、不清理 secret"**明确接受为开发期策略**——但其自身写明重新评估条件："任何构建开始面向真实用户分发"时必须重新决策备份与 orphan 策略。因此本条不计为当前缺陷，而是**发布前必须关闭的门禁项**：分发前需实现重命名备份（如 `config.v<old>.bak.json`）、renderer 一次性提示与孤儿 secret 清理，并把 M-6 标记为已关闭。
- **auto-approver 在 adapter compile 抛错时泄漏 timer 与 abort listener**（`electron/permission/auto-approver.ts:121,158-168`）：`chatAdapter(...)`（未知 adapter 抛 `TypeError`）与 `adapter.compile(...)` 在清理它们的 `try/finally`（`:172`）之前运行，compile 失败会泄漏 60s 定时器并在 signal 上累积 listener。建议：把 compile 移入 `try`（映射为 `fallback('network', ...)`）或加外层 `finally`。
- **不可解析的 trace 文件成为清理候选**（`electron/logging/cleanup.ts:70`）：`readTraceFile` 失败的文件以 `closed: true` 入列，两个保留策略（按龄/超预算）都会删除它。对 legacy v1 是有意的，但同样覆盖了因崩溃写坏的当前 v2 文件（此前会永久跳过）。建议：只对"不支持的 schema 版本"错误走删除路径，真正损坏的 v2 文件保留。
- **配置 JSON 损坏导致启动硬崩，与后端恢复体验不一致**（`electron/config/store.ts:565`）：`#read()` 只恢复 ENOENT 与 `UnsupportedConfigSchemaError`；`JSON.parse` 的 `SyntaxError` 一路传播到 `app.exit(1)`（`main.ts:134,216` 的恢复对话框只覆盖更后面的 backend 打开失败）。用户手改或外部损坏 `config.json` 会把应用变砖且无恢复路径。建议：按 schema reset 同样处理（带备份），或路由到同一恢复对话框。
- **`runtime-parity.ts` 保留模块但删除其 667 行测试，成为死代码**（`electron/runtime/runtime-parity.ts`）：全仓无引用（仅 docs 提及）；该模块在本分支仍被修改（layer 过滤、`role` 移除、`sourceHash` 新增），改动零覆盖。建议：删除模块（并更新 `docs/architecture.md:142`）或恢复归一化测试。

### 测试与构建

- **`benchmarks/cases/cases.test.ts` 从所有门禁掉落**（`vitest.config.ts:13`）：该套件（manifest 加载、checksum 漂移拒绝、不安全路径、agent-descriptor 泄漏检查）完全确定性且其依赖的 `benchmarks/private` 已提交；原先经 `npm test` 的 `benchmarks/**/*.test.ts` 包含运行，现在被排除，只剩 `npm run test:benchmark-cases` 可触发，而 CI（`.github/workflows/ci.yml` 只跑 `npm test`/`test:e2e`/`npm run build`）与 AGENTS.md 都未提及该脚本。manifest 完整性回归现在能通过所有门禁。建议：CI 或 `npm test` 纳入 benchmark-cases 配置。
- **已移除的 conversation artifact 仍有残留引用**（`docs/requirements.md:527`、`benchmarks/README.md:111`、`benchmarks/runner/group-runner.ts:546`）：requirements 仍要求每个 traced trial 生成 `conversation.restricted.md`（序列化器已删）；README 仍描述其产出；group-runner 仍把它列入 `restrictedArtifacts` 且 `group-runner.test.ts:89` 断言该字符串——测试通过但记录着一个不可能存在的 artifact。建议：更新三处来源与断言。
- **长工具结果布局 e2e 删除未补**（`e2e/artifact-layout.spec.ts`）：master 的"20,000 字符 tool result 不溢出卡片"用例被删，被守护的代码仍在（`ToolCallCard.vue:133`、`conversation-content.css:315`）。建议：用 fake provider 的 `toolCallDelta` 驱动重写该用例。

## P3（建议与规范，按领域汇总）

### Persistence（8）

| 位置 | 问题 |
| --- | --- |
| `message-repository.ts:227` | `setInHistoryThrough(true)` 未排除 `visibility='superseded'` 行，会违反 schema CHECK；当前唯一调用方传 `false`，属 footgun |
| `migrations/0001_initial.sql:177` | `file_changes.assistant_message_id` 无 FK 无索引，与全 schema 严密的引用完整性风格不一致 |
| `database-service.ts:33` | `read()` 给出的 `PersistenceReader` 可执行写操作，绕过写队列/事务/事件发布；仅靠调用方自律 |
| `database-service.ts:188` | 两进程首次打开同一新库时的迁移竞争（单实例 Electron/独立 headless 目录下不太可达） |
| `message-repository.ts:79` | `listThrough` 无调用方且硬编码 `513`；`desktopDatabasePath`/`headlessTrialDatabasePath` 仅测试引用，与 `main.ts:153`、`headless/runner.ts:120` 的内联 `agent.db` 形成双真相源 |
| `migrations/0001_initial.sql:42` | parent-clearing trigger 静默改子 session 且不发事件；将来若加单 session 删除会导致 replica 失同步 |
| `electron/persistence/*` | 新增文件公共 API 普遍缺文档注释（违反本分支 `2d398ff` 刚写入 AGENTS.md 的强制要求） |
| `scripts/sqlite-smoke.cjs:123` | 子进程继承全部环境变量（含 `DEEPSEEK_API_KEY`），与"凭证不进入子进程环境"的规则相抵；建议白名单 env |

### Application（7）

| 位置 | 问题 |
| --- | --- |
| `create-backend-runtime.ts:74-78` | 单个 listener 抛错会阻断本次 commit 向其余 listener 的投递；建议逐个 try/catch |
| `create-backend-runtime.ts:222-235` | 启动失败时 `dispose()` 抛错会跳过 `database.close()`；`dispose()` 不等待 coordinator 队列排空，关闭中与在途命令竞争 |
| `application-error.ts:48-52` | 非 `PersistenceError` 统一误标 `PERSISTENCE_FAILURE`（含 rewind/fork 中的校验类错误），IPC 客户端无法区分"坏请求"与"库损坏"，且原始 message 被丢弃 |
| `live-session-context-registry.ts:480-497` | idle 守卫不看 `SessionState.mutationInProgress`（`updateSessionMode`/`updatePlanStatus` 使用）；已推演交错均可收敛，但属盲区 |
| `durable-backend-runtime.test.ts` | 1,107 行，超过 AGENTS.md 对测试文件的 1,000 行上限；`session-service.ts` 928 行接近上限 |
| `electron/application/*` | 新增服务类与 `session-branch.ts`/`file-change-filesystem.ts` 导出函数缺文档注释 |
| `file-change-filesystem.ts:33-147` | symlink 拒绝、realpath 包含性、改名前二次校验等安全分支无直接测试（AGENTS.md 要求覆盖安全敏感分支）；`MAX_CACHED_RUN_STARTS` 逐出路径同样无测试 |

### Session 核心（5）

| 位置 | 问题 |
| --- | --- |
| `session-manager.ts` | 1,073 行，超过 1,000 行约定；durable record/application 方法可移出 |
| `electron/session/*` | `canonical-history.ts`、`SessionToolRunner`、`SessionInterjectionCoordinator`、`session-runtime-snapshot.ts`、`session-run-utils.ts`、`file-change-execution.ts` 等新增公共 API 缺文档注释 |
| `slash-commands.ts:61-81` | `orchestrationPrompt` 的 `'compact'` 分支随调用方移除成为死代码 |
| `session-run-controller.ts:171` | `clientRequests` map 只增不减，长会话无限累积；建议容量或 TTL |
| 测试缺口 | P1-3 的 reasoning 映射、prepareMutation 阻断、终态 interrupt、carryOver 窗口、interjection-commit 失败均无测试 |

### Provider（6）

| 位置 | 问题 |
| --- | --- |
| `deepseek-provider.ts:301,315` | 纯 tool-call 响应不设置 `firstTokenAt`，`timing.ttftMs` 恒为 `null` |
| `provider.ts:61` | `prefixFingerprints` 唯一生产者从不填充，transcript 恒记录 `[]`；实现或删字段 |
| `shared/model-route.ts:8` | `ProviderPurposeSchema` 的 `'title'` 无任何生产者/消费者，属投机性契约面 |
| `model-route-resolver.ts:48-50` | `resolveModelProfiles` 强制包含 `includeModelId`，`.find` 不可能失败，错误分支为死代码 |
| `session-provider-turn.ts:88` | `assertImmutableRequest` 用 `JSON.stringify` 比较，对 key 顺序敏感，可误拒语义等价的 hook 改写 |
| `electron/providers/*` | 新增导出（`ChatCompletionsAdapter`、`HttpSseTransport`、`resolveRunRoutes` 等）缺文档注释 |

### IPC / shared（7）

| 位置 | 问题 |
| --- | --- |
| `shared/session.ts:124` | `assertSessionSnapshotSemantics` 在产品代码中无调用（仅自测试引用）；接入 producer 或删除 |
| `ipc/validators.ts:15-17` | 注释仍引用已删除的 markdown 导出通道作为 size 上限理由 |
| `ipc/event-sink.ts:49-51` | 非 commit 投递的报错路径使用可能陈旧的 validator errors（当前不可达） |
| `shared/json.ts:35`、`shared/model-route.ts:41,46`、`shared/message.ts:466,513,545`、`shared/session.ts:124,151`、`shared/file-change.ts:83,106` | 新增公共函数缺文档注释 |
| `shared/runtime-state.ts:69` | `schemaVersion` 硬编码 `Type.Literal(1)`，未复用 `DurableSchemaVersionSchema` |
| `shared/ipc-contract.ts:429-431` | `plan:update-status` 结果复用 `session:update` 的 schema，未来改动会隐性联动 |
| `ipc/index.ts:120-125` | `INVALID_PAYLOAD` 错误消息（`allErrors: true` 拼接）可超过 `IpcErrorSchema` 的 4096 上限且无结果端校验；建议截断 |

### Renderer（8）

| 位置 | 问题 |
| --- | --- |
| `src/stores/agent-runtime.ts` | 999 行贴近上限且零文档注释；新 stores（replica/runtime/helpers/facade）均无注释 |
| `agent-runtime.ts:529` | `retryUserMessage` 重置 `lastEventSeq`，但后端 retry 复用 live session、seq 单调递增；重置打开了重复应用旧事件的窗口 |
| `agent-replica.ts:307-316` | `pruneCaches` 只遍历 `messagesBySessionId`，只存在于 `fileChangesBySessionId`/`runtimeBySessionId` 的会话永不清剪 |
| `agent-replica.ts:111-112` | `bootstrap` 无条件清 `error` 并返回 true，掩盖 `loadSession` 失败 |
| `ProjectSidebar.vue:87-93` | 搜索防抖只守派发，两个在途 `searchSessions` 可乱序返回，旧查询覆盖新结果；`:71-78` 依赖非空断言 |
| `DiffTab.vue:24-36,147-153` | `FileChangeSummary` 已无 `runId`，过滤实际按 `callId` 分组但 UI 仍叫"按 run 过滤" |
| `agent-project.ts:32-58` | 链式加载中 `loadBackendStatus` 在 await 后重读 `activeProjectId()`，中途切换项目会混合 A 快照与 B 状态 |
| `agent-runtime.ts:853-855` | `closeRuntimeSession` 是恒返回 false 的死 stub，`MessageComposer.vue:414` 仍在 provider 切换时 await 它 |

### 基础设施（4）

| 位置 | 问题 |
| --- | --- |
| `headless/runner.ts:403` | 外层 `finally` 中 `dispose()` 抛错会跳过临时 DB 目录清理；`rm` 失败会让已成功写出 `result.json` 的 run 抛错 |
| `main.ts:216` | 恢复对话框把所有 `createBackendRuntime` 失败都标为"数据库无法打开或迁移"，"重试"会对确定性失败无限循环 |
| `electron-env.d.ts:9`、`sql-raw.d.ts:1` | 重复声明 `'*.sql?raw'` ambient module，应删其一 |
| `headless/runner.ts:237` | auto-plan-approval 假设 `updatePlanStatus` 必成功，失去 master 的优雅拒绝路径（headless 下实际不太可达） |

### 测试与构建（1）

| 位置 | 问题 |
| --- | --- |
| `benchmarks/runner/conversation-artifact.ts:8`、`e2e/support/app-helpers.ts:298,349` | 本分支新增的公共函数缺文档注释（恰违反本分支自己写入 AGENTS.md 的规则）；`conversation-artifact.ts` 文件名与内容（session transcript）已不符 |

## 分领域小结

- **Persistence（新层，约 1,600 行产品代码 + 1,300 行测试）**：基于 `node:sqlite` 的 `DatabaseService`（串行写队列、带校验和的版本化迁移）、四个 repository（乐观 revision 更新、有界游标分页）与 ajv 双端校验 codec。schema 约束严密（复合 FK、CHECK 不变量、覆盖索引），SQL 全参数化，无数据丢失/安全问题；发现集中于潜伏健壮性（含 transaction API footgun）与规范项。
- **Application services（新层）**：`ApplicationStateCoordinator` 串行化 + 三个领域服务 + durable run 桥 + live/durable 相位机。事务原子性、乐观并发检查（revision+lastSeq 在事务内）、revert 的守卫与原子改名都扎实；但 revert 目标取当前 project path 构成 P1-1 的跨 workspace 写入路径，另有 teardown 竞态、project 容量语义与边界去重缺口。
- **Session 核心**：canonical `MessageRecord[]` 历史取代 `ProviderMessage[]`，run/turn/batch 边界 durable commit，file-change prepare-before-execute/commit-after-verify。结构清晰、happy path 测试充分；但审批路由有 1 个安全相关回归（P1-3），cancel/carryover 周边有多个丢消息竞态（部分 master 已存在）。
- **Provider 层**：单体 provider 拆成 transport/adapter/route-resolver 三层。SSE 解析覆盖分片 CRLF、多行 `data:`、`[DONE]`、未完结尾部；凭证仅进 `authorization` 头，错误不泄漏上游 body；累积有界。发现集中在快乐路径之外（P1-2/P1-3、usage 归因、catalog 上限）。
- **IPC / shared 契约**：`shared/` 全程纯净；每个 channel 有 sender 校验 + 载荷大小/深度/原型限制 + AJV 双端校验；workspace 处理器从 renderer 传路径改为后端 project 注册表解析（安全性提升）。主要缺口是 preload 重放风暴与 app-handlers 测试删除。
- **Renderer**：改为 server-authoritative replica + per-session ephemeral overlay，cursor 去重/空洞重同步逻辑正确且有测试，i18n 双语 480 键完全对齐，无已删模块悬挂引用。但 interjection 流两处回归、timeline 排序不变量丢失、double-submit 守卫丢失（P1-4/5/6/7），session/message/file-change 三类分页均未接入 UI（P1-8/P1-9 + P2），且重写区几乎无测试。
- **主进程基础设施**：main.ts 经 `createBackendRuntime` 启动带恢复对话框、config v9 硬 epoch（开发期策略见 M-6）、trace v2、headless 复用同一 backend。契约同步到位；发现为 headless reasoning 变更（P1-10）及若干失败路径健壮性。
- **测试与构建**：新 e2e（durable helpers、动态端口、无 sleep、串行 harness）确定性好，benchmark 修复了 `maxStepsPerRun: 0` 语义；但 artifact 移除留下一个确定性失败测试（P1-11）、若干残留引用，且 `cases.test.ts` 静默掉出所有 CI 门禁。

## master 上已存在的问题（非本分支引入，建议顺带修复）

- **`terminal_send` 工具在 Windows PowerShell 下裸 `\n` 不提交命令（用户实测反馈，已实验证实）**：`terminal_send` 的 `data` 字段描述为 "Include a trailing newline to press Enter"（`electron/tools/terminal-tools.ts:58-59`），实现原样透传 `terminalPool.write`（`:147-151`）。但在 Windows conpty + 未加载 PSReadLine 的 PowerShell（本机默认环境）下，Enter = `\r`，裸 `\n` 只是把字符留在输入行而不提交。已用 node-pty 实验验证：发送 `echo X\n` 后输出只有按键回显、无执行结果，补发 `\r` 才执行；`\r`/`\r\n` 均正常。LLM 按文档自然发送 `\n`，于是命令永远不执行——agent 读到"提示符在但无输出"，反复等待/补发内容，最终把未提交的行拼成含未闭合引号的输入，触发 `>>` 续行提示，并误判为"PowerShell 双引号解析问题"。这与用户观察到的 agent 行为完全一致。建议：Windows 下将 `data` 中的裸 `\n`（非 `\r\n` 一部分）归一化为 `\r`，并把字段描述改为明确要求 `\r`；顺带可让 `terminal_read` 提示"输入行有未提交内容"。
- `session-run-controller.ts:546-556` carryOver/finishRun 窗口丢 interjection（P2）。
- `session-tool-runner.ts:333-339` + `session-run-controller.ts:243-257` side-effect settlement 拒绝导致 writer lease 泄漏（P2）。
- `session-run-controller.ts:176-186` `interrupt()` 无终态守卫（P2；新 snapshot 使其陈旧状态用户可见）。

## 已接受/暂缓风险（`docs/decision-log.md` 已记录，不计入发现）

| 风险 | 当前决策 |
| --- | --- |
| FC-1：FileChange revert 最终 rename/unlink 的外部 TOCTOU | 已接受；workspace 边界为 best-effort。注意 P1-1 是确定性逻辑路径，不属于本条 |
| APP-6：极端 1000+ in-flight 请求缓存逐出 | 已接受；桌面/Headless 32 并发上限下不可达 |
| REQ-1：`run:start` request hash 只覆盖消息正文 | 暂缓；正式 renderer 每次生成新 request ID |
| FC-3：`beforeContent` 与 `beforeHash` 不交叉校验 | 已接受；前提为 SQLite 损坏或外部篡改 |
| M-6：未发布 AppConfig v9 的 reset-only 策略 | 已接受为开发期策略；分发真实用户前必须重新决策（对应 P2 发布门禁项） |

## 建议修复顺序

1. **Workspace 安全与审批门控**：P1-1（revert workspace identity 校验）；P1-2 恢复缺凭证容忍/惰性解析 + P1-3 恢复 `'off'→'high'` 转换（同文件，一起修并加行为钉住测试）。
2. **Renderer 交互回归**：P1-4（double-submit 守卫）→ P1-5/P1-6（interjection 流重写 + 测试）→ P1-7（排序域统一）。
3. **分页接入**：P1-8（session 分页 + 搜索命中可直接打开）、P1-9（message"加载更早"入口）、P2（file-change 分页），并补 201+ 边界的 renderer/E2E 回归。
4. **兼容性与测试止血**：P1-10（headless reasoning 默认对齐）、P1-11（docker-worker 断言）、`cases.test.ts` 回归 CI、`app-handlers` 导出门禁测试。
5. **竞态与状态机组**：session 核心 P2 组（cancelling 冲掉、carryOver 窗口、rootUserMessageId、settlement 泄漏，含两条 master 遗留）+ teardown 竞态（原 M-3）。同批建议顺带修 `terminal_send` 的 `\n`→`\r` 归一化（master 遗留，一行改动即可解除 agent 在 Windows 终端上的系统性误判）。
6. **P2 收尾**：project 512 容量语义、transaction API 收紧、usage 归因、config 发布门禁（M-6 关闭条件）、trace 清理、启动崩溃恢复。
7. **规范批次**：公共 API 文档注释（本分支自定规则，自身违反最多）、死代码清理（runtime-parity、listThrough、closeRuntimeSession 等）、文件超长拆分。

## 前后端状态一致性专项核查（2026-07-25，复检后补充）

针对本次重构的核心目标（业务状态统一收归后端、消除多份状态不同步），对当前 HEAD（`db8072a`）做专项核查。

**已达成的部分**：durable 状态单写者（`ApplicationStateCoordinator` 串行化"事务 → cursor 分配 → 发布"）+ renderer replica 按 cursor 去重/空洞检测/重同步（含 `bootstrapInFlight` 合并）；runtime 状态按 per-session `eventSeq` 复制（`writer.changed` 误报已修）；会话关闭/驱逐时终端 `closed` 事件可到达 renderer（`pool.ts:346`、`session-manager.ts:634` 先关终端再移出 map）；config 单源 + revision 钉住凭证。初审/复检发现的主动 desync 问题（终态清流竞态、carryover、工具排序、retry seq 重置等）均已修复。

**仍开着的结构性 desync 通道**（DB 变更绕过 commit 发布——正是本重构要消灭的问题类，目前靠"不可达/调用方自律"而非结构封死）：

1. **`prepare('COMMIT')` 提前提交（复检部分修复的残留）**：事务 callback 仍可经 `prepare` 执行事务控制 SQL——coordinator 报失败、不分配 cursor/不发事件，但数据已落库："假失败真落库"，所有 replica 永久落后且调用方以为未写入（`database-service.ts:48-51`）。建议：事务内拦截事务控制语句并加拒绝测试。
2. **`PersistenceReader` 可写（P3 未修）**：`read()` 回调可同步执行任意写，绕过写队列/事务/cursor/发布（`database-service.ts:33-43`）。建议：`read()` 期间只读化（或结构性封装），至少写明契约。
3. **parent-clearing trigger（P3 未修）**：删除 session 行会静默 NULL 子会话 `parent_session_id`/`forked_from_seq`，无 revision 变更、无 commit——将来一旦新增单会话删除入口，replica 立即静默分叉（`0001_initial.sql:42-48`）。建议：删除 trigger，改由 service 层显式更新子会话并为每个受影响会话发 commit。
4. **发布循环无 per-listener 守卫（P3 未修）**：一个订阅者抛错会阻断本次 commit 向后续订阅者的投递（`create-backend-runtime.ts:76-78`）；renderer replica 有 cursor 自愈，其他类型订阅者（插件/未来消费者）静默漏 commit。建议：逐个 try/catch + 诊断。

**仍开着的功能性不一致**：

- **N-1（复检新发现，P2）**：carryover flush 失败后 UI 显示 queued 的 interjection 后端已丢弃——用户所见与后端真实状态相反，且会话输入被锁死（`agent-runtime.ts:819-821`）。
- `agent-project` 竞态（P3 未修）：`loadProject` 中途切换项目会把 A 项目快照与 B 项目 backend 状态混合显示（`agent-project.ts:38-58`）。
- `closeRuntimeSession` 死 stub（P3 未修）：`MessageComposer.vue:414` 仍 await 一个恒返回 false 的空实现，UI 契约暗示的运行时清理实际不发生。

**结论**：新架构的同步主链路是健康的，前/后端状态不一致的存量风险集中在上述 4 条"无事件 DB 变更"通道——建议按上述方向做结构化封堵（均为小改动），并把 N-1 与 N-2 纳入合入前修复。
