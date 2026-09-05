# 排障、备份与恢复

返回[文档入口](../README.md)。先确定问题发生在安装、数据库、Provider、工具还是 Renderer；源码从[总地图](../code-map/README.md)按现象定位。

## 开发环境

| 现象                           | 检查方式                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 原生 PTY 无法加载或 ABI 不匹配 | 使用 Node.js 24 与锁文件重新安装依赖；按错误定位 `test:native`，只有需要源码构建时使用 `rebuild:native:source` 并准备平台编译工具链 |
| 搜索二进制不可用               | `test:ripgrep` 检查分发二进制、进程和输出                                                                                           |
| SQLite 在开发或打包后失败      | 分别定位 `test:sqlite` / `test:sqlite:packaged`；后者需要已有打包产物                                                               |
| Provider 失败                  | 检查配置类型、地址、启用模型与 credential 状态，再按 diagnosticId 找运行日志                                                        |
| 刷新后消息或状态不一致         | 从 replica 的 cursor/revision、overflow 与 Backend instance 重同步路径检查                                                          |
| MCP 启动或调用失败             | 分开检查启动信任、环境变量、stdio server、catalog 与 Tool approval                                                                  |

这些底层命令用于隔离失败；已通过 `check` 或 `verify` 时不需要再全部执行。运行门禁见[开发指南](./development.md)。

## 日志与问题报告

设置中打开实际数据目录。Desktop 的运行日志位于 `logs/runtime/`，Full Trace 位于 `traces/`；Headless 的路径由 artifacts/result 给出。默认运行日志只保存白名单元数据，适合用错误码、diagnosticId、时间和操作步骤定位问题。

Full Trace 需显式启用；只记录开启后相应 capture 覆盖的运行，不能补录过去。Trace、Session transcript 和任务 artifact 可能含代码、输入、工具输出及敏感信息，分享前需自行检查。Conversation Markdown 与 Trace transcript 是不同的只读导出，不是导入/在线回放入口。记录边界见[可观测性规范](../architecture/observability.md)。

## 一致备份

Desktop 的持久化真相源为 `userData/agent.db`；Windows 安装版通常在 `%APPDATA%\Zch Coding Agent\`，以设置中打开的实际路径为准。WAL 模式下还可能存在 `agent.db-wal` 和 `agent.db-shm`。

1. 完全退出应用，并确认对应进程结束。
2. 复制整个 userData 目录，至少保留数据库及其同名伴随文件、`config.json`、`secrets.json` 和需要保留的 `traces/`。
3. 单独备份 workspace/Git 仓库；应用数据库不保存文件恢复副本。

不要逐个复制运行中不断变化的数据库文件来冒充一致快照。需要在线备份时应使用 SQLite 支持的备份机制或一致的文件系统快照；应用目前没有提供在线备份 UI。`secrets.json` 受操作系统 safeStorage 保护，不保证跨 Windows 账户或机器恢复。

## 数据库恢复

数据库打开或迁移失败时，启动恢复窗口只提供重试、打开数据目录和退出。先退出并备份故障目录，再使用同一次一致备份恢复数据库；不要单独混用不同时间的 DB/WAL 文件。

应用对未知高版本、迁移 checksum 不匹配和损坏数据库 fail closed，不自动回退旧 Workbench/JSON。不要编辑 migration ledger 或绕过 checksum。已知历史分叉的精确兼容见[存储决策](../decisions/storage.md)，实现见 [database-service.ts](../../electron/persistence/database-service.ts)。
