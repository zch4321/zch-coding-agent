# Runtime 与生命周期决策

本文按主题保存历史决策。每条日期是决定发生时间，状态和后续替代条目共同解释适用范围；当前规则见[架构总览](../architecture.md)。返回[决策索引](../decision-log.md)。

## 2026-08-27 — 中断续跑由 canonical history 推导

- 状态：采用。
- 决定：不持久化独立的 interrupted Run 标记；renderer 与 backend 共享同一 history 判定器，只有 active history 停在明确的驱动记录时才开放 `run:continue`。Application 校验 revision，Session Core 再校验 live history。
- 理由：Run status 和 partial stream 本来就是瞬时状态，应用重启后不可依赖；完整 Assistant 结束边界、terminal tool batch 和 compact `turnId` 已经足够区分“已完成”与“可以从 canonical context 继续”。共享判定避免 UI 猜测与 backend 行为分叉。
- 当前语义：继续不追加 user message、不生成空 commit，并沿用原 turn identity。尾部 passive prompt layer 不影响判定；control command、手动 compact、conversation transcript 和完整 Assistant 均阻断继续。

## 2026-07-25 — APP-6：极端并发下 run:start 请求缓存逐出

- 状态：接受，不修复。
- 决定：继续使用当前有界请求缓存，不为 in-flight 与 settled 项拆分缓存或增加 ownerToken 引用计数。
- 背景：需要超过 1,000 个并发在途 new-session 请求挤掉仍在执行的同 key 条目，再以相同 key 重入，才可能共享 ownerToken 并让失败方影响成功方 context。
- 理由：Desktop/Headless 的全局并发上限为 32，正常产品入口无法达到该前提，现实可达性近乎为零；为不可达路径增加复杂生命周期机制收益不足。
- 重新评估条件：提高或绕过全局并发上限、开放多客户端共享 backend，或把请求缓存复用于高并发服务端部署。

## 2026-07-25 — REQ-1：请求幂等指纹暂不包含完整提交语义

- 状态：搁置。
- 决定：`run:start` 的 requestHash 暂时仍以消息正文为主，不在本次切流中纳入附件、候选 Session model/mode/Goal/Plan 等完整语义。
- 已知代价：调用方错误复用同一 `clientRequestId` 且正文相同、其他输入不同时，backend 可能把请求视为重复。正式 renderer 每次提交生成新 ID，因此正常 UI 不会触发。
- 重新评估条件：提供离线队列、跨进程 command replay、公开自动化 API，或需要对网络级重放作强幂等保证。

## 2026-07-25 — 日志热切换采用分段 capture，不补录历史

- 状态：已采纳。
- 决定：一次日志启用或 Durable Session 恢复对应一个独立 capture；`traceId` 不再等同于 `sessionId`，旧文件不追加。已有对话开启日志后只记录后续操作，不把 SQLite 中的既有消息、工具或 reasoning 回填到 trace。
- Run 边界：active Run 中开启时，当前 Run 完全不记录；active Run 中关闭时，当前 Run 记录到终态。一次 Run 中多次切换以最后一次成功保存的配置为准。
- 理由：半截 Run 或事后合成历史会让 trace 看似完整但缺少真实 Provider/stream/tool 时序，降低离线诊断可信度。分段 capture 能明确记录采集生命周期，并允许现有 Session 无需重载即可启停。
- 失败语义：capture 创建或写入失败只把状态降级为 `degraded` 并切换 Null logger，不影响模型和工具；下一 Run 开始时重试新片段。UI 持续展示 warning，直到成功创建新片段或关闭日志。

## 2026-07-26 — Carryover 启动失败直接丢弃

- 状态：已采纳。
- 决定：上一 Run 终态边界产生的 carryover 按 FIFO 自动启动；若某项 `run:start` 返回失败或 IPC 抛错，renderer 立即移除该队列项和 overlay chip，以 10 秒 warning 告知用户，不提供重试入口，并继续处理下一项。
- 理由：carryover 只覆盖 final-answer 边界的极窄输入窗口。为这个低概率路径维护持久重试队列、人工恢复 UI 和额外幂等状态，复杂度高于消息价值；失败后保持队列反而会永久阻塞该 Session 的普通发送。
- 边界：成功提交到 backend 后即视为已消费；若仅 renderer reconcile 失败，则保留 active Run、触发 Session reload，并以 error 提示，不会重复提交同一 carryover。

## 2026-08-09 — `run_command.shell` 由用户配置且显式启动

- 状态：已采纳第一阶段；交互 Terminal profile 与可见 PTY 复用继续留在 M5。
- 选择权：模型不选择 Shell，也不能在 Tool 参数中提交 Shell ID。AppConfig v20 保存 `executionEnvironment.commandShell`；Prompt Harness 只告诉模型本轮实际解析出的 `command_shell`，要求使用对应语法。
- 发现与回退：Main process 有界发现 PowerShell 7、Windows PowerShell、CMD、Git Bash 和 Nushell；Windows `auto` 固定为 PowerShell 7 → Windows PowerShell → CMD。显式选择失效时临时回退到 `auto`、设置页显示警告，但不改写用户保存值。Git Bash/Nushell 不进入自动优先级，WSL 与自定义 profile 暂缓。
- 执行边界：`run_command.process` 与 `run_command.shell` 都使用 `spawn(..., { shell: false })`；后者由可信 adapter 传入解释器 executable、固定启动参数和原始命令。内部 Git、Subagent 与当前 PTY 不读取该配置，`run_command` 输出也不实时展示到 Terminal。
- PowerShell 脚本边界：应用启动的 PowerShell 一次性命令和持久 PTY 都传入 `-ExecutionPolicy Bypass`。不增加策略预检、设置页提示或专用错误转换；启动和脚本失败沿既有 stderr/exit code/PTY 输出链返回。
- Terminal 默认值：Windows `terminal_open` 未显式提供 executable 时复用 PowerShell 7 → Windows PowerShell → CMD 的自动发现顺序，但不读取一次性命令的已保存 profile；独立 Terminal profile 仍留在 M5。
- 编码边界：内置 adapter 请求 UTF-8；捕获层流式验证 stdout/stderr，遇到无效 UTF-8 时按启动时探测的 Windows 代码页解码。第三方程序仍可能忽略控制台编码约定，因此这是确定性解码回退，不是对任意程序输出格式的绝对保证。
- 理由：让模型从候选列表选择会把宿主安装状态变成不稳定的模型决策，也会扩大命令审查和 quoting 状态空间。用户选择、Main 解析、Prompt 只报告事实，可让审批看到原始命令，同时消除 Node 在 Windows 上隐式落到 CMD 和 OEM code page 的行为。

## 2026-08-16 — 命令 Shell 与交互 Terminal 统一运行模型

- 状态：已采纳并实现；本条统一 `run_command.shell` 与交互 Terminal 的解释器来源，并收敛 Terminal 标识符、数量上限与 resize 边界。
- 共享配置：`terminal_open` 删除模型可见的 `shell` 参数。TerminalPool 在每次打开 Terminal 时读取 `executionEnvironment.commandShell` 并经 CommandShellService 解析实际 profile；配置失效时沿用自动回退，不改写保存值。解析为 PowerShell kind 时 PTY 固定传入 `-ExecutionPolicy Bypass`。设置变更只影响之后打开的 Terminal，已运行的 Terminal 不重启。`run_command.process`、内部 Git、Subagent 与其他直接进程仍不读取该配置。
- 标识符：`terminalId` 从 `terminal:<UUID>` 字符串改为进程内全局递增的正整数；应用重启后从 1 重新开始，ID 一经分配在当前进程内不复用，启动失败允许留下编号空洞。共享 Schema、IPC、事件、Tool 入参与 Renderer 同步改为整数。不迁移数据库或旧日志；不存在或不属于当前 Session 的 ID 统一返回 `Terminal not found for this session`。
- 数量上限：每个 Session 最多保留 16 个 Terminal（含 opening、running 与已退出但未显式关闭的条目），显式关闭立即释放名额；打开前同步预留名额，Tool 与 Renderer 并发打开不会越过上限；`terminal_list` 按数字 ID 升序返回。Session 关闭按世代作废仍在启动中的打开尝试，Pool 释放后拒绝新的打开，避免孤儿 PTY。
- Resize 边界：删除模型可见的 `terminal_resize` Tool 及其输入 Schema 与结果投影；保留 `TerminalPool.resize`、`terminal:resize` IPC、preload API 与 Renderer 面板自动 fit/resize，前端尺寸变化继续同步给 PTY。
- 模型上下文：`<environment_context>` 保留 `command_shell` 字段；基础提示词明确它同时适用于 `run_command` shell 模式与 Terminal，Terminal 自动使用该 Shell，模型只能按对应语法编写命令。设置页文案改为“命令与终端 Shell”并更新提示与回退警告。
- 理由：解释器选择是用户环境决策，不应由模型在 Tool 参数中指定或绕开；短数字 ID 缩小模型引用与伪造的错误面，数量上限约束 PTY 资源占用；终端尺寸由前端布局驱动，模型无需手动控制。本条关闭 open design questions 第 2、6 项。
