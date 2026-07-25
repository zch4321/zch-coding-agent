# 决策日志

本文件记录有意接受、暂缓或取舍的技术决策。Code review 记录发现本身；本日志记录项目对发现采取的处理方式，避免后续将已知限制误认为遗漏。

## 2026-07-25 — FC-1：FileChange revert 的 workspace TOCTOU

- 状态：当前范围内接受风险，不修复；P8 默认 composition 切流前必须重新评估。
- 决定：不在 P4/P5 阶段引入基于目录句柄的 no-follow 原子文件操作。
- 背景：`FileChange` 回滚会在完成路径与内容校验后，以字符串路径调用最终的 `rename` 或 `unlink`。外部本地进程若在极窄窗口内替换文件或中间目录，可能覆盖竞争方的新内容；若以符号链接或等效机制替换中间目录，理论上还可能越过 workspace 边界。详见 [FC-1 code review](backend-refactor-p0-p5-code-review.md#fc-1-revert-的最终-renameunlink-在最后一次校验之后使用词法路径toctou-可越过-workspace-边界p1-1)。
- 理由：P4/P5 durable target 目前只由 unit/integration tests 使用，尚未接入生产 Desktop、Headless、IPC 或 renderer 默认路径。完整修复需要跨平台的目录句柄绑定和 no-follow 原子操作，当前实现成本与实际风险不匹配。
- 当前语义：回滚仍会执行 workspace 路径、普通文件和内容 hash 校验；但在存在外部文件系统竞争时，workspace 边界仅是 best-effort，不是强安全隔离保证。
- 重新评估条件：将 durable target 接入 P8 默认路径；产品承诺 Agent 永不触及 workspace 外文件；支持不可信插件、项目代码或更高权限的运行环境；或具备可用的跨平台句柄式文件操作实现。
