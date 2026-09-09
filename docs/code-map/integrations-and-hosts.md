# 集成、宿主与可观测性

返回[总地图](./README.md)。规范见[集成](../architecture/integrations.md)、[可观测性](../architecture/observability.md)和 [Headless/Agent execution](../architecture/agent-execution.md)。

## 职责与边界

宿主提供进程、凭据和事件适配，集成服务管理自身资源。MCP/Skills/Terminal 的模型能力经 Tool pipeline；日志、artifact 和 public state 有不同的隐私与持久化边界。

## 关键入口

| 文件 / 符号                                                                                                                                      | 责任                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| [terminal/pool.ts](../../electron/terminal/pool.ts)、[session-terminals.ts](../../electron/session/session-terminals.ts)                         | PTY 所有权、输入输出、resize 与关闭       |
| [process/command-shell.ts](../../electron/process/command-shell.ts)、[process/run.ts](../../electron/process/run.ts)                             | Shell 发现/解析与一次性进程执行           |
| [mcp-manager.ts](../../electron/mcp/mcp-manager.ts)、[mcp-stdio-connection.ts](../../electron/mcp/mcp-stdio-connection.ts)                       | Server 信任、连接生命周期、catalog 与调用 |
| [mcp-tools.ts](../../electron/tools/mcp-tools.ts)                                                                                                | 固定 gateway 和现有权限管线的连接         |
| [skills/manager.ts](../../electron/skills/manager.ts)、[skill-tools.ts](../../electron/tools/skill-tools.ts)                                     | Skill 安装、扫描、诊断和按需读取          |
| [project-artifacts/service.ts](../../electron/project-artifacts/service.ts)                                                                      | 项目原生短根、registry、迁移与 TTL        |
| [config/store.ts](../../electron/config/store.ts)、[secret-store.ts](../../electron/config/secret-store.ts)                                      | 公共配置与主进程秘密存储                  |
| [operational-logging/service.ts](../../electron/operational-logging/service.ts)、[sanitizer.ts](../../electron/operational-logging/sanitizer.ts) | 白名单运行元数据与诊断 ID                 |
| [session-trace-controller.ts](../../electron/session/session-trace-controller.ts)、[logging/service.ts](../../electron/logging/service.ts)       | 分段 Full Trace 与热切换                  |
| [logging/session-transcript.ts](../../electron/logging/session-transcript.ts)                                                                    | Trace 到只读 transcript 投影              |
| [headless/main.ts](../../electron/headless/main.ts)、[runner.ts](../../electron/headless/runner.ts)                                              | CLI、固定 Yolo 和 Backend 生命周期        |
| [headless/contracts.ts](../../electron/headless/contracts.ts)、[runtime-identity.ts](../../electron/runtime/runtime-identity.ts)                 | 配置/结果/JSONL 和 capability 身份        |

## 主要调用链

Background 日志预览沿 `background:terminal-tail` → application ownership 校验 → TerminalPool 登记路径与固定 canonical root → [artifact-tail.ts](../../electron/terminal/artifact-tail.ts) 根身份/文件边界校验及有界文件尾读取。终端生命周期失效事件不携带 raw output；底部终端保留原始 ANSI 订阅和输入能力。

```text
MCP config → startup trust → stdio connection → gateway → Tool pipeline
Terminal open → resolved user Shell → TerminalPool → events / artifact
Headless CLI → profile paths + memory config/env credential → profile ownership → createBackendRuntime
  → same Session/Run loop → JSONL + atomic result/identity → dispose
Operational metadata → sanitizer → log files
Opt-in Trace → capture files → offline reader / transcript
```

## 状态与契约

配置保存环境变量名称或 secret reference，不把密钥传给 Renderer 或工具子进程。MCP connection/PTY 是进程内资源；Session artifact 只是输出副本。Desktop/Headless 共用 profile 的 `agent.db` 与项目产物服务，`ProfileOwnership` 在配置/迁移/恢复前取得排他权。Headless 显式 artifacts 目录仅保存本任务导出，stdout 只输出本任务 JSONL。

## 暂停的代码智能

[project-metadata-store.ts](../../electron/project/project-metadata-store.ts) 和 [code-intelligence](../../electron/code-intelligence/) 是保留实现。当前 `createBackendRuntime` 不装配这些服务，[session-tooling.ts](../../electron/session/session-tooling.ts) 不注册对应工具，[catalog](../../electron/session/session-tool-catalog.ts) 额外过滤保留 ID，[app-handlers.ts](../../electron/ipc/app-handlers.ts) 返回不可用。恢复前须完成[路线图](../road-map.md)中的 ProjectModel SQLite 迁移；普通 [module-detector.ts](../../electron/project/module-detector.ts) 仅提供只读提示快照。

项目编号与注册表由 [ProjectArtifactRepository](../../electron/persistence/project-artifact-repository.ts) 持有；旧 Session 路径兼容保留在 `session-temp/`。跨进程生命周期入口为 [ProfileOwnership](../../electron/persistence/profile-ownership.ts)，profile 默认选择见 [paths.ts](../../electron/profile/paths.ts)。

## 修改指引

- 修改 Terminal/Shell：同时检查模型工具、人类输入、owner 校验、运行中 profile 冻结/新建语义和关闭后的输出。
- 修改 MCP：保持启动信任与每次工具审批分离，检查 catalog 分页、timeout、abort、进程清理与 envFromHost；不直接透传保留 intent 字段。
- 修改日志：先选择 Operational、Trace 或 artifact，避免扩大默认日志内容；Full Trace 失败不应使授权动作失败。
- 修改 Headless：同步 contracts、CLI/config 迁移、result/identity 和 parity fixture；不添加新的 Agent loop 或 Swarm 能力。

## 验证入口

| 测试                                                                                                                        | 验证内容                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [pool.test.ts](../../electron/terminal/pool.test.ts)、[command-shell.test.ts](../../electron/process/command-shell.test.ts) | PTY 与解释器行为                           |
| [mcp-manager.test.ts](../../electron/mcp/mcp-manager.test.ts)、[mcp-tools.test.ts](../../electron/tools/mcp-tools.test.ts)  | 信任、发现、gateway 与权限                 |
| [manager.test.ts](../../electron/skills/manager.test.ts)                                                                    | 安装、路径、诊断与启用                     |
| [project-artifacts/service.test.ts](../../electron/project-artifacts/service.test.ts)                                       | artifact 生命周期与安全路径                |
| [session-trace-controller.test.ts](../../electron/session/session-trace-controller.test.ts)                                 | capture 开关与降级                         |
| [headless.test.ts](../../electron/headless/headless.test.ts)                                                                | CLI/config、输出、Plan continuation 和取消 |
| [mcp.spec.ts](../../e2e/mcp.spec.ts)、[security-baseline.spec.ts](../../e2e/security-baseline.spec.ts)                      | 构建应用的集成与安全路径                   |

## Run 内命令会话

[exec-command-tool.ts](../../electron/tools/exec-command-tool.ts) 提供模型入口，[exec-command-schema.ts](../../electron/tools/exec-command-schema.ts) 统一调用分类；[command-sessions.ts](../../electron/process/command-sessions.ts) 持有 Run 的管道进程、stdin、增量输出及日志收尾。SessionRunController 在真实退出与日志关闭后发布 Run 终态，停止重试保留执行所有权。它不接入 Background/Terminal；旧 process/run.ts 仍供 Git 等有界内部操作使用。回归见 [command-sessions.test.ts](../../electron/process/command-sessions.test.ts)、[native pipe tests](../../electron/process/command-sessions.native.test.ts)、[Session exec tests](../../electron/session/session-manager.exec.test.ts) 和 [Playwright](../../e2e/features.exec-command.spec.ts)。
