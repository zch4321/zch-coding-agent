# 后台 Agent 与 Headless 宿主

本文规定 Subagent、Swarm、模型池和 Headless 的能力边界。代码入口见 [Agent execution 地图](../code-map/agent-execution.md)；CLI 使用见 [Headless 指南](../guides/headless.md)。

返回[架构总览](../architecture.md) · [文档入口](../README.md)。

## Headless 与 Runtime Parity

本节的完整 trajectory 对比是已采纳的验证要求；当前自动化覆盖差异见[验证指南](../guides/testing.md#已知验证缺口)，不能把共享 Runtime 或独立宿主测试等同于完整 parity 已通过。

Headless 继续复用唯一 Agent runtime：

- 每次执行使用独立临时 SQLite database。
- Headless config v5 迁移 v1–v4，支持 `subagents.enabled/workerTimeoutMs/maxSubagents` 与统一输出限制；异步 `subagent_run` 和 `background_wait/list/cancel` 与 Desktop 共用实现，`swarm_run` 仍按宿主能力排除。
- Session temp 位于显式 Headless artifacts 目录下；主流程结束时取消并收敛未等待的后台任务，已有文件由调用者管理。
- 需要补齐 Desktop 和 Headless fake-provider trajectory 对比，比较 active messages、provider requests、tool results 和 prompt hashes。
- Headless 产物从 canonical messages、trace 和独立 Operational Log 生成，不依赖 renderer store；stdout JSONL 永不混入文件日志。
- Headless 不生成 `workspace.patch`，result schema 不包含 patch path/status；调用者直接检查或管理其 Git 工作树。
- Run 的聚合活动与失败证据来自 Trace；不建立 `runs` table，也不承诺记录完整 token/SSE 增量。
- Runtime Identity v6 固定 source commit/tree、task/config digest、Provider/model、字节/行数 Tool 输出预算、worker timeout、`maxSubagents`、prompt/tool hash 和宿主 capability；不再记录 token 单结果预算。

## Subagent Runtime 与显式工具权限

### 调用与路由冻结边界

`subagent_run` 是由主 Agent 调用的普通 Tool，接收 `{ name, task, toolAccess }`。`name` trim 后允许 1–64 个 Unicode 字符，但拒绝控制/格式字符和 `__proto__/prototype/constructor`；`task` trim 后允许 1–32,768 个字符；`toolAccess` 必须为 `readonly | inherit`。Tool description 要求任务自包含，调查任务使用 `readonly`，只有任务确需父 Run 的非只读能力时才使用 `inherit`。

```text
parent ToolCall
  → ordered Tool preparation/approval
  → durable execution + atomic Session leaf capacity reservation
  → initialize artifacts/subagents/<execution-id>/
  → return BackgroundTaskHandle { target, status, artifactPath }
  ⇢ detached hidden Session with frozen delegated Tool context
  ⇢ existing Session/Run/Provider loop on parent workspace + shared Session temp
  ⇢ append activity.jsonl and atomically write result.md
```

主 Run 开始时冻结 `subagents.enabled`；设置热变更从下一个 Run 生效。child 精确复用父 Run 已冻结的 main/compression `ResolvedModelRoute`，包含模型 profile、Provider revision 和仅存在于内存的 credential binding；运行中配置变化不能换模型、reasoning 或 API key。child 不复制父 canonical history，只加载普通基础 harness、用户偏好、当前 workspace 的 AGENTS 和 skill 摘要，随后把 `task` 作为普通 `user_input` 追加。

`SubagentExecutionPort` 是 Tool Registry 与 application/runtime 之间的 backend-private 注入边界；延迟 bridge 解除 runtime 构造环。Desktop 与 Headless 都从 `createBackendRuntime` 注入同一个实现，不创建第二套 Provider loop。Provider retry 使用相同 Session/Run/call 与参数 hash 时复用同一 handle；参数冲突在任何新费用前失败。

### Tool batch 与 child profile

`ToolDefinition.executionMode` 支持 `parallel | serial`，未声明时 fail-closed 为 `serial`。SessionToolRunner 按 Provider call 顺序切分最大连续 parallel 段，每个 serial Tool 独占一段并成为前后完成屏障。每段先按顺序完成 normalize、MCP resolution、权限/审批、上下文 preflight 和 mutation preparation；parallel 段只并发 Tool body；工具结果收尾、输出过滤、事件、插件 after hook 和 canonical Tool Result 再按原 call 顺序完成。单项拒绝、失败或 timeout 不取消兄弟调用，父 Run 取消则中断所有 active body 并为每个 call 补齐终态结果。

内置 parallel Tool 包含文件/代码/Git/Project/Skill 读取、`fetch`、`web_search`、`delay`、MCP discovery、`run_command`、`subagent_run`、`swarm_run`、`background_wait/list`；文件/Git/Project 写入、实际 MCP、`terminal_open/send`、`background_cancel` 以及未知 Tool 为 serial。异步 Agent start 的 Tool body 只覆盖 durable preparation，后台 worker 不占用 Tool batch；`run_command` 仍是明确例外，同一 parallel 段中的其他读取不得假设其文件副作用已经完成。

Workspace 文件发现由一个 backend-only `fast-glob` 枚举器统一：`glob` 直接流式消费匹配文件，JavaScript `grep` fallback 用它筛选 include。枚举器先用 `PathGuard` 固定 directory-relative `cwd`，拒绝绝对、负模式与父目录 traversal，关闭 symlink 跟随，并对每个输出重新验证 real path containment；固定跳过 `node_modules/.git/dist`。调用者读取第 `maxResults + 1` 个匹配判断截断，因此结果上限不再错误地变成扫描上限。`grep` 的正常 backend 是 `@vscode/ripgrep` 分发的原生 ripgrep；项目内 `RipgrepSearcher` 只定位二进制、固定 workspace cwd、构造安全参数、管理取消/子进程并解析有界 `--json` 输出。只有进程级 availability probe 失败时才启用项目内 worker-thread regex fallback；二者的结果条数都用额外一个 match 区分“恰好达到上限”和“确实还有更多”。敏感路径 ingress 不参与文件枚举，独立用 `picomatch` 编译配置 glob；路径分隔符规范化由无匹配语义的公共 helper 提供，旧的手写 glob-to-regexp 实现不再保留。

child Provider catalog 由父 Run 已冻结的可见 catalog 派生。`readonly` 以及只读父 Run 的 `inherit` 只保留无副作用工具；其他 `inherit` 保留父 Run 允许的读取、命令、网络、MCP、文件/Git 写入等工具，并沿用父 Session 的 `auto | confirm | yolo` 权限模式。Goal、Plan、`subagent_run`、`swarm_run` 和全部 `background_*` 始终排除，防止 child 扩张或管理编排树。实际 executor 继续独立执行注册、schema、权限和路径校验，所以伪造 tool call 不能绕过 catalog。Git 命令使用 `--no-optional-locks`。

### Live Workspace/Git view

child Session 直接绑定父 Run 已规范化的 workspace path，并通过 `ownerSessionId` 共享父公开 Session 的 temp root。其 `permissionMode` 为 `readonly` 或父 Session 的冻结模式；只有计算结果为只读时才设置 `readOnlyWorkspace = true`。递归 Agent、background 与 Goal/Plan 等被排除的调用仍返回 `TOOL_NOT_AVAILABLE`。

文件与 Git Tool 在真正读取时观察 live workspace；不会复制目录、创建临时 Git repository、bundle、checkpoint 或 refs。serial 写 Tool 与所在前后的 parallel 段不会重叠，但显式 parallel 的 `run_command` 可能修改 workspace，因此与同段 child/read Tool 之间不提供冻结一致性。

升级后 Backend 只清理 runtime data 下旧版遗留的 `subagent-snapshots` 目录，不删除 workspace 中任何 Git refs。非 Git workspace 仍展示四个 Git read Tool，由现有 Git Tool 返回普通 repository 错误。

### Child Run、结果与生命周期

child Session 固定 `visibility = 'internal'`，使用委派计算后的权限模式并沿用全局 `limits.maxStepsPerRun`；`0` 仍表示不限步数。Provider 输出沿用冻结模型 profile 的 `maxOutputTokens`，`background_wait` 内联 Agent 回答经过冻结的 256 KiB 通用字节保险，不增加 Subagent 专属 step/token/result budget；完整回答另存 `result.md`。

AppConfig/PublicConfig v13 首次引入 Subagent 配置；当前 AppConfig/PublicConfig v25 中该部分的完整结构为：

```ts
subagents: {
  enabled: boolean // default false
  workerTimeoutMs: number // default 1_800_000, range 1 minute..24 hours
  maxSubagents: number // default 32, range 1..32
}
```

AppConfig v25 从 v24 增加 `maxSubagents = 32`；直接从 v19–v23 升级时把旧 `maxAgentsPerSwarm` 保留为 Session 总 leaf 上限。它同时删除 `maxToolResultTokens/readFileOutputBytes`，增加 `maxToolOutputLines = 500`，并只把恰为旧默认的 128 KiB byte limit 升到 256 KiB。Headless config v5 迁移 v1–v4 并增加同样容量/输出字段。Runtime Identity v6 记录字节、行数、worker timeout 与 `maxSubagents`，保留 `swarmsEnabled` 宿主能力位。

内部成功结果仍为 `{ results: { [name]: finalAssistantText }, meta }`；`meta` 只包含耗时、实际 `providerId/model`、标准化 usage 汇总和模型是否因输出上限截断。reasoning、endpoint、凭据、child Session ID 与 trace 路径不能回传。start Tool 只投影 target/status/artifact；终态 `background_wait` 从 durable result 取最终文本并附 `resultPath/activityPath`，Provider/model/usage 留在 execution 统计。只有 reasoning 或缺少最终 assistant text 时明确失败；长度上限结束则保留已有文本并标记 `truncated`。

child stream/tool/domain event 通过去除隐藏 Session identity 的 `AgentExecutionEvent` 投影到 Renderer；其中包括运行状态、流式活动、工具活动、usage 和人工审批。审批决策使用 `parentSessionId + executionId + callId` 定位 active child，再进入同一 ApprovalCoordinator。child 不创建独立 trace capture；标准化 usage 只进入 execution/Agent 统计，不回写可能已结束的父 Run。父 Run completion/cancel/Provider failure 不再级联；worker timeout、显式 background cancel、Session/Project archive/delete 与 app dispose 才通过 execution-owned AbortController 中断并等待 hidden Session 完整收敛。

### Desktop Swarm Job 与模型池调度

`swarm_run` 是满足运行条件的 Desktop 主 Run 的普通 Tool：Subagent 必须已启用，并且模型池至少有一条 enabled route。普通用户消息也能获得该工具；`/swarm <goal>` 仅作为显式请求与目标编排快捷命令，不再授予特殊 capability。child Run、历史重放和 Headless 仍不获得该工具，catalog 与 executor 对伪造调用执行相同检查。Provider 可见 schema 要求有界非空 `sharedContext`，每项 task 包含 `name/task/requiredCapability/agentCount/toolAccess`；`tasks.maxItems`、`agentCount.maximum` 使用本 Run 冻结的 `maxSubagents`，总量与跨 Job 剩余容量由 Backend 再校验。

`/swarm` 的原始斜杠命令作为 visible `user_input` 留在普通对话中；解析器额外生成的 `slash:/swarm` canonical `orchestrator` Prompt 以 `visibility = hidden`、`inHistory = true` 追加。MessageHistoryCompiler 继续把该 Prompt 交给 Provider，Renderer 时间线不投影它。兼容旧数据时不修改 append-only canonical history，而由 Renderer 同样抑制已写为 visible 的 `slash:/swarm` 记录；其他 orchestration 与 interjection 的默认可见性不受影响。Provider-transfer transcript、显式 Conversation 导出与完整 Trace 可以保留内部编排内容。

Tool description 明确要求只有用户已经提出 Swarm、多 Agent、并行调查或独立交叉检查时才能调用，不能仅因任务复杂而自行启动。父 Agent 可行时先运行可共享验证，再把命令、退出码和精简关键输出写入 `sharedContext`；无法验证时明确说明。每项 task 必须显式选择 `readonly | inherit`，可写任务尽量使用互不重叠的文件或子系统所有权。allocator 会优先轮换合格 `Provider + model`，池不足时仍可能复用，Tool 不作绝对异构承诺。

每个新 Public Run 都根据宿主能力、本轮冻结的 Subagents 开关和当前模型池重新计算一次 Swarm capability；普通发送、`run:retry` 与 `run:continue` 使用同一初始化边界。`/swarm` 只在该基础 capability 上补充本轮 goal 和编排上下文。设置不变时，续跑前后的 Provider Tool catalog 必须保持一致；内部 child Run 因冻结 `subagentsEnabled = false`，不得获得 `swarm_run`。

`swarm_run({ sharedContext, tasks })` 是 `executionMode = parallel`、`effects = []`、`defaultRisk = low` 的编排 Tool；顶层 `sharedContext` 保存全部 Child 共用的背景、证据、约束、验证结果和输出要求，每项 task 提供唯一安全名称、Child-specific 任务、`light|standard|strong` 最低能力、replica 数量和 `toolAccess`。两部分合起来自包含。编排调用本身不强制人工审批；每个 `inherit` child 实际提出的副作用工具仍按父 Run 的冻结权限模式分别审批。

Coordinator trim 并校验公共上下文和 task 后，把同一 `sharedContext` 与 task 的 `toolAccess` 复制到每个 prepared child spec，再从一次 PublicConfig 快照确定性分配并冻结全部 route。Subagent execution 将 XML-text 转义后的公共部分作为独立 `selected_context` canonical record 注入，将转义后的 `<swarm_task>` 作为该 Child 的 `user_input`；基础 system harness 把前者定义为背景、后者定义为当前委派任务与冻结权限。公共上下文和 task 不拼成不可分割字符串，Agents 详情从 user record 安全解包原始 task。随后 Backend 在一个 SQLite transaction 中创建 Swarm root 和所有 queued child，并按 parent Session 的 active leaf 原子预留全部容量；assignment、配置 revision 竞态或容量不足都在任何 child Provider 请求前整体失败。成功后先写初始 manifest，再立即返回 handle；冻结后配置热变更不重分配，失败 child 也不自动切换 Provider 重试。

Swarm child 使用 backend-private prepared execution 路径。每个 child 根据 `toolAccess` 从父 Run 冻结工具与权限上下文，随后直接并发创建 hidden Session 并启动 worker timeout，不进入全局 FIFO Run slot。同一父 Run 的多个 Swarm Job、不同父 Run 的 Job 和 sibling child 都可以并发；父 Run 结束或取消不影响它们。终态释放 leaf 名额；设置调低不取消存量，新 start 只在当前 active leaf 低于新上限后成功。

内部 durable result 使用声明顺序稳定的扁平 `results[]`：每个 replica 独立携带 task/agent 序号、终态、成功文本或有界错误、安全 assignment、耗时、usage 与截断标记；`meta` 聚合 Job 状态、数量、耗时和 usage。部分失败保留全部成功与失败项，全部失败记录明确错误；不会自动重试或启动第二个聚合 Run。结果总 JSON 有 2 MB 防御上限，超限时公平收窄成功文本与错误正文但不删除条目。相同 root call 与参数 hash 幂等返回同一 handle，不同参数明确冲突。

模型侧不内联上述聚合 result。`artifacts/swarms/<root-id>/manifest.json` 从 preparation 起保存 `sharedContext/tasks`、每个 child 的 ordinal、task/agent index、安全 assignment 和 artifact path，状态更新保留这些静态字段并原子追加 counts/status/error；manifest 不保存进程内模型操作 ID。`background_wait/list` 对 Swarm 返回 root 状态、child counts、当前进程可用的 child 数字 target 与 `manifestPath`；主 Agent按需用 `read_file` 分页读取 manifest 和 child `result.md/activity.jsonl`。

独立 `agent-execution:event` 只投影安全生命周期和可见活动，不把 hidden Session 伪装成普通 Session。Background 根列表显示普通 Subagent、Swarm root 与当前进程的 Terminal；展开 Swarm root 后按 `childOrdinal` 显示 child。两级均使用手动 `NCollapse`，不自动展开；详情只显示运行时间、工具调用数、状态、模型/usage/Agent 计数和可见 Assistant 文本，不展示 reasoning、完整工具轨迹、child Session ID、prompt harness、route 凭据或 Provider continuation。

统一 `BackgroundTaskService` 以 SQLite execution 与 TerminalPool ownership 为权威，同时用一个进程内 registry 把 durable Agent execution UUID 映射为全局递增数字；模型输入永不直接解析或接受 UUID，重启后通过 `background_list` 为历史 root 分配新数字。`background_wait` 接受混合 target、`any|all` 和 timeout，只在 Agent 终态、PTY exit/failure 或正常超时返回；普通 Terminal 输出不参与唤醒。返回前按 public owner 读取 Terminal 当前最后 50 行 ANSI-free tail，不再维护 wait 起始 cursor 或 delta 语义；显式关闭的 Terminal 在进程内额外保留同样有界的 tail，完整历史仍以日志 artifact 为准。tail 继续受 Run 冻结的全局字节限制；纯 Agent 最大等待 300 秒，含 Terminal 最大 60 秒。`background_list` 将 standalone root、Swarm root 与 Terminal 按创建时间合并，使用绑定 filters 的 opaque 分页 cursor，并按冻结 Tool 输出 budget 生成不会被通用 limiter 破坏的精确页。`background_cancel` 校验数字 target 的当前进程映射和公开 Session ownership，幂等取消 root/child/Terminal，可选等待最多 60 秒；Swarm root 级联 child，单 child 取消触发 root 重汇总。

### Background UI 与取消收尾

Renderer 的 `background:list/cancel/terminal-tail` 使用 shared 类型和公开 Session ownership，复用 `BackgroundTaskService.cancelOwned`，不暴露通用模型 Tool JSON 或 hidden Session。Agent 使用 durable execution ID，Terminal 使用当前 backend 实例与数字 ID；模型的数字 handle 契约不变。

列表通过协调队列同步采样 SQLite root、TerminalPool 和 runtime cursor，按活动优先、创建时间倒序分页；活动数量独立于页大小。Agent 事件、详情与 Background 失效事件共享实例内单调 observation sequence，详情同时携带 execution sequence。Renderer 按水位合并摘要，缺口恢复采用快照与有界后续事件回放；backend 实例变化清空进程副本。

Swarm 在 durable reservation 后、任何异步 artifact/publication 步骤前登记控制器，并保留更早到达的取消意图。状态发布失败记录诊断，不中止已持有资源的 worker；启动或 durable 更新失败需取消并等待已启动 child，收敛剩余预留记录。正常状态机和结果聚合保持既有定义。

显式停止 child 时，先阻止其实际 Session 新建 Terminal，再中断 Run 并关闭已有 PTY；晚完成的打开操作也失效。等待不可立即中断的已派发操作和终端退出、日志关闭后，才发布 child 终态并释放 leaf 容量。Swarm 取消还等待已完成 child 遗留终端的关闭。正常 Agent 完成继续允许独立终端运行；主 Run 结束或 Stop 不级联后台任务。

### Headless 运行输出

- 内部 Headless host 必须复用桌面端唯一 Agent Runtime 组装入口，固定 Yolo 且不增加、删除或替换模型可见工具。
- Headless config v5 必须支持与 Desktop 相同的 `subagents.enabled/workerTimeoutMs/maxSubagents`，并迁移 v1–v4 输入；Runtime Identity v6 记录字节/行数 Tool 输出预算、worker timeout、`maxSubagents` 和 `swarmsEnabled = false`，移除 token 单结果预算，并从 tool 名称/hash 排除 `swarm_run`。Headless 暴露异步 `subagent_run` 与全部 `background_*`；普通 child execution 仍使用相同 live workspace、隐藏 Session、Tool profile 和 usage 归属。
- 每次 Headless 任务把 Session temp 放在调用者显式 artifacts 目录下；主流程结束时取消未等待的后台任务，已经生成的文件由调用者管理，不执行 Desktop 24 小时清理。
- stdout 只允许版本化 JSONL；Operational Log 独立写入 artifact 目录且不得混入 stdout；host 诊断写 stderr；最终 `result.json` 原子写入 workspace 外的 artifacts 目录并返回运行日志目录。
- Provider 凭据只能由受信任配置声明的环境变量名称解析，凭据值不得进入配置回包、JSONL、trace、工具参数或子进程环境。
- result schema v2 必须记录 session/run id、终态、未完成原因、wall time、最终回复、usage、工具统计和 trace 路径；不返回 `patchPath/patchStatus`，也不生成 `workspace.patch`。`completed` 只表示 Agent run 正常结束，不替代外部业务验收。
- Plan 自动批准必须在前一 run 完全 settle 后，通过有版本的 harness 消息追加到历史和 trace；不得伪装成用户消息。Goal blocked 或自动批准达到上限返回 `needs_human_input`。
- timeout、SIGINT 和 SIGTERM 必须进入共享 interrupt/disposer；Headless 不为结果采集读取或修改 workspace 的 Git index。
- 每个 Headless artifact 必须包含 runtime identity；source commit、task/config digest、provider/model、核心预算、prompt/tool hash 或 capability 不同的结果不得直接比较。
- Electron/Headless parity 必须通过共享 trajectory 比较 Provider messages、稳定 prompt layer、工具定义与调用以及 compact/Plan/MCP 行为；只允许逐字段声明的 host 差异，禁止宽泛 snapshot 忽略。
