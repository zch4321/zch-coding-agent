# 工具、审批与文件安全

返回[总地图](./README.md)。规范见[工具与权限](../architecture/tools-and-permissions.md)，文件取舍见[持久化决策](../decisions/storage.md)。

## 职责与边界

`electron/tooling` 拥有 Tool framework，`electron/tools` 放内置业务定义，`permission` 决定授权，`safety` 与具体工具复核路径。`electron/tools/tool-registry.ts` 等文件是兼容出口，新增 framework 实现应进入 tooling。

## 关键入口

| 文件 / 符号                                                                                                                                | 责任                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| [tooling/contracts.ts](../../electron/tooling/contracts.ts)                                                                                | `ToolDefinition`、effects、executionMode、结果与输出策略   |
| [tooling/registry.ts](../../electron/tooling/registry.ts)                                                                                  | 注册、输入 schema 校验、Provider schema 与 intent metadata |
| [session-tooling.ts](../../electron/session/session-tooling.ts) / `createSessionTooling`                                                   | 把内置工具与业务端口注册到生产 registry                    |
| [session-tool-catalog.ts](../../electron/session/session-tool-catalog.ts)                                                                  | 当前 Run 的工具可见性、暂停 ID 与冻结限制                  |
| [session-tool-runner.ts](../../electron/session/session-tool-runner.ts)                                                                    | 参数规范化、审批、分段调度、过滤与结果提交                 |
| [permission-pipeline.ts](../../electron/permission/permission-pipeline.ts)、[policy-engine.ts](../../electron/permission/policy-engine.ts) | 授权和确定性策略                                           |
| [session-approval.ts](../../electron/permission/session-approval.ts)、[auto-approver.ts](../../electron/permission/auto-approver.ts)       | 人工等待和辅助模型审批                                     |
| [tooling/executor.ts](../../electron/tooling/executor.ts)                                                                                  | 批准复核、timeout/abort、handler settlement                |
| [file-tools.ts](../../electron/tools/file-tools.ts)、[text-patch.ts](../../electron/tools/text-patch.ts)                                   | 文件 mutation 与精确补丁解析                               |
| [path-guard.ts](../../electron/safety/path-guard.ts)、[filesystem/index.ts](../../electron/common/filesystem/index.ts)                     | 路径授权与通用文件 I/O 的独立边界                          |
| [result-projection.ts](../../electron/tooling/result-projection.ts)、[output-budget.ts](../../electron/tooling/output-budget.ts)           | 内部结果转模型可见 parts 与最终字节保险                    |

## 主要调用链

```text
Provider Tool call → normalize → registry/schema + resource checks
  → PermissionPipeline → auto/human approval → ApprovedToolCall
  → ToolExecutor → business handler → path revalidation / host operation
  → sensitive context filtering → canonical result projection
  → 完整 Tool batch commit → 下一轮 Provider
```

parallel 段只并发 Tool body，准备/审批与结果仍按 call 顺序；serial Tool 是前后完成屏障。目录可见性和 executor 的权限复核都需要维护。

## 状态与契约

批准绑定 tool/call 与完整 args hash，不冻结旧文件内容。PathGuard 在执行期重做 scope 和真实路径检查。完整 `ToolResult` 用于内部安全/Trace，模型历史只收 canonical parts；分页工具自行维护 continuation。Session artifact 和 scratch 的权限不同，见[集成规范](../architecture/integrations.md)。

## 修改指引

- 新增工具：定义 schema/effects/风险/abort/outputPolicy 和 handler，在 `createSessionTooling` 注册，检查主 Run、readonly/inherit child 和 Headless 的可见性，再补拒绝、取消和超限回归。
- 修改文件能力：联查 [file-tool-policy.ts](../../electron/tools/file-tool-policy.ts)、[file-tool-target.ts](../../electron/tools/file-tool-target.ts)、[streaming-file-reader.ts](../../electron/tools/streaming-file-reader.ts)；不把审批变成文件 OCC，不新增恢复记录。
- 修改搜索：从 [workspace-glob.ts](../../electron/tools/workspace-glob.ts)、[ripgrep-searcher.ts](../../electron/tools/ripgrep-searcher.ts) 跟到枚举、路径和输出边界。
- Git Review 从 [git-review-service.ts](../../electron/application/git-review-service.ts) 到 [git-review.ts](../../shared/git-review.ts) 与 DiffTab；它与模型的 [git-tools.ts](../../electron/tools/git-tools.ts) 是不同入口。

## 验证入口

| 测试                                                                                                                          | 验证内容                           |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| [tooling.test.ts](../../electron/tooling/tooling.test.ts)                                                                     | 注册、执行与结果投影               |
| [session-manager.tool-batch.test.ts](../../electron/session/session-manager.tool-batch.test.ts)                               | 并行段、serial 屏障和顺序          |
| [session-manager.approval.test.ts](../../electron/session/session-manager.approval.test.ts)                                   | 审批和降级                         |
| [path-guard.test.ts](../../electron/safety/path-guard.test.ts)、[file-tools.test.ts](../../electron/tools/file-tools.test.ts) | 越界、链接、最新内容和文件语义     |
| [text-patch.test.ts](../../electron/tools/text-patch.test.ts)                                                                 | 精确匹配、歧义与零写入             |
| [git-review-service.test.ts](../../electron/application/git-review-service.test.ts)                                           | Git scope、基准、binary 和有界查询 |
