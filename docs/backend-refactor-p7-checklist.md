# P7 Renderer Replica Replacement Checklist

> 状态：完成 · 2026-07-25

P7 与 P6、P8、P9 一次切流完成。Renderer 不再读取或写入 Workbench snapshot，也不存在仅供测试使用的 legacy 后门。

## E2E fixtures and assertions

- [x] `e2e/artifact-layout.spec.ts` 通过 Durable Project/Session commands 建立 fixture。
- [x] `e2e/features.chat-tools.spec.ts` 通过 `session:search` + `message:list` 验证 SQLite assistant message。
- [x] `e2e/features.concurrency.spec.ts` 通过 Durable Message query 验证 interjection。
- [x] `e2e/durable-session-terminal.spec.ts` 覆盖用户消息 retry/edit、Assistant 无 retry/edit 入口、fork 和 Session-owned terminal。
- [x] 全部 E2E 不调用 `getWorkbench`、`saveWorkbench` 或 `migrateWorkbenchV1`。

## Renderer stores

- [x] `agent-replica.ts` 保存 Project/Session replica、分页 Message/FileChange cache、runtime snapshot 和 cursor。
- [x] `agent-runtime.ts` 只保存每 Session stream/approval/tool overlay，以及未发送 composer draft。
- [x] command response 与 domain event 共用 reconciler；重复事件幂等，cursor/backend instance/revision 缺口触发对应重同步。
- [x] Timeline 从 canonical `MessageRecord` 投影，不写 Conversation 副本。
- [x] Workbench persistence/schema、legacy timeline event reducers 和旧 snapshot tests 已删除。

## Cutover verification

- [x] Preload 在 renderer hydrate 前有界缓存 domain events。
- [x] Reload 通过 `app:get-bootstrap`、`session:get` 和分页 query 恢复。
- [x] `AgentApi`、preload、IPC contracts 和 handlers 不暴露旧 Workbench API。
- [x] 旧 `workbench.json`、`change-history.json` 和 localStorage 数据不迁移、不读取、不删除、不改写。
