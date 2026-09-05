# Subagent、Swarm 与后台任务决策

本文按主题保存历史决策。每条日期是决定发生时间，状态和后续替代条目共同解释适用范围；当前规则见[架构总览](../architecture.md)。返回[决策索引](../decision-log.md)。

## 2026-08-06 — Swarm 数量归 Job 所有，模型池只描述可选 Route

- 状态：已采纳并在 Desktop S4 落实；Headless 明确不暴露 Swarm。
- 配置边界：AppConfig v19 删除 pool entry 中从未执行的 `maxParallel`，并在 `subagents` 增加 `maxAgentsPerSwarm`（默认 10、范围 1–32）。前者避免把执行期容量错误地绑定到模型 route，后者限制单次 Swarm 创建的 child Agent 总数；`limits.maxConcurrentRuns` 继续独立限制全应用同时 active 的 Run，主 Run 自身也占一个 slot。
- 容量边界：模型池不再采用 64 条 Route 的产品级限制，当前 schema 与 Renderer 共用 1,000 条防御性上限，只用于拒绝异常 IPC/config 负载。它不表达执行容量；真正的运行边界仍由单个 Swarm 的 Agent 总量和全局并发 Run 数控制。
- 工具契约：`swarm_run.tasks[]` 由主 Agent 显式提供自包含 `task`、`requiredCapability: light|standard|strong` 与 `agentCount`，不增加含义重叠的难度字段，也不由 Backend 猜测能力。Provider 可见 schema 在 `/swarm` Run 启动时根据冻结的 `maxAgentsPerSwarm` 生成，把该值写入 `agentCount.maximum`；设置变化从下一次 `/swarm` Run 生效。数组内 `agentCount` 求和仍由 Backend 在建 Job 前校验，因为 JSON Schema 不能表达跨元素求和；XML 提示不能替代 schema 和执行校验。
- Tool description 偏好：每个 task 默认 1 个 Agent；只有需要独立交叉验证、多视角调查或高风险复核时才增加数量，并选择足以完成任务的最低 capability，不能为了用满上限而扩张。
- 分配边界：所有 `actualCapability >= requiredCapability` 的模型都可参与；allocator 按稳定声明顺序先均匀轮询 `Provider + model`，再轮询该模型入池的精确 reasoning route。这样同一模型选择更多 reasoning 叶节点不会获得额外权重；模型数少于所需 Agent 数时自然重复使用。assignment 在 Job 创建时冻结，失败不自动换 Provider 重跑。
- 理由：任务需要多少独立 Agent 是一次 orchestration 的属性，模型池只回答“哪些精确 route 可以被选”。把数量放到 Tool/Job 并保留一个用户级硬上限，可以让主 Agent 按任务拆分，同时避免 per-route 配额、全局 Run 并发与 Job 总量三套相互重叠的配置。

## 2026-08-09 — Desktop Swarm 使用 Run-scoped capability 与全局 FIFO slot

- 状态：已采纳并实现 S4 基础链路；取消 UI、压力 hardening 与 Headless Swarm 延后。
- Capability 边界：只有 `/swarm <goal>` 启动的 Desktop 主 Run 能看到并执行 `swarm_run`。catalog 与 executor 双重检查冻结 capability；普通 Run、child Agent、历史重放和 Headless 都不能继承或伪造。Runtime Identity v5 用 `swarmsEnabled` 明确宿主差异，Headless tool 名称/hash 同时排除 `swarm_run`。
- 持久化边界：一次 Job 在同一 SQLite transaction 创建一个 Swarm root 和全部 queued child；root call 与 child ordinal 分别唯一。公共执行列表只返回 root，详情附带 children；hidden canonical Session 继续不进入普通 Session API。配置、assignment 或上限校验必须在任何 child Provider 请求前完成。
- 并发边界：普通 Run 与 `subagent_run` 保持 fail-fast；只有 prepared Swarm child 在全局 Run coordinator 上 FIFO 等待空闲 slot，取得 slot 后才创建 hidden Session 并启动 worker timeout。父 Run 占一个 slot。同一父 Run 的多个 Swarm Job 严格串行，不同父 Run 可以并发；取消与应用退出同时覆盖 queued/active child。
- 结果边界：replica 逐项、按声明顺序进入扁平 `results[]`，父 Agent 自行聚合。部分失败保留兄弟成功结果，不自动重试或换 Provider；全部失败返回 Tool error。2 MB 上限通过公平截断成功文本收敛，不能删除结果项，也不能暴露 reasoning、凭据、child Session 或完整工具轨迹。
- 界面边界：Agents artifact 使用手动两级 `NCollapse` 展示 Job → Agent，活跃徽标只计 leaf Agent。详情仅展示统计与可见 Assistant 消息，不自动展开、不复制主时间线，也不提供 child 会话导航。

## 2026-08-12 — Swarm 改为普通 Tool，并在所有权限模式逐次人工审批

- 状态：已采纳；本条取代 2026-08-09 决策中的 Run-scoped capability 边界，持久化、并发、结果与 Agents artifact 边界保持不变。
- Tool 可见性：满足 Desktop host、Subagent 开关、至少两个全局 Run slot 和 enabled 模型池 route 的普通主 Run 都能看到 `swarm_run`。`/swarm <goal>` 仅作为显式请求与目标编排快捷命令，不再授予特殊 capability；child、历史重放和 Headless 继续被 catalog/executor 双重拒绝。
- 使用约束：Tool description 明确要求只有用户已提出 Swarm、多 Agent、并行调查或独立交叉检查时才能调用，不能仅因任务复杂自行启动。工具保持只读 effects，但 `defaultRisk = review`；当前策略引擎因此在 readonly、auto、confirm 与 YOLO 中都请求人工审批，不经过自动审批模型，也不支持记忆批准。
- 审批界面：一次审批绑定完整 `swarm_run` 参数并覆盖整个 Job，不逐 child 弹卡。专用卡显示任务与 Agent 总数、每项名称/正文/能力/副本数，并提示额外 Provider 请求和费用；参数异常时回退到安全原始 JSON，不能因 Renderer 投影失败而隐去审批信息。
- 理由：普通 Tool 比一次性 slash capability 更符合模型原生工具编排，也允许用户用自然语言明确要求 Swarm；强提示减少误调用，逐次人工审批则在模型仍误判时保留成本与调度控制。YOLO 继续审批是刻意接受的简单语义，避免为单个工具扩展额外权限策略枚举。

## 2026-08-12 — Swarm assignment 拆分公共上下文与 Child task

- 状态：已采纳；本条更新 S4 Tool 输入与 Child prompt 注入方式。
- 输入边界：`swarm_run` 使用必填 `sharedContext + tasks[]`。公共字段承载全部 Child 共用的背景、证据、约束、验证结果和输出要求，每个 task 只声明 Child-specific 职责；两部分合起来自包含。专用审批卡必须同时展示公共上下文和全部任务。
- 验证边界：Child 工具 profile 不含命令、终端、构建或测试能力。父 Agent 可行时先运行相关验证，在下一轮把命令、退出码和精简关键输出写入 `sharedContext`；无法执行时明确说明，不能在同一 Tool batch 中假定尚未返回的测试结果。
- 副本策略：适合交叉验证时鼓励使用接近本次 Job 上限的 Agent 数，并允许同一 task 多副本。allocator 只保证优先轮换满足能力要求的不同 `Provider + model`，合格模型不足时允许复用，提示词不得承诺绝对异构。
- 历史边界：每个 hidden Child Session 分别持久化 XML-text 转义后的 `<swarm_shared_context>` prompt layer 与 `<swarm_task>` user input。基础 harness 明确 tag 语义；Renderer 解包 task，公共上下文不进入普通用户消息投影。

## 2026-08-14 — Swarm 编排 Prompt 不进入普通对话时间线

- 状态：已采纳并实现；本条只改变 `/swarm` 内部 Prompt 的展示，不改变其他 orchestration 的现有可见性。
- 记录边界：用户提交的 `/swarm <goal>` 继续保存并展示为 visible `user_input`。解析器生成的 `<orchestration_request kind="swarm">` 继续保存为 canonical `orchestrator`，但显式使用 `visibility = hidden` 与 `inHistory = true`，因此 Provider 可见、普通聊天不可见。
- 兼容边界：append-only canonical history 和旧 SQLite rows 不做迁移或改写。Renderer 以稳定 provenance `slash:/swarm` 抑制旧版本已经保存为 visible 的 Swarm Prompt；`/prompt`、`/goal`、`/plan` 与 interjection 不受影响。
- 投影边界：`orchestrator.message` runtime/trace event、工具审批和 Agents artifact 继续使用各自通道。普通消息搜索与时间线排除内部 Prompt；Provider-transfer transcript、显式 Conversation 导出和完整 Trace 可以保留它。
- 理由：内部编排正文是模型控制上下文，不是用户或 Assistant 的对话内容。保留 canonical 记录维持 Provider 连续性与审计能力，隐藏普通时间线则避免重复展示 `/swarm` 请求和造成角色混淆。

## 2026-08-26 — 移除产品级并发准入并让主 Agent 显式委派工具权限

- 状态：已采纳并实现；覆盖 2026-08-06 “Swarm 数量归 Job 所有”中用户级并发上限、逐次 Swarm 审批和只读 child 的部分，保留模型池分配与固定协议容量边界。下述文件 precondition/FileChange OCC 保留项已由 2026-09-01 best-effort/last-writer-wins 与 2026-09-02 删除 FileChange 的决策取代。
- 工作区并发：删除全应用 Active Run slot、canonical workspace writer lease、强制只读降级、启动拒绝、Renderer 禁用态和 `<workspace_concurrency>` 提示。不同 Session 可以在同一 workspace 并发执行和写入，不额外警告；同一 Session 仍只允许一个 Active Run，以保持 canonical history 线性。
- 配置迁移：AppConfig v24 删除 `limits.maxConcurrentRuns` 与 `subagents.maxAgentsPerSwarm`。v9–v23 使用各自冻结 schema 校验并保留其余字段后迁移；Agents/Runtime 设置页只保留 Subagent 开关、worker timeout、模型池与费用提示。`MAX_SWARM_AGENTS = 32` 仅作为 Tool schema、持久化计数和结果大小的异常负载边界，不是产品并发策略。
- 委派契约：`subagent_run` 增加必填 `toolAccess: readonly | inherit`；`swarm_run.tasks[]` 对每项任务增加相同字段。`readonly` 只取父 Run catalog 的无副作用子集；`inherit` 使用父 Session 权限模式和父 Run 冻结 catalog，不能提升只读父 Run。Goal、Plan、Subagent 与 Swarm 编排工具始终从 child 排除。
- 审批边界：Subagent/Swarm 编排调用本身为 parallel、无副作用、低风险，不强制人工审批。`inherit` child 的文件、命令、网络、终端或 MCP 调用继续逐次经过父权限模式对应的原权限管线；人工审批通过安全 `AgentExecutionEvent` 投影和独立 IPC 决策，不暴露 hidden Session identity。
- Swarm 执行：删除同父 Run Job 串行 tail 和 prepared child 的全局 FIFO slot；sibling Job、child 及不同父 Run 可以并发。Coordinator 仍在任何 child Provider 请求前原子创建 durable root/children、冻结全部 route、校验总 Agent 数，并按声明顺序汇总结果。
- 当前保护：PathGuard、工具 schema、权限校验、args-bound 审批、原子写入、精确 patch 匹配、输出/timeout 上限和取消传播保持不变。内容/file-identity precondition 与 FileChange OCC 已删除；移除 workspace 互斥不允许 child 超出父 Run 权限。

## 2026-08-28 — Agent 与 Terminal 统一为可留档的 Session 后台任务

- 状态：已采纳并实现；取代 2026-08-09/08-26 中 Subagent/Swarm Tool 等待最终聚合结果、父 Run 取消传播和固定 Swarm 32 上限的现行部分，也关闭 `open-design-questions.md` 中 `terminal_read` 投影问题。历史条目继续记录当时边界。
- 异步契约：`subagent_run/swarm_run` 在 durable identity、原子容量预留和初始 artifact 成功尝试后立即返回 `{ target, status, artifactPath }`；相同 parent Session/Run/call + 参数 hash 幂等复用 handle，参数冲突失败。后台 execution 不再绑定父 Run AbortSignal；`background_wait/list/cancel` 统一管理 Subagent、Swarm 和 Terminal，child catalog 排除全部递归/后台编排工具。
- 容量契约：AppConfig v25 新增 `subagents.maxSubagents`（默认 32、范围 1–32），按公开 Session 的 `queued/preparing/running` leaf 计数，Swarm root 不计。SQLite transaction 原子预留整个 start；容量不足不创建部分 Job，终态释放，降低设置不取消存量。Swarm Provider schema 使用 Run 冻结值，Backend 复核跨 Job 剩余容量。
- 临时工作区：每个公开 Session 在 OS temp/profile hash/Session hash 下拥有权限 `0700/0600` 的真实目录，主 Agent 与 hidden child 共享。`artifacts` 由应用写完整输出副本，`scratch` 可由内置文件工具免审批写入；应用对 workspace 和 scratch 都不产生自有 Diff/FileChange/rewind。相对路径仍属于 workspace，绝对路径由双根 PathGuard 校验。Shell 环境增加三个 `ZCH_SESSION_*` 变量但仍是宿主权限进程，不是 OS sandbox；Backend/SQLite 状态永远比可修改 artifact 权威。
- 生命周期：普通退出和归档保留 temp，Desktop 启动清理最后使用超过 24 小时的精确 Session 目录，永久删除立即清理。页面切换、context unload、父 Run 结束/中断、retry/edit/rewind 不取消后台任务；archive/delete/project delete/app quit 先阻止新任务、级联取消并等待收敛。重启把遗留 active Agent execution 标为 interrupted，不恢复 PTY。
- Terminal 契约：Provider catalog 删除 `terminal_read/list/close`，Renderer IPC 保留。`terminal_open` 在 spawn 前创建跨 chunk ANSI sanitizer 驱动的无 ANSI 追加日志并返回 background target；`terminal_send` 默认等待 1 秒，优先返回发送前 cursor 后增量，否则返回 20 行/8 KiB tail。`background_wait` 不因普通输出唤醒，但 PTY exit/failure 仍立即唤醒；退出或 timeout 始终附加当前最后 50 行无 ANSI tail，不再维护 wait cursor/delta。显式关闭时进程内保留同样有界的 tail；更早内容通过流式 `read_file` 读取完整日志。模型可见 artifact 字段使用 `ZCH_SESSION_*_DIR:/...` 短路径，read/list/glob/grep 在进入 PathGuard 前解析。
- 输出契约：Run 冻结默认 256 KiB/500 行的单次工具输出配置。统一出口只把 256 KiB 字节值作为 `bounded` projection 的最终安全保险；500 行值通过执行上下文交给工具自行解释，不再统一截断所有结果。`read_file` 的行预算只计算源文件正文，默认返回完整 500 行后再附 continuation footer；paged/passthrough 工具自行保证 continuation。AppConfig v25 删除 token/read 重复预算，Headless v5 与 Runtime Identity v6 记录 bytes/lines/worker timeout/`maxSubagents`，SQLite v10 只增加 active leaf 查询索引。Command/Terminal/Subagent/Swarm 永久尝试留档，Fetch/Search 保存已获取结果，MCP 超过自身阈值才落完整 JSON；捕获失败显式返回 unavailable/error。
- 文件续读：`read_file` 不再向模型暴露绑定路径、文件身份和字节 offset 的 base64 cursor。普通分页只返回/接收 1-based `nextStartLine/startLine`；超长单行或无换行 EOF 的 append 额外使用 0-based Unicode code-point `nextStartCharacter/startCharacter`，内部仍流式换算字节位置并在 UTF-8 边界停下。
- 后台句柄：Subagent 与 Swarm 的模型操作 target 共享当前进程递增且不复用的 Agent 正整数空间；Terminal 使用相同形状但保留独立数字空间，由 target `type` 区分。两者重启后都失效。Agent durable UUID 继续用于 SQLite、Renderer Agents API、事件、日志与内部父子关系，但模型工具 schema 不接受 UUID；`background_list` 为历史 root 懒分配当前进程 target，Swarm 快照提供 child target，持久 manifest 不保存操作句柄。
