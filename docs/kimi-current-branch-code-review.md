# Kimi 当前分支 Code Review 报告（终审稿）

> 审查日期：2026-07-25
>
> 终审基线：`refactor/backend-state-v2`（HEAD `e035a27`）
>
> 注释收口：`docs/public-api-comments`（基于 `e035a27`，2026-07-26）
>
> 对比基线：`master` 的 merge-base `6cb4a0819734ce68166635a82422872011a21b1b`
>
> 本稿说明：本报告历经三轮——初审（`c3f0e8d`，11 P1 / 31 P2 / 46 P3）、复检（`db8072a`，确认 11/11 P1 与绝大部分 P2 修复）、终审（`e035a27`，本稿），并在后续注释收口中关闭公共 API 文档存量。**已修复并经复检/终审确认的条目已全部移除，本稿仅保留当前仍未解决的问题**。历史版本见 git 历史。

---

## 结论

重构目标（业务状态统一收归后端）已达成，durable 单写者 + commit cursor / event seq 双通道复制 + gap 自愈的主链路健康；naive-ui 迁移（主题单源、组件替换、确认对话框、NMessage 反馈）也已落地。

当前 **无 P0/P1**。剩余 **5 个 P2**（4 个渲染层存量 + 1 个 naive 迁移引入的定位回归）与 **23 个 P3**（结构性健壮性、规范与可接受延后项）。另有 1 项产品决策待定（sendFirst）。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` / `lint` / `format:check` | 通过 |
| `npm test`（vitest 确定性套件，含 benchmarks/cases） | 通过：115 文件、776 通过、8 跳过（跳过项为 opt-in docker/real-api） |

注释收口新增 `lint:api-docs` 静态门禁，覆盖 `electron/`、`shared/`、`src/` 与 `benchmarks/` 的生产 TypeScript：所有类、公开类方法和导出函数均必须有职责注释。共补齐并人工复核 677 条注释；扫描结果为零缺口，且注释补齐未引入新的代码行为问题。

## P2（建议处理，均为用户可感知的行为问题）

- **naive 迁移引入：back-to-bottom 按钮定位回归**（`src/components/chat/ConversationTimeline.vue:290-297`）：自制按钮换成 `NFloatButton` 后，naive-ui（2.44.1）为 FloatButton 写死内联 `position: fixed`，压过 `.back-to-bottom` 的容器内 sticky 定位（`src/styles/conversation-layout.css:145-164`）；`bottom: 10px` 变为相对视口——按钮钉在窗口底部（遮挡 composer 区），而不是跟随时间轴滚动容器底部。建议：不用 FloatButton 的 fixed 定位（包一层容器或用 NButton round + 原 sticky 方案），并补布局断言。
- **live 工具区双序混用（N-3 遗留）**：`hydrateRuntime` 仍给 hydrate 工具 `order: index + 1`（`agent-runtime.ts:310`）且不重置 `overlay.order`，后续 `tool.proposed` 用从 0 起计的 `overlay.order`（`agent-runtime-events.ts:54,150`）；tools getter 按 order 排序（`agent-runtime.ts:232-234`）。run 中途刷新（gap 重载）后 live 区内工具排序短暂错乱，run 落库后自愈。建议：hydrate 时以当前 `overlay.order` 为基数续排，或统一改为到达序数组。
- **cursor 重同步切走选中会话（N-4 遗留）**：gap/backendInstance 不匹配触发 `bootstrap()`（`agent-replica.ts:407-416`），sessions 被整体替换为第一页（`:166`）；旧选中不在第一页时选中态被切到该项目最新 active 会话（`:177-188`）——正在查看 200+ 之外会话的用户会被跳走。建议：重同步时保留 `selectedSessionId` 并单独 `getSession` 补回，或不清空已有页。
- **`loadProject` 中途切换项目混状态**：`getProject` 落地 A 项目 snapshot 后，`loadBackendStatus` 在 await 前重读 `activeProjectId()`（`agent-project.ts:32-58`），无 generation 守卫——中途切到 B 项目会短暂/持久显示 A 快照 + B backend 状态。建议：传递捕获的 projectId 并在落地前校验选中未变（`ProjectSidebar` 搜索已有同款 `searchGeneration` 模式可复用）。
- **carryover flush 的 early-return 不清队列（N-1 修复的残余边缘）**：主路径已修（失败即丢弃队首 + 警告 + 续跑 FIFO，`agent-runtime.ts:836-899`），但 bridge 缺失/会话非 active 时 early-return 仍不清队列（`:827-835`），重触发仅靠 run 终态事件——该边缘下队列可能滞留并持续拦截 `canSend`。建议：不可恢复条件下同样丢弃或过期清理。

## P3（健壮性 / 规范 / 可接受延后）

### 后端结构性通道（"DB 变更绕过 commit 发布"的残留，目前靠不可达/自律）

- `PersistenceReader` 可在 `read()` 内同步执行写操作，绕过写队列/事务/cursor/发布（`database-service.ts:41-51,116-119`）。`prepare('COMMIT')` 通道已由 authorizer 封死（`:146-167`），此条是同族的最后一道。
- parent-clearing trigger 静默 NULL 子会话 `parent_session_id`，不发 commit；将来新增单会话删除入口即静默分叉（`0001_initial.sql:42-48`）。
- `file_changes.assistant_message_id` 仍无 FK/索引（0003 迁移未顺手补）。
- `setInHistoryThrough(true)` 未排除 `visibility='superseded'`，会违反 schema CHECK（`message-repository.ts:233-239`；唯一调用方传 `false`）。
- 双进程首次打开同一新库的迁移竞争（无 single-instance lock；失败方 `MIGRATION_FAILED`，`database-service.ts:197-258`）。
- `application-error.ts:48-52` 未知错误统一误标 `PERSISTENCE_FAILURE`，原始 message 被丢弃。
- idle 守卫不看 `mutationInProgress`（`live-session-context-registry.ts:511-521`；新增 `'mutating'` 相位只接给了 file-change revert，`updateSessionMode`/`updatePlanStatus` 未接入）。

### 后端死代码/小问题

- `listThrough` 零调用方且硬编码 513（`message-repository.ts:79-102`）；`desktopDatabasePath`/`headlessTrialDatabasePath` 仅测试引用，与 `main.ts:157`、`headless/runner.ts:130` 内联 `agent.db` 双真相源。
- `scripts/sqlite-smoke.cjs:122-128` 子进程全量继承环境变量（含 API key），建议白名单。
- headless `runner.ts:415-420`：`dispose()` 抛错跳过临时 DB 目录清理；`rm` 失败掩盖已写出的 result（仅 createBackendRuntime 失败路径已补清理）。
- `main.ts:211-239` 恢复对话框把所有后端启动失败标为"数据库无法打开或迁移"，Retry 对确定性失败无限循环。
- `electron-env.d.ts:9-12` 与 `sql-raw.d.ts:1-4` 重复声明 `'*.sql?raw'`。
- headless auto-plan-approval 无 `updatePlanStatus` 失败的优雅路径（`runner.ts:246-250`）。
- `event-sink.ts:68-69` 非 commit 投递的报错使用陈旧 validator errors（当前唯一调用点只发 commit）。
- provider P3 组：纯 tool-call 响应 TTFT 恒 null（`deepseek-provider.ts:246,260,379`）；`prefixFingerprints` 无生产者（`provider.ts:46`）；`'title'` purpose 死契约（`shared/model-route.ts:8`）；resolver 死分支（`model-route-resolver.ts:43-50`）；`assertImmutableRequest` key 顺序敏感（`session-provider-turn.ts:88`）。
- **新发现**：启动失败清理路径 `settleCleanup` 自身抛错会掩盖原始启动错误（`create-backend-runtime.ts:249-256`）；通知分类/去重基于对诊断消息文本的前缀匹配，与产处文案隐式耦合（`backend-notification-reporter.ts:108-136`）；脱敏正则漏 JSON 带引号形式的凭证（`backend-notification-reporter.ts:81`，当前无产出处，有 1024 有界兜底）。

### 渲染层

- `closeRuntimeSession` 死 stub（`agent-runtime.ts:1033-1035`），`MessageComposer.vue:432` 仍 await；`hydrateRuntime` 的 `resetEventSequence` 死参数（`:288-295` 无调用方）；`agentEventGap` getter 已无 UI 消费（迁移残留）。
- ToolCallCard 迁入 NCollapse 后展开/收起不再触发 `onContentResized()` 滚动补偿，followingOutput 时展开大结果会把视图顶离底部。
- 诊断提示从持久内联 banner 降级为一次性 10s warning toast（`AppMessageBridge.vue:93-104`），用户错过后无持久指示。
- `WorkbenchDialogs.vue:114-152` delete/revert/yolo/rename 确认未传 `:loading`，确认进行中 positive 可重复点击（有 expectedRevision 兜底），各调用点关窗时机不一致。
- xterm 主题色值仍硬编码（`TerminalPanel.vue:108-118`），未进 `src/theme/naive-theme.ts` 的 palette 单源。

### 产品决策待定

- **sendFirst**：草稿状态终端面板只显示"先发送一条消息"且禁用新建（`TerminalPanel.vue:533,577-582`）。用户实测认为不符合使用体验；`terminal_send` 已新增 `delayMs`（cfafda0，合理），但终端必须先有会话的限制仍在。需要产品决策：保留现状，或恢复"按需创建会话/一键创建并打开终端"。

## 已修复并验证（摘要）

- **后端**：P1-1 回退跨 workspace（迁移 0002 + 双重校验）、P1-2/P1-3 审批路由（可选增强 + reasoning 强制转换）、M-2/M-3（project 容量、teardown promise）、N-2（retry 缓存失败淘汰）、事务 authorizer 封死事务控制 SQL、发布 listener 逐个隔离、dispose 排空队列、0003 retention totals、provider wire 契约隔离（7b0a5a7，有边界测试钉住）。
- **渲染层**：P1-4~P1-9（双提交守卫、carryover 流、去重、排序分区、两类分页）、N-1（carryover 锁死）、终态竞态、writer.changed 误报、测试覆盖重建。
- **基础设施**：cases.test.ts 回归 `npm test`、P10 verify 单一入口（`verification-policy.test.ts` 钉住 CI/release 各恰好一次 `npm run verify`）、损坏 JSON 恢复、trace 清理分类、runtime-parity 删除。
- **代码规范**：补齐 677 条类、公开类方法和导出函数职责注释；新增 `lint:api-docs`，后续缺口会直接使 `npm run lint` 失败。
- **前端**：naive 主题单源（`src/theme/naive-theme.ts`，palette 同出 CSS 变量与 themeOverrides）、侧栏/表单/tabs/状态徽章/反馈（NMessage）/确认对话框全部迁移，window.confirm/alert 零残留；主题双轨与 `.n-* !important` 覆盖已收敛。
- **用户实测项**：事件空洞误报、工具卡片排序、`terminal_send` 裸 `\n`（归一化 + `delayMs`）、日志开启（SessionTraceController 分段捕获，live 会话即时生效）均已修复验证。

## 已接受/暂缓风险（`docs/decision-log.md`，不计入发现）

| 风险 | 当前决策 |
| --- | --- |
| FC-1：revert 最终 rename/unlink 的外部 TOCTOU | 已接受；workspace 边界 best-effort |
| APP-6：极端并发请求缓存逐出 | 已接受；32 并发上限下不可达 |
| REQ-1：request hash 只覆盖消息正文 | 暂缓；renderer 每次生成新 ID |
| FC-3：`beforeContent`/`beforeHash` 不交叉校验 | 已接受；前提为 DB 损坏/篡改 |
| M-6：AppConfig v9 reset-only（含损坏 JSON、无备份） | 开发期接受；**分发真实用户前必须关闭**（备份/提示/secret orphan 清理） |
| M-1：FileChange 预写失败 run 级 fail-closed | 已决策 |

## 建议处理顺序

1. **合入前**：NFloatButton 定位回归（P2，naive 迁移新引入）。
2. **下一迭代**：N-3/N-4/loadProject/carryover 边缘四个渲染层 P2。
3. **发布门禁**：关闭 M-6（config 备份/提示/orphan 清理）；sendFirst 产品决策。
4. **持续批次**：后端结构通道（reader 只读化、trigger 拆除、FK 补齐）与其余 P3。
