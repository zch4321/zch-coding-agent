# Backend State v2 全量代码审查

审查日期：2026-07-23
审查范围：`refactor/backend-state-v2` 相对 `master` 的 `master...HEAD`（147 个文件，15,946 行新增、3,277 行删除）。本报告只记录审查发现，未修改产品代码。

## 结论

当前分支的 P4 durable target 已有较完整的覆盖，但仍存在多条会破坏 durable 状态、首次发送或工具副作用审计的并发/失败路径。它们应在 P4 被接入生产 Desktop、Headless 或 IPC 之前修复。完整测试通过不能覆盖这些跨异步边界的竞态和失败注入场景。

严重级别：P1 表示会造成错误持久化、丢失可用状态、错误命令结果或未审计副作用；P2 表示契约、恢复或可用性缺陷；P3 表示文档准确性问题。

## P1

### P1-1：并发的 `new_session` 首次发送可以取消已经获胜请求的 durable binding

位置：`electron/application/durable-run-application-service.ts:50-75`、`119-173`；`electron/session/session-manager.ts:293-298`。

`requests` 只按 `sessionId + clientRequestId` 去重。因此，同一候选 `sessionId` 但不同 `clientRequestId` 的两次首次发送会同时通过 `#assertCandidateAvailable()`。较晚的调用会在 live Session registry 中收到 `CONFLICT`，但其 catch 分支无论自身是否创建了 Session 都执行 `executionState.forget(sessionId)`。若较早调用已经注册 binding 并等待首笔 commit，binding 会被删除、waiter 被拒绝，导致本应获胜的首次发送失败并关闭 Session。

应对候选 Session 建立按 `sessionId` 的 single-flight/reservation，并以所有权 token 限制 `closeSession()`、`forget()` 只能清理本调用创建的资源。补充两个不同 `clientRequestId` 并发发送同一候选 ID 的回归测试，断言一个成功、另一个稳定返回冲突且不影响成功者。

### P1-2：lazy restore 不参与 Project/Session 生命周期保护，允许 archive/update/remove 与加载交错

位置：`electron/application/live-session-context-registry.ts:35-43`、`65-70`、`111-133`；`electron/application/project-service.ts:104-159`；`electron/application/session-service.ts:341-374`。

`#load()` 在多个 `await` 之后才把 Session 写入 `#projectBySession`，但 Project guard 只检查这个 map，完全忽略 `#loading`。因此，restore 正在读取旧 Project 路径、创建 PathGuard/MCP/logger 时，Project path 更新或删除仍可成功提交；restore 随后会以旧 workspace 完成。删除时还会留下一个对应行已被级联删除的 live Session。archive 同样可在加载窗口内先持久化 archived 状态和清掉 binding，随后 restore 才完成，留下无法正常使用的 live archived Session。

在第一次异步操作前为 loading Session 建立 project/session lease，并让 archive、Project update/remove 与 run load/start 使用同一生命周期锁；在 `manager.startRun()` 前再次核对 Project/Session 的最新状态。用 deferred restore 测试在加载中调用 archive、path update 和 remove。

### P1-3：已有 Session 的裸 `/compact` 已落盘却向调用方失败，并永久污染该 request ID

位置：`electron/application/durable-run-application-service.ts:198-241`；`electron/application/durable-execution-state-port.ts:173-186`；`electron/session/session-compact-coordinator.ts:177-252`。

P3 明确支持纯 `/compact`。该路径只提交 compact epoch，不会产生带 `clientRequestId` 的原始 `user_input`。但 `#startLoaded()` 一开始总是等待 `beginRequest()`，而 execution-state port 仅在新 records 中找到原始 user message 时才 resolve waiter。compact Run 正常结束后，race 的另一边抛出“Run ended before its user message was committed”；已经保存并发布的 invalidate commit 被调用方当作失败处理。SessionManager 还保留该 `clientRequestId -> runId`，同 ID 重试会继续失败，直到 eviction/reload。

让 execution-state port 能按显式 request ID resolve 非 user-message commit，或让裸 `/compact` 直接等待 compact command；同时在失败路径清除未持久化的 client request。增加裸 `/compact` 返回 `started + invalidate`、重试幂等的 target-runtime 回归。

### P1-4：durable commit 失败后，内存 canonical history 不回滚，后续 Run 会提交先前失败的记录

位置：`electron/application/durable-execution-state-port.ts:94-165`；`electron/session/session-run-controller.ts:340-396`、`442-525`。

执行路径先向 `session.history`、metadata 和 `nextMessageSeq` 写入，再调用 execution-state port。若 SQLite/codec commit 失败，port 不会推进 binding，但外层只把 Run 标记为 failed，不恢复内存 checkpoint，也不 eviction/reload。之后用不同 request ID 启动的 Run 会把所有 `seq > binding.record.lastSeq` 的旧 records 与新输入一起提交；原本失败的 user/assistant/tool batch 因而可在事后变成 durable 事实。原 request ID 又因 live `clientRequests` 缓存无法安全重试。

每个 execution-state commit 前保存并在失败时恢复完整的 Session checkpoint（history、seq、mode、goal、plan、request map），或立即关闭并从 SQLite 重载；清理失败的 request ID。分别针对 run input、assistant turn、tool batch 注入持久化失败并验证下一 Run 不会提交旧记录。

### P1-5：不合法或超限的 Provider tool batch 会在 durable 验证之前执行工具副作用

位置：`electron/providers/deepseek-provider.ts:294-383`；`electron/session/canonical-history.ts:157-215`；`electron/session/session-run-controller.ts:442-517`；`electron/persistence/message-codec.ts:39-45`。

SSE adapter 对累计 tool calls、参数大小、重复 call ID、text/reasoning 大小均未做 canonical schema/semantic 验证。completed turn 被直接 append，然后所有工具先执行，最后才通过 codec 校验 `MAX_MESSAGE_PARTS`、JSON bounds 和重复 call ID。比如 257 个 tool calls 或两个不同 index 使用同一 call ID 都可能已经执行写入/命令工具，却因持久化失败没有可恢复的 assistant/tool audit batch，并触发 P1-4 的污染状态。

在 Provider completed 边界将 turn canonicalize 并按 durable schema、总字节数和唯一 call ID 校验，且在任何 tool execution 前拒绝非法/超限结果；在 SSE accumulation 阶段也限制 call 数与字节数。补充 257 calls、重复 call ID 和超长 arguments 的无副作用回归。

### P1-6：第 513 个 Project 会成功写库但从所有 full-list API 结果中消失

位置：`electron/application/project-service.ts:67-89`；`electron/persistence/project-repository.ts:73-82`；`shared/domain-state-api.ts:52-60`。

Project repository 对 list 固定 `LIMIT 512`，而 add 没有容量检查，插入后仍只返回这个截断列表。第 513 个 Project 的服务端生成 ID 不在 command result、commit event 或 bootstrap 中；现有 API 又没有 Project pagination/get，因此调用者无法获得它来更新或删除。数据库会永久保有 renderer/backend API 均不可见的记录。

在同一 transaction 中计数并拒绝超过 512 的新增，或在协议中提供分页/created record 的增量结果。增加 512/513 边界和原子性测试。

## P2

### P2-1：Session commit 未强制 512 条 message envelope 上限

位置：`electron/application/session-service.ts:216-244`、`264-321`、`526-594`；`shared/domain-state-api.ts:62-84`。

shared contract 将 `messageChange.upsert.records` 限制为 512 条，但 `commitFirstTurn()` 和 `commitMutation()` 只验证连续 seq/active 状态，能写入并发布超过上限的 records。这会生成 TypeScript 类型声称有效、但无法通过 IPC schema 的 commit；以后 P6 handler 对结果验证时会在数据库已提交后失败。

在两个写入口于 transaction 前拒绝第 513 条，或把超大变化转换成 invalidate/page refetch；增加 512/513 的失败前原子性测试。

### P2-2：允许的附件组合可在写库时超过单个 Message text 上限，并触发污染的失败路径

位置：`shared/context.ts:39-44`；`electron/config/schema.ts:129-146`；`electron/session/context-attachments.ts:78-143`；`electron/session/session-user-turn-preparer.ts:117-145`；`shared/message.ts:64-69`。

RunContext 最多允许 32 个附件；默认每个文件可读取 64 KiB，随后全部拼进一个 `selected_context` text part。约 16 个默认大小文件即可超过 1,000,000 字符的 Message schema 上限（配置还允许每个文件至 10 MiB）。错误直到 Session 已追加 context/user 后才在 codec 处出现，随后落入 P1-4 的未回滚状态。

在收集 context 或 append 前实施 aggregate durable byte/character 上限，或拆分成受限 records；增加最大附件数/大小的回归测试。

### P2-3：非 Windows 的 packaged SQLite smoke 在干净 checkout 中可能先失败而不是 skip

位置：`scripts/sqlite-smoke.cjs:105-121`。

`runElectronChild()` 在判断 `process.platform !== 'win32'` 之前调用 `packagedElectronPath()`。当非 Windows checkout 尚未产生 `release/<version>/win-unpacked` 时，`readdirSync()` 会先抛错，因此无法兑现“非 Windows 明确 skip”的脚本契约。

先执行平台 skip，再解析 packaged executable；补充无 release 目录的非 Windows smoke 测试。

### P2-4：`config.json` 为合法 JSON `null` 时不会被自愈写回

位置：`electron/config/migrations.ts:25-28`；`electron/config/store.ts:565-589`。

`migrateConfig(null)` 返回内存默认配置而不抛 `UnsupportedConfigSchemaError`，所以 `#read()` 不会写默认文件。每次启动都会重新读取无效的 `null`；在用户下一次设置写入前，磁盘上的配置始终不是 v9 config，也与“旧版或不兼容配置重建”的行为不一致。

仅把 `undefined` 视为不存在的文件；把 `null` 当作不支持的 root 并走现有删除/重建分支。补充 `null` config 的初始化与重启测试。

### P2-5：Prompt Inspector 删除一列后未同步 CSS grid，关键信息被截断

位置：`src/components/settings/LoggingSettingsPanel.vue:245-251`；`src/styles/settings-content.css:287-305`。

模板现在有 5 个 grid children，但样式仍定义旧的 6 列。`source` 会落在 48px 的旧 role 列，token text 会落在另一个 48px 列，且末尾保留空白列；两项信息在正常窗口宽度下被省略。

将 grid 调整为与 kind/source/messageId/tokens/hash 对应的 5 列，并增加组件或视觉回归测试。

## P3

### P3-1：架构文档同时描述 P4“不存在”和 Desktop/Headless 已切流

位置：`docs/architecture.md:162`、`188-193`、`1490-1492`。

前部仍称 P4 尚未存在，并称 Desktop/Headless 使用 SQLite application/runtime composition；文末则正确说明 P4 target 仅用于 unit/integration，尚未接入 production composition。读者无法据此判断当前运行时事实。

将章节按“当前实现”和“目标架构”明确分隔，并将前部表述更新为 P4 isolated target 的实际状态。

## 验证

以下命令在审查结束时通过：

- `git diff --check master...HEAD`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test`：104 个测试文件通过、2 个跳过；698 个测试通过、7 个跳过。
- `npm run test:sqlite`
- `npm run test:sqlite:packaged`：开发 SQLite probe 通过；当前 Darwin 主机按设计跳过 Windows packaged probe。

现有测试未覆盖本报告中的并发首发、loading lifecycle 交错、裸 `/compact`、commit-failure rollback、非法 Provider tool batch、Project 513 或附件聚合上限场景。
