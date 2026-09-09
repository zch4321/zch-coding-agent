# Run 内 exec_command 会话化改造

状态：已完成。

用 exec_command 替换模型 run_command，执行进程只归实际 Session/Run。保留 Shell command 与 executable + args 两种启动；通过不透明 sessionId 续读/续写，command 补缺失换行、chars 原样发送，closeStdin 发送 EOF，terminate 单独停止。默认等待 10 秒，允许 0–60 秒，无进程总运行期限。Run 的正常、失败和取消出口统一停止并等待退出/日志收尾；每 Run 16 个活动进程、256 条已结束缓存。

启动/读取可并行，输入有序并独立审批，旧启动授权不扩到 stdin；纯读取和停止自有进程免审批。exec 不进入 Background，TTY 或跨 Run 任务继续使用 Terminal。Git/MCP 的有界执行和超时保留，无数据库或配置迁移。

实现入口与回归导航见[工具地图](../code-map/tools-and-permissions.md#run-内命令会话)，当前规则见[工具规范](../architecture/tools-and-permissions.md#命令类)。

## 验证

覆盖输入/EOF、等待与增量输出、字符边界、容量与所有权、停止失败/延迟退出/最终日志、Run 终态门禁、审批隔离、真实 Windows 管道及进程树，以及 Electron Playwright。完成任务文件格式化与 npm run check 后运行相关 Playwright；合并前执行 npm run verify，不运行付费 Provider 测试。

真实管道和进程树 smoke 位于 command-sessions.native.test.ts，随 npm run check 执行。相关 Electron 验证包括 exec-command、chat-tools 和 background 三组，共 9 个场景。完整 npm run verify 留在合并或发布前执行。
