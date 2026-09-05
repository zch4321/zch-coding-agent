# 决策索引

决策解释为什么采用某个方案，以及接受了哪些代价。当前规范见[架构总览](./architecture.md)和[前端规范](./frontend-spec.md)；未来事项见[路线图](./road-map.md)。

## 按主题阅读

- [持久化与文件系统决策](./decisions/storage.md)：10 条。
- [Subagent、Swarm 与后台任务决策](./decisions/agent-execution.md)：7 条。
- [配置与跨进程契约决策](./decisions/configuration.md)：6 条。
- [模型与 Provider 决策](./decisions/providers.md)：7 条。
- [Renderer 交互决策](./decisions/renderer.md)：6 条。
- [验证与发布决策](./decisions/verification.md)：4 条。
- [Runtime 与生命周期决策](./decisions/runtime.md)：7 条。

## 替代关系

- 2026-09-02 删除应用自有 Diff 与恢复，取代 FileChange、审批 Diff、checkpoint、patch retention 与回退相关旧决策；2026-09-03 对已落盘的 SQLite v11 分叉作精确兼容。
- 2026-09-01 文件工具采用 latest-content/last-writer-wins，取代文件内容 precondition 与 OCC 要求；参数和路径授权继续有效。
- 2026-08-26 移除产品级全局并发准入及 Swarm 强制人工审批；2026-08-28 Agent 变为异步后台任务，父 Run 结束或取消不再级联已启动任务。Session active leaf 容量仍受限。
- 模型角色和 reasoning 以 2026-08-16/17 决策为准，旧独立 Auto approval route 仅保留演进背景。

## 添加或更新决策

记录日期、状态（已采纳／暂缓／已取代）、问题、决定、理由、代价及替代链接。短决策追加到相关主题；具有独立讨论过程的长决策单独成文并加入本索引。已取代条目保留历史背景，并指向替代决定，不再作为当前验收依据。
