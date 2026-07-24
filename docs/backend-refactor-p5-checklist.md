# Backend Refactor P5 Checklist

P5 在 `refactor/backend-state-v2` 的 isolated durable target 中实现 FileChange 持久化、分页和安全回退。Desktop、Headless、legacy IPC/preload 与 renderer 默认路径尚未切流。

## Contracts 与配置

- [x] AppConfig v9 必填 `limits.fileChangeHistoryBytes`，默认 `100_000_000`，范围 `1_000_000`～`10_000_000_000`。
- [x] 缺少字段的旧 v9 配置按 reset-only 策略重建。
- [x] FileChange history 无条数上限；`MAX_FILE_CHANGE_PAGE_RECORDS = 200` 只限制单页。
- [x] `(createdAt, id)` 倒序 cursor 分页无遗漏、无重复。
- [x] Commit event 使用有界 `upsert | invalidate_all` union。
- [x] Application error 增加 backend-private `RESOURCE_CHANGED`。

## Persistence 与工具执行

- [x] 全应用字节 retention 与 insert 共用一个 transaction，并使用有界 SQL batch 淘汰最旧记录。
- [x] `payloadBytes` 严格等于 UTF-8 `beforeContent + diff`，不保存 `afterContent`。
- [x] Repository 只允许 `markReverted` 修改 revision/timestamps/revertedAt，不存在扩大 payload 的 update。
- [x] Run 起始冻结 FileChange 字节预算；单条超限在 ToolExecutor 前失败。
- [x] 仅内建 `create_file/apply_patch/delete_file` 进入 durable FileChange port。
- [x] 副作用成功后重新验证 after existence/hash，再提交 FileChange。
- [x] FileChange commit/event 先于完整 tool-batch Message commit。
- [x] 持久化失败和 after mismatch 保持真实 `mutationSucceeded = true`，同时返回 warning 与 `revertAvailable = false`。
- [x] Durable target 不双写 legacy `change-history.json`。

## Revert 与并发

- [x] Revert 在第一次 await 前预留 Session `mutating` lifecycle token。
- [x] Revert 与 Provider writer Run/其他 revert 共用 workspace writer；不占 Provider run slot。
- [x] 同 workspace readonly Run 和不同 workspace writer 可并行。
- [x] Revert I/O 窗口阻止同 Session Run/archive、Project path update/remove 和重复 revert。
- [x] PathGuard、普通文件、symlink、realpath、workspace 边界和 after hash 均在覆盖前验证。
- [x] create/patch/delete 分别恢复缺失文件、before snapshot 或安全删除 Agent 创建文件。
- [x] `markReverted` 使用 expected revision OCC；重复、stale 和 missing record 返回不同错误。
- [x] 文件已恢复但 marker 持久化失败时返回 `PERSISTENCE_FAILURE`，details 标明副作用已发生。

## 隐私与边界

- [x] `beforeContent` 只存在于 backend-private codec/SQLite record。
- [x] Public summary、page、commit event、tool result、canonical Message 和 trace 不包含 private snapshot 字段。
- [x] 不增加 polling、后台 retention timer、通用 filesystem audit 或旧 JSON migration。
- [x] 不实现 renderer Diff 面板、P6 IPC handler 或 P8 production composition 切流。

## 验证

- [x] Config reset/range/default、分页超过 200 条、全应用 retention、降低预算收敛和 rollback。
- [x] create/patch/delete、after mismatch、持久化 warning、多阶段 commit 顺序和 restart list/revert。
- [x] RESOURCE_CHANGED、stale/repeat revert、writer/lifecycle 冲突和 marker persistence failure。
- [x] `npm test`
- [x] `npm run lint`
- [x] `npm run format:check`
- [x] `npm run typecheck`
- [x] `npm run test:native`
- [x] `npm run test:ripgrep`
- [x] `npm run test:sqlite`
- [x] `npm run test:sqlite:packaged`（非 Windows host 明确 skip）
- [x] `npm run test:e2e`
- [x] `npm run build`

`npm run test:real` 保持 opt-in，不属于 P5 确定性门禁。
