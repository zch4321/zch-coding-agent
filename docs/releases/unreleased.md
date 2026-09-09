# Unreleased

- 模型命令工具改为 exec_command，保留 command 和 executable + args 两种启动方式，支持同一 Run 内增量读取、stdin、EOF 和单独停止。
- 单次等待默认 10 秒、上限 60 秒，不设置进程总运行超时；Run 正常结束、失败或停止时清理剩余 exec 进程。TTY 或跨 Run 任务继续使用 Terminal。
- 续写 command 自动补缺失的结尾换行，chars 原样发送；旧 run_command 对话历史保持可读，旧授权不会自动扩展到新工具。
- 原命令超时设置明确为 Git / MCP 操作超时；停止运行支持在清理失败后重试。

最近已发布版本见 [v0.3.1](./v0.3.1.md)。
