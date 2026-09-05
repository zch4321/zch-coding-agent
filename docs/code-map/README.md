# Code map

从修改任务找到入口、关键调用链和验证方式。地图描述当前实现；规则以[架构规范](../architecture.md)和[前端规范](../frontend-spec.md)为准。返回[文档入口](../README.md)。

## 按修改任务查入口

| 我要做什么                               | 先读哪张地图                                                        | 首个代码入口                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 调整应用启动、关闭或资源清理             | [Runtime](./runtime.md)                                             | [create-backend-runtime.ts](../../electron/application/create-backend-runtime.ts)                                                    |
| 修改发送、重试、继续或取消               | [Runtime](./runtime.md)、[状态与 IPC](./state-and-ipc.md)           | [durable-run-application-service.ts](../../electron/application/durable-run-application-service.ts)                                  |
| 新增领域字段或 IPC                       | [状态与 IPC](./state-and-ipc.md)                                    | [domain-state-api.ts](../../shared/domain-state-api.ts)、[IPC registry](../../shared/ipc/registry.ts)                                |
| 排查刷新后重复、丢失或不同步             | [状态与 IPC](./state-and-ipc.md)                                    | [agent-replica.ts](../../src/stores/agent-replica.ts)                                                                                |
| 新增工具、修改文件行为或审批             | [工具与权限](./tools-and-permissions.md)                            | [session-tooling.ts](../../electron/session/session-tooling.ts)                                                                      |
| 新增 Provider、修改 reasoning/usage      | [Provider 与 Context](./providers-and-context.md)                   | [provider.ts](../../electron/providers/provider.ts)、[provider-factory.ts](../../electron/providers/provider-factory.ts)             |
| 修改 Prompt、历史编译或压缩              | [Provider 与 Context](./providers-and-context.md)                   | [prompt-harness.ts](../../electron/session/prompt-harness.ts)、[canonical-history.ts](../../electron/session/canonical-history.ts)   |
| 调整 Subagent/Swarm 取消、容量或模型分配 | [Agent execution](./agent-execution.md)                             | [background/service.ts](../../electron/background/service.ts)、[swarm/coordinator.ts](../../electron/swarm/coordinator.ts)           |
| 新增设置项或修改页面                     | [Renderer](./renderer.md)、[状态与 IPC](./state-and-ipc.md)         | [settings-tabs.ts](../../src/components/settings/settings-tabs.ts)、[shared/config](../../shared/config/)                            |
| 修改 Git Review                          | [工具与权限](./tools-and-permissions.md)、[Renderer](./renderer.md) | [git-review-service.ts](../../electron/application/git-review-service.ts)、[DiffTab.vue](../../src/components/artifacts/DiffTab.vue) |
| 排查 Terminal、MCP、Skills 或日志        | [集成与宿主](./integrations-and-hosts.md)                           | 对应地图的入口表                                                                                                                     |
| 扩展 Headless 或核对 Desktop parity      | [集成与宿主](./integrations-and-hosts.md)                           | [headless/runner.ts](../../electron/headless/runner.ts)                                                                              |

## 顶层位置

| 目录                                          | 内容                                            | 阅读入口                                   |
| --------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| [electron](../../electron/)                   | Main host、后端服务和 Node Runtime              | [Runtime 地图](./runtime.md)               |
| [src](../../src/)                             | Sandboxed Vue Renderer、Pinia、主题与本地化     | [Renderer 地图](./renderer.md)             |
| [shared](../../shared/)                       | Canonical schema、IPC/config 领域契约和中立原语 | [状态地图](./state-and-ipc.md)             |
| [resources/prompts](../../resources/prompts/) | 版本化模型指令和模板，属于产品资源              | [Context 地图](./providers-and-context.md) |
| [e2e](../../e2e/)                             | Playwright Electron 用户路径和安全回归          | [验证指南](../guides/testing.md)           |
| [scripts](../../scripts/)                     | 检查、原生 smoke 和真实 Provider runner         | [开发指南](../guides/development.md)       |
| [.github/workflows](../../.github/workflows/) | CI、打包与发布                                  | [发布流程](../releases/README.md)          |
| [docs](../README.md)                          | 当前规范、导航、决策和档案                      | [文档分工](../README.md#文档分工)          |

## 阅读和更新方式

地图中的入口是阅读起点，不是完整 import graph。沿核心符号搜索调用方即可深入；测试表说明应该验证什么，不要求在 `npm run check` 后再次执行相同测试。

新增入口、模块移动、跨层调用或状态所有权变化时同步相关地图。每篇使用“职责与边界 → 关键入口 → 主要调用链 → 状态与契约 → 修改指引 → 验证入口”的结构。详细模板和链接检查见[文档维护指南](../guides/documentation.md)。

ProjectModel、Serena 与代码智能保留目录但生产入口暂停，不能根据文件存在推断能力可用；定位见[宿主地图](./integrations-and-hosts.md#暂停的代码智能)。
