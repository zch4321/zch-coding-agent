# 路线图

本文只记录尚未完成、需要排期或设计的事项。当前能力见[产品范围](./requirements.md#当前能力与范围)，已采纳约束见[架构总览](./architecture.md)，未定语义见[开放问题](./open-design-questions.md)。完成事项移入当前规范，版本事实保留在发布记录。

## 未完成概览

| 优先级 | 领域                           | 目标                                                  | 主要风险                         |
| ------ | ------------------------------ | ----------------------------------------------------- | -------------------------------- |
| P2     | Swarm Hardening                | 取消体验、压力测试、诊断与成本汇总                    | 费用失控、取消竞态与上下文膨胀   |
| P2     | Provider Routing               | 更多用途绑定、显式 fallback 与诊断展示                | 隐式切换服务商或混淆 usage 归属  |
| P3     | Project / Code Intelligence UX | SQLite ProjectModel 迁移后恢复 routing、Serena 与诊断 | 项目元数据误改、后端不可诊断     |
| P3     | Terminal / Command Environment | WSL、自定义 profile、版本诊断与打包 E2E               | 参数边界、路径映射和恢复语义     |
| P3     | Later Expansion                | 插件加载器、浏览器、多模态、高级统计                  | 基础并发与扩展边界未稳时过早扩张 |

## M2 · Swarm Hardening

目标：在不改变已经落地的显式 child 工具权限、模型池分配、原工具审批管线和无产品级并发准入契约的前提下，补齐 Desktop Swarm 的运行反馈、取消、统计、诊断与高并发回归覆盖。

### 运行反馈与取消体验

- 评估在主时间线 Swarm ToolCallCard 中展示 queued/running/completed/failed 汇总、模型 assignment、部分失败和结果截断；与 Agents artifact 的 Job → child 两级视图保持同一状态定义。
- 提供明确的 Job 取消入口和取消中状态。父 Run 结束/取消后后台任务继续、显式 Job 取消、queued child 与 active child 的状态必须可区分，并保持 call/result 与 durable execution 收敛。
- 评估更完整的 child 诊断视图，但 child Session 仍不可继续聊天，也不进入普通 Session 列表、搜索、导出或主对话事件。

### 统计、诊断与成本

- 建立 parent Session/Run/call → Swarm Job → child execution → Provider call 的可审计关联，并汇总 route assignment、usage、费用相关指标、耗时和错误分类。
- 让运行中的 Tool call 数、child 状态和 usage 聚合与终态 durable 统计确定性收敛；Renderer live overlay、详情查询、Trace 和最终结果采用明确且一致的统计口径。
- 完善部分失败、取消、Provider failure、输出截断和 Trace degradation 的诊断信息，同时保持凭据、reasoning、workspace 绝对路径和 hidden Session ID 不进入公共结果。
- 主时间线、Agents artifact 和日志/Trace 对同一 Job 的名称、数量和终态不应互相矛盾。

### 压力测试与持续不变量

- 覆盖慢 Provider、同父 Run 多 Job、多个 sibling child、同 workspace 多可写 Session、父 Run 取消、应用退出/崩溃、Renderer reload、事件缺口、长结果和协议最大 Agent 数的压力测试。
- 持续验证 `readonly` child 不可见副作用工具，`inherit` child 不高于父 Run 且副作用继续经过原权限管线；Goal/Plan/递归 Agent Tool 对所有 child 不可见，伪造调用也由 executor 拒绝。
- 持续验证 parallel/serial Tool 调度的串行屏障、单审批和原 call 顺序结果；未知 Tool 默认 serial。
- 持续验证 route、canonical workspace、assignment、usage 和终态可审计，而凭据、reasoning 与 workspace 绝对路径不落盘、不回传。
- 持续验证 hidden Session 不进入 bootstrap、分页、搜索、导出、普通事件或侧栏；父/Project 删除级联清理，父归档保留。
- 重启只把遗留 active execution 标记为 `interrupted`，不恢复 stream、不自动重试 Provider；Desktop 与 Headless 继续复用唯一 runtime，并用 fake-provider trajectory 验证身份和能力边界。

验收：

- 用户能在主时间线或 Agents artifact 准确判断 Job 是否排队、运行、部分完成、失败、取消或被截断，并能取消仍在进行的 Job。
- 运行中统计最终与 SQLite durable 查询一致；Renderer reload、事件丢失重同步和长结果不会暴露 hidden Session 或破坏排序。
- 压力场景不遗留 active child、Run slot、AbortController、pending approval 或无法清理的 execution；费用与 usage 可以追溯到父 call 和具体 child；父 Run 结束或取消不级联已启动后台任务。
- `npm run check` 覆盖确定性单元/集成回归；涉及窗口生命周期和取消 UI 的路径进入构建后 Playwright，真实付费 Provider 继续显式 opt-in。

## M3 · Project And Code Intelligence UX

依赖：只在 Desktop Swarm hardening 完成后启动。本阶段先把已暂停的 ProjectModel 从 workspace `.zch` 迁入 SQLite，再恢复 Code Intelligence Facade 和 Serena；迁移完成前 UI、Tool、IPC 可用路径和 backend process 都保持关闭。

### ProjectModel SQLite 迁移与编辑器

- 以稳定 `projectId` 在 `userData/agent.db` 中持久化 versioned ProjectModel，由 Backend transaction 和 revision 控制更新。
- 旧 `.zch/project-model.json` 只允许用户显式、一次性、有界导入；成功后不删除、不改写、不续写源文件，也不自动修改 `.gitignore`。
- Project tab 支持完整手动编辑：module root、languages、sourceRoots、testRoots、excludedRoots、default module、来源说明。
- module metadata 更新通过 SQLite revision/transaction 管理，并写入 trace 摘要以便审计；不创建文件级 change history。
- 评估接入受维护 project detector，避免核心长期膨胀语言规则。
- ProjectModel query/command 通过 shared schema 和 backend transaction 暴露；Project 删除级联、目录重关联、revision 冲突、备份/恢复和 Renderer reload 都以 SQLite record 为权威。
- Serena 和其他 code backend 只能引用 SQLite ProjectModel；backend pid、状态和 stderr tail 保持 Main process live state，不写入 ProjectModel。
- 只有 SQLite service、legacy import、IPC、UI、catalog 与 executor 双重校验全部完成后，才重新注册 `project_*`/`code_*` Tool 并启动 Serena，不能恢复半套路径。

验收：

- UI 可创建、编辑、删除 module，并保持 schema 校验。
- agent 工具和 UI 编辑不会互相覆盖未保存更改。
- 多 module 路径归属错误返回明确提示。
- 新项目与正常 Session 永不创建 `.zch`；损坏或冲突的 legacy 导入不产生部分 SQLite 写入且原文件不变。
- Project 删除级联、目录重关联、revision 冲突、备份/恢复和 Renderer reload 有持久化回归测试；恢复前所有 Provider catalog 都不含 `project_*`/`code_*`。

### Backend Routing UI

- Project tab 增加按 module/language 的 backend 选择和 capability 展示。
- 不再只有全局 Serena 开关。
- 后端状态展示 ready/stopped/error、pid、capabilities、last error、stderr tail。
- 后端 startup/restart/stop 写入持久 trace event。

验收：

- 同一 workspace 中前端 TS 和后端 Java 可配置不同 backend。
- 后端不可用时 facade 返回明确降级原因。
- trace 能定位 PATH、spawn、startup timeout、tool list 缺失等问题。

### Code Intelligence Facade 增强

- 设计目录级 overview/diagnostics 的有界能力。
- diagnostics 支持缓存、过期标记和 UI 展示。
- Trace 记录 facade 命中率、读文件 token、首次定位正确文件耗时和 fallback/unsupported 原因。
- 后续 IDE 级编辑能力单独设计：rename、replace body、update definition、refactor preview、diagnostics refresh。
- 所有写入类 IDE 能力必须进入现有 PathGuard、args-bound 审批和 trace 管线；结果由 Project 级 Git Review 查看，不另建 Diff/change-history/恢复体系。

验收：

- 大目录不会一次性塞入后端或上下文。
- diagnostics UI 能显示来源、时间和 stale 状态。
- IDE 写入能力不能绕过文件工具保护。

### Serena Managed

- 实现 Serena 托管安装 resolver：优先 managed Serena，其次 custom command。
- 提供安装、修复、版本、license notice、sha256 校验。
- 明确不把 Serena `initial_instructions` / onboarding prompt 混入本应用 Prompt Harness。
- Serena memory 写入后续如支持，必须单独审批并在 UI 可见。

验收：

- 新机器不依赖用户手动配置 PATH 即可安装或修复 Serena。
- managed/custom 两种模式状态清晰。
- Serena prompt/onboarding 不进入系统 prompt 或 base instructions。

## M4 · Provider Routing 与可观测性

Session selection、冻结 Run route、主/辅助模型与按 Provider 编译已实现，当前规则见[Provider 规范](./architecture/providers-and-context.md)。剩余方向：

- 评估 planner、summarizer、code review 等更多用途的显式绑定，先明确它们与现有 main/approval/title/compression 的关系。
- 设计可配置 Provider fallback；触发条件、实际 route、费用与失败原因必须可审计，不能静默切换服务商。
- 增强 usage 趋势、prompt cache 指标、工具耗时和 compact 前后变化的查询展示；统计口径先解决开放问题。
- 完善并发 Run、MCP、Provider retry 与审批失败的关联诊断；保留离线检查，不增加 Trace 在线执行入口。

验收：能够判断实际执行用途与 route、fallback 原因以及费用归属；审批失败继续回退人工判断，离线检查不执行工具。自动分享 artifact 的敏感检查另行设计，本地 restricted transcript 继续遵守逐次告知边界。

## M5 · 命令与 Terminal 扩展

统一 Shell 发现、保存、失效回退，以及新 Terminal 与 run_command.shell 使用同一配置均已实现，当前规则见[集成规范](./architecture/integrations.md)。剩余事项：

- WSL adapter：明确发行版选择、workspace 路径映射和参数边界。
- 展示解释器版本，设计经过校验的自定义 executable/profile/启动参数。
- 在打包 Windows 应用中覆盖发现、保存、重启恢复和实际执行的完整 E2E。
- 补充不同 profile 下 quoting、空格路径、Unicode、取消、timeout 与进程树清理的集成覆盖。

验收：扩展不改变 direct process、内部 Git 和已运行 Terminal 的既有语义；失效选择仍有可诊断回退，WSL 不被当作普通 Windows Shell。

## Later

- 补齐 Desktop/Headless 跨宿主 trajectory 对比回归：按相同 fixture 比较 Provider messages、稳定 Prompt、Tool、compact、Plan 与 MCP，并显式列出允许的宿主差异。已有覆盖与缺口见[验证指南](./guides/testing.md#已知验证缺口)。

- Subagent / Swarm 后续演进：`subagent_continue` 与多轮追问；child 间通信、递归委派、投票或辩论；超出 `readonly | inherit` 的自定义 child 工具列表。
- Child sandbox profile：在明确隔离后评估比父 Run 权限继承更细的进程、网络、终端和 MCP 沙箱策略。
- Swarm 共享结果索引、跨 Job 调查缓存和自动能力评估。
- 多机器 Worker、claim lease、heartbeat、远程 artifact/trace 上传和断线恢复。
- Durable Session Markdown import：定义从 `zch-conversation-markdown` 新建 Session 时的 attachment/reference 恢复、冲突策略与可信边界；当前导出文件只用于阅读和模型 route 迁移，不能导入或重放。Trace transcript export 继续保持独立。
- 外部 JS 插件加载器：签名、来源、隔离、权限声明、工具注册。
- 内置隔离浏览器工具。
- 浏览器 Comments/Annotations。
- 生产可选 Chrome/Edge 扩展。
- 多模态 content parts：图片、截图、剪贴板、拖拽文件。
- token 热力图、模型用量折线图、缓存命中率趋势。
- 高级 trace/usage 查询。
- Provider stream 未结束前提前执行工具。
- 直接控制用户 Chrome 默认 profile。
- 浏览器 Cookie、密码、Local Storage 读取工具。
- 云端同步和团队共享项目。
- 完整插件市场。

## 阶段门禁

每个实现阶段完成时运行日常门禁 `npm run check`；准备合并或发布时运行完整门禁 `npm run verify`。定位失败时可以运行对应底层命令，但不要在所选门禁通过后重复执行其已包含的检查。

涉及 Electron UI、文件树、审批、终端、设置、浏览器、MCP 进程生命周期、并发 run 或 provider routing 的阶段，还必须补充对应 E2E 或集成测试。

真实 Provider、外部 Serena/LSP 和外部 MCP server 继续保持显式 opt-in，不能进入 `npm run verify`。
