# 产品能力与行为要求

本文定义当前产品的范围和可观察要求。实现约束见[架构总览](./architecture.md)，用户交互见[前端规范](./frontend-spec.md)，未完成方向统一进入[路线图](./road-map.md)。状态描述以当前仓库为基线，不等同于某个已发布安装包；版本事实见[发布记录](./releases/README.md)。

## 当前能力与范围

| 能力                                    | 当前状态           | 可用条件或限制                                                                                               |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Desktop Agent                           | 已实现             | Windows x64 为主要发布目标；本地工作区和用户配置的 Provider                                                  |
| Project、Session 与消息持久化           | 已实现             | SQLite 是已提交产品状态的唯一真相源                                                                          |
| 文件、搜索、命令、Terminal              | 已实现             | 工具参数、资源归属、权限与输出预算共同约束                                                                   |
| Git Review                              | 已实现             | 只读查看当前 Project 的 Git 状态；不提供应用级文件恢复                                                       |
| Goal、Plan、Todo、live interjection     | 已实现             | Plan review 与 Tool approval 独立；Todo 从已加载历史派生                                                     |
| Provider                                | 已实现             | DeepSeek、MiMo、Generic Chat Completions、Generic Responses、Generic Anthropic；具体字段和能力由对应实现解释 |
| Skills                                  | 已实现             | 本地管理、HTTPS/文件选择器安装、显式启用、按需读取                                                           |
| Generic MCP                             | 已实现             | 当前为 stdio 配置、启动信任、分页发现和统一 gateway；其他 transport 未实现                                   |
| Subagent                                | 已实现，默认关闭   | 异步执行；显式 `readonly` 或 `inherit`；隐藏 child Session 不可继续聊天                                      |
| Desktop Swarm                           | 已实现，有条件开放 | Subagent 已启用且模型池有 enabled route；模型调用须符合显式委派要求                                          |
| Headless                                | 已实现             | 固定 Yolo；支持异步 Subagent/background tools；不支持 Swarm                                                  |
| Operational Log、Full Trace、Transcript | 已实现             | Trace 默认关闭；只读导出有隐私告知；不从 Trace 在线重放 Provider 或创建 Session fork                         |
| ProjectModel、Serena、代码智能          | 已暂停             | 保留代码，但生产装配、UI、Tool 与可用 IPC 入口关闭；不读写 workspace `.zch`                                  |
| 插件加载器、Browser、IDE 级编辑能力     | 未实现             | 当前仅有内部事件总线与钩子；未来方向见路线图                                                                 |
| 云同步、团队协作、全量 embedding/RAG    | 不属于当前范围     | 不应在当前 UI 中提供无行为入口                                                                               |

## 对话与执行

- 首次发送前只存在 Renderer draft；首次发送成功才创建 Session 和初始消息，失败不得残留空对话。
- 同一 Session 同时只有一个活动 Run；切换对话不取消后台执行。普通重复发送受状态校验，live interjection 使用独立入口。
- 工具调用、拒绝、取消、timeout 和错误均产生可识别结果。完整历史可在重启后继续请求模型；不承诺恢复失败前的 partial stream。
- 默认不限制 ReAct 步数；工具与输出仍有边界。Provider usage 触发自动压缩，本地 token 估算用于诊断和有界输出，不替 Provider 决定请求是否可接受。
- Plan 默认等待审阅；批准不绕过权限模式和工具审批。Goal、Plan 和编排消息须可审计。
- retry/edit/rewind/fork 只影响对话。继续入口由 canonical history 判定，不插入伪造的空用户消息，不恢复文件和进程副作用。

详细行为见 [Session 规范](./architecture/sessions.md)与 [Provider/Context 规范](./architecture/providers-and-context.md)。

## 工具与文件行为

- 文件读取和检索支持有界输出、明确截断与可用的续读信息；工具错误应给出可修正的字段或条件。
- `write_file` 创建或整体覆盖文件；`apply_patch` 对最新内容作精确唯一匹配，无匹配或歧义时零写入；`delete_file` 对不存在文件幂等成功。
- 写入采用 last-writer-wins；审批绑定完整参数和作用域，执行时重新校验路径。应用不保存 before/after、Diff history、恢复 patch 或 Run checkpoint。
- Git Review 展示当前 Project 的 status 和所选比较基准，不归因于 Session、Run、Agent 或工具；非 Git 项目和 untracked/binary 文件显示明确限制。
- `run_command` 用于一次性进程，长任务和交互会话使用持久 PTY；两者使用用户配置的解释器边界。父 Run 中断不会关闭 PTY。
- Agent 和 Terminal 通过 `background_wait/list/cancel` 管理；完整输出按工具策略保存为 Session artifact。文件可过期或捕获失败，状态仍以 Backend 为准。

完整参数、权限与输出规则见[工具规范](./architecture/tools-and-permissions.md)，集成和临时文件规则见[集成规范](./architecture/integrations.md)。

## 权限、隐私与失败处理

| 模式     | 用户可预期的行为                                                     |
| -------- | -------------------------------------------------------------------- |
| ReadOnly | 拒绝不允许的副作用；读取内容仍可能发送给用户配置的模型服务           |
| Auto     | 确定性策略先判断，需要 review 时使用辅助模型，审批失败则回退人工审批 |
| Confirm  | 副作用通常需要人工审批；Session scratch 等明确例外按工具规范执行     |
| Yolo     | 跳过风险审批；仍检查 schema、路径范围和资源归属                      |

- API Key 不由 Renderer 读取或回显，不进入请求日志、Trace 和子进程环境。Full Trace 仍可能包含读取到的代码、用户输入、reasoning 和其他敏感内容，必须单独启用并提示。
- 文件路径控制不等同于容器 sandbox；命令和 Terminal 是主机进程执行能力。Yolo 首次启用必须明确告知。
- Auto 审批的 timeout、无效输出或异常不能自动放行；参数与执行前复核始终有效。
- 数据库打开或 migration 失败时显示阻塞恢复入口；不静默回退 JSON 或丢弃数据库。日志捕获失败则隔离降级，不使已授权工具或模型操作失败。

详细策略见[权限规范](./architecture/tools-and-permissions.md)，日志与导出边界见[可观测性规范](./architecture/observability.md)。

## 多 Agent 与宿主

- 每个 child 的 `toolAccess` 显式选择只读或继承父 Run 的冻结工具与权限；不能扩大父权限，不能递归委派或暴露 Goal/Plan 管理工具。
- 主 Run 结束、取消或 Provider 失败不级联已启动 Agent；worker timeout、显式取消、Session/Project 生命周期和 app dispose 负责清理。
- Swarm 在开始任何 child Provider 请求前冻结 assignment 并原子预留全部 active leaf 容量；失败保留各 child 的实际结果，不自动启动第二轮聚合。
- Agents 面板按 root/child 两级展示，只投影安全活动，不暴露 hidden Session、完整工具轨迹、reasoning 或 continuation。
- Headless 复用同一 Runtime，输出版本化 JSONL 和原子 result/identity。`completed` 只表示 Run 正常结束，业务结果须由调用者验收。

完整规则见 [Agent execution 规范](./architecture/agent-execution.md)。

## 验收原则

验收以可观察行为和不变量为单位，不再依赖旧 P2/P3/MVP 阶段名称。新增 policy、parser、IPC 和 Tool 行为必须有回归覆盖，尤其是拒绝、取消、越界、并发与失败分支。相关测试从 [Code map](./code-map/README.md) 定位，跨领域要求见[验证指南](./guides/testing.md)。
