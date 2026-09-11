# Terminal、Skills、MCP 与 Session Artifact

本文规定宿主集成及临时输出的归属。代码入口见[集成与宿主地图](../code-map/integrations-and-hosts.md)。

返回[架构总览](../architecture.md) · [文档入口](../README.md)。

## Project、Terminal、Skills、MCP 与插件

这些服务继续由 backend 拥有：

- Project explorer 继续读取普通 workspace 文件；ProjectModel/Serena/code intelligence query 暂停，等待总路线图中的 Swarm hardening 完成后迁移到 SQLite。
- TerminalPool 持有 PTY、scrollback、实际 Session 与公开 owner Session 的映射；context unload 不关闭独立终端，应用重启不恢复真实 PTY。
- Skills manager 扫描、安装和启用 skill。
- MCP manager 拥有连接、目录 revision、tool normalization 和调用。
- Plugin event bus 是 backend hook/event mechanism。 `beforeLLMCall` 只收到不含凭据的编译请求深拷贝；它只能观察，不能 patch、阻断调用或改写 canonical history，handler 失败只产生诊断。

它们需要加入模型历史时，只能创建完整 Message；不能把半完成内部状态写进 messages。

### `exec_command` 与 Terminal 的解释器边界

`exec_command 的 executable + args 启动方式` 始终把 `executable + args[]` 交给 `spawn(..., { shell: false })`。`exec_command 的 command 启动方式` 也不使用 Node 的隐式 Shell：Main process 根据当前 AppConfig 的 `executionEnvironment.commandShell` 解析受支持 profile，再由 profile adapter 生成明确的 executable、固定启动参数和命令字符串参数，最终仍以 `shell: false` 启动。权限预览和 canonical ToolCall 保留模型提交的原始命令，不暴露 adapter wrapper。

Windows 发现只扫描 PATH 与有限的系统/安装目录，内置 profile 为 PowerShell 7、Windows PowerShell、CMD、Git Bash 和 Nushell；`auto` 固定选择 PowerShell 7 → Windows PowerShell → CMD。Git Bash 与 Nushell 只在用户显式选择时使用；System32 的旧 `bash.exe` 不会被误识别为 Git Bash。已保存 profile 消失时，解析结果临时回退到 `auto`，通过只读 `command-shell:list` IPC 把实际路径和 fallback 状态提供给设置页，但不改写保存值。WSL 与任意自定义 executable/args 仍属于 M5 后续范围。

Prompt Harness 在每个外部 Run 开始时读取同一配置并只注入实际解析后的 `command_shell: label (id)`；同一 Run 的后续 Provider 调用不重复刷新。runtime 语义指纹包含 Shell、权限、Provider、工具集合和 module markers 等稳定字段，但排除精确时间、Git 摘要与项目树；只有稳定指纹变化时才采集并追加包含最新 Git/项目树的完整快照。AGENTS 也只在外部 Run 边界检查，因此 Run 中途的规则变更从下一 Run 生效；会话创建、权限更新与 compact 新 epoch 仍按各自边界重建 Harness。`exec_command` schema 不接受 shell ID，因此模型不能自行选择未安装解释器。工具执行前会再次解析 Shell，以应对调用期间安装状态变化。内部 Git、Subagent 和其他直接进程不读取该选项。

PowerShell adapter 固定传入 `-ExecutionPolicy Bypass`，并设置 Console 与 pipeline 输出编码；CMD adapter 先切到 code page 65001，Bash/Nushell adapter 设置 UTF-8 locale。应用不预检 Execution Policy，也不把相关失败改写为专用错误；原始 stderr 和 exit code 沿普通 Tool Result 返回。`BoundedProcessOutput` 对 stdout/stderr 独立流式校验 UTF-8；若实际字节无效，则使用启动时探测到的 Windows 当前代码页解码保留区。有界内部执行器继续保留 head/tail、discard hash 和操作超时。exec 使用 Run 所有的 CommandSessionManager 与增量 CommandOutput；默认等待 10 秒、上限 60 秒，没有进程总运行期限。Run 正常结束、失败或取消都必须清理剩余进程树并等待日志关闭。它不进入 Renderer Terminal 或 Background，后续调用只返回未读输出。

交互 Terminal 与 `exec_command 的 command 启动方式` 共享同一个 `executionEnvironment.commandShell` 配置。`terminal_open` 没有模型可见的 `shell` 参数；TerminalPool 在每次打开时读取当前配置并经 `CommandShellService.resolve()` 解析实际 profile，配置项失效时沿用自动回退且不改写保存值。解析出的 profile `kind = powershell` 时 PTY 固定传入 `-ExecutionPolicy Bypass`，其他 kind 不附加启动参数。设置变更只影响之后打开的 Terminal，已在运行的 Terminal 不重启。

模型可见的 `terminalId` 是进程内全局递增的正整数：应用重启后从 `1` 重新开始，ID 一经分配在当前进程内不复用，启动失败允许留下编号空洞。每个 Session 最多保留 16 个 Terminal（含 opening、running、closing 和已退出但未显式关闭的条目），显式关闭在真实退出及日志收尾后释放名额；打开前同步预留名额，Tool 与 Renderer 并发打开不会越过上限。不存在或不属于当前 Session 的 ID 统一返回 `Terminal not found for this session`。Provider catalog 只保留 `terminal_open/send`，移除 `terminal_read/list/close`；Renderer 的 list/read/close/resize IPC 和多 tab UI 不变。模型把 `terminal_open` 返回的数字 ID 用于 `terminal_send`，并把同一数字 `{ type: 'terminal', id: terminalId }` target 用于 `background_wait/list/cancel`。

TerminalPool 在 spawn PTY 前打开权限为 `0600` 的 `artifacts/terminals/<artifact-id>.log`。raw chunk 一路进入 Renderer/xterm 和原始 scrollback；另一条路经过持久、跨 chunk 的 ANSI sanitizer 进入 model scrollback 与追加式日志，因此 OSC/CSI 分段不会按无状态正则误投影。capture 初始化/追加/close 任一步失败都会更新 backend-owned `artifactAvailable/captureError`。`terminal_send.delayMs` 缺省为 1,000 ms，可显式为 0，最大 60 秒；结果优先返回发送前 cursor 后的增量，否则返回 20 行/8 KiB tail，并始终携带 cursor 和 artifact 状态。

### Terminal 关闭与日志预览

显式关闭只先进入 `closing`，继续捕获最后的输出；实际 PTY exit 和日志追加、关闭完成后才进入 `closed`，移动到有界关闭缓存并释放显式关闭条目的名额。自退出、尚未被用户关闭的底部终端条目保留既有回看行为。关闭失败保留资源与活动状态并允许重试，wait 和会话清理不能将 kill 请求当成真实退出。

Background 按公开 owner 列出当前进程的全部终端，包括 hidden child 与手动终端；底部交互接口仍按实际 Session 校验。右侧日志读取只接收 parent Session、backend 实例和 Terminal ID，由主进程查登记路径并通过 temp PathGuard 校验普通文件；不接受任意路径。文件尾部按 32 KiB 分块，最多扫描 256 KiB，返回最近 200 行且最多 64 KiB，处理 UTF-8 边界。日志可修改、缺失或捕获失败，不能作为任务状态依据。

Terminal capture 创建时固定其 canonical temp root；活跃资源和已关闭缓存都保留该根身份。每次日志预览先校验当前短根仍指向登记目录，再检查文件真实路径，拒绝短根替换及子路径符号链接越界，不通过重新解析根目录扩大读取范围。

### 项目临时工作区与 artifact

Desktop 和 Headless 都由 `ProjectArtifactService` 管理项目产物。macOS 短基址为 `/tmp/zch-<profile-hash>`，其他平台使用 OS temp；项目短根由数据库中的稳定项目编号确定，直接包含以下入口：

```text
<项目短根>/
├── workspace -> canonical workspace（Windows 使用 junction）
└── tmp/
    ├── artifacts/
    │   ├── terminals/3.log
    │   ├── commands/17/{stdout.log,stderr.log,result.json}
    │   ├── subagents/8/{result.md,activity.jsonl}
    │   ├── swarms/2/manifest.json
    │   ├── fetch/5/result.json
    │   ├── web-search/4.json
    │   └── mcp/9.json
    └── scratch/
```

同项目所有公开 Session 和 hidden child 共享目录；来源 Session、execution/call key 和文件状态保留在 `<profileData>/agent.db`。SQLite v13 新增 `project_runtime_roots`、`project_artifact_sequences`、`project_artifacts` 和 legacy path registry。编号按项目、产物类型事务分配，同来源幂等，允许空洞且清理/重启后不复用。Terminal 操作 ID 仍为进程内 handle，与日志编号独立。目录缺失时按登记地址重建；移除项目后清理短根，失败在下次启动/定期回收时重试，绝不跟随 workspace 链接删除工作区。

应用验证私有目录、归属 marker、workspace 绑定和写入祖先，拒绝被替换的链接或普通入口；Unix 目录 `0700`、文件 `0600`。项目重新关联沿用 idle/eviction 边界，下次加载时只允许把仍指向登记旧 workspace 的链接更新到新地址。

新 Harness 和工具元数据只提供原生绝对路径，文件工具、process argv、Shell、Terminal cwd 可以直接复用。命令环境同时提供 `ZCH_WORKSPACE_DIR`、`ZCH_PROJECT_TEMP_DIR`、`ZCH_PROJECT_ARTIFACTS_DIR`、`ZCH_PROJECT_SCRATCH_DIR`，不覆盖 OS TMP/TEMP。动态短根不进入 runtime semantic hash，双语路径协议通过 Prompt resource version 标记。普通文件正文、stdout/stderr、MCP 内容与已有 canonical messages 保持原文。

旧 Session 根仅依据持久 Session 清单和归属 marker 发现。迁移先登记 pending 映射，再复制到 staging 并校验内容，原子安装后标记 ready；中断后按登记重试。旧完整输出保留原生副本到产物过期，旧 scratch 按数字导入目录迁移并通过原生链接保持新旧写入一致。`ZCH_SESSION_*` 环境变量保留原 Session 视图，旧工具 alias 在 PathGuard 前按来源映射，fork 的同名歧义报 `AMBIGUOUS_LEGACY_PATH`，失败迁移报 `LEGACY_MIGRATION_PENDING`。新输出不生成 URI alias。

`PathGuard` 把相对路径固定解析到 canonical workspace，只接受当前项目的 workspace 入口和 tmp，检查真实目标与登记根。read/list/glob/grep 可读共享产物；write/apply/delete 只能写 workspace 或 scratch，拒绝 application-owned artifacts。scratch mutation 在 Auto/Confirm/Yolo 免审批、Readonly 无写 catalog；Shell 仍是宿主权限进程。文件共享不改变 `background_cancel`、`terminal_send` 的 Session 归属检查。

Command/Terminal/Subagent/Swarm 始终尝试完整留档；Fetch/Web Search 保存已获取/规范化结果，MCP 在模型投影超过 256 KiB 或 500 行时保存规范化 JSON。Swarm manifest v3 保存数字产物目录的原生地址。Backend state 始终权威，捕获失败返回 `artifactAvailable = false/captureError`。

捕获完成、失败或取消且所有写入收尾后，记录独立 `finalized_at`，保留 24 小时。启动时和每分钟分批清理到期产物及兼容副本；活跃捕获、任意 scratch 文件不进入 TTL。读取、其他 Session 活动和归档不延长时间；删除单个 Session 保留共享文件。获得 profile 独占权后的恢复将上次进程遗留捕获标记 interrupted，pending 迁移另行恢复。没有磁盘配额；对话搜索投影仍为后续工作。

### Skills（渐进式专家指令）

#### 是什么

Skills 是高度浓缩的「专家指令」——一段描述某领域最佳实践的 markdown（SKILL.md）。采用**渐进式上下文**加载：

- **摘要阶段**：启动时扫描 skills 目录，把每个 skill 的 frontmatter（name + description + trigger）提取出来，作为 harness selected context/skills summary 注入（便宜，常驻上下文）。
- **正文阶段**：Agent 判断某个 skill 相关时，调用 `read_skill(name)` 工具加载完整正文，按其指令执行（按需，省 token）。

#### SKILL.md 规范

```markdown
name: pdf
description: 专业 PDF 工具集，覆盖报告/海报/论文/提取/合并等
trigger: 用户提到 PDF 处理、生成、转换时

（正文：详细执行指令、步骤、注意事项。仅 read_skill 时加载）
```

- 摘要 = frontmatter；正文 = 文件剩余部分。
- 缺失/格式错误的 frontmatter 的 skill：跳过并记日志，不中断启动。

#### Skills 来源（用户管理目录）

Skills 存于**用户数据目录** `userData/skills/*.md`（不在 app 安装目录，便于升级与用户自管理）。三种安装入口：

1. **直接放文件**：用户手动往目录拷 `.md`。
2. **链接下载**：应用内输入 URL，下载 `.md` 存入目录。
3. **上传安装**：应用内文件选择器，选本地 `.md` 拷入目录。

> 三种入口都写入同一个用户目录；启动时统一扫描。应用本身**不内置** skill 文件。

安全要求：

- Skill 是会影响 Agent 行为的**不可信指令**，安装后必须记录来源、内容哈希和启用状态；下载或上传不等于自动信任。
- URL 安装仅允许 HTTPS，限制重定向次数、文件大小和下载超时，并阻止访问环回、链路本地和内网地址，避免 SSRF。
- Skill 名称只能作为已扫描索引的 key，不能直接拼接成文件路径。

#### 工具

| 工具               | 作用                      | 副作用 | `reason` |
| ------------------ | ------------------------- | ------ | -------- |
| `read_skill(name)` | 读取指定 skill 的完整正文 | 无     | **是**   |

### MCP（Model Context Protocol）客户端

#### 是什么

实现 **MCP 客户端**（不是 server），用于连接外部 MCP server，复用第三方工具生态（如 GitHub、数据库、文件系统等 MCP server 提供的工具）。

#### 传输

- **stdio**：spawn 本地 MCP server 子进程（首要）。
- **其他 transport**：Streamable HTTP 与旧 HTTP+SSE 当前均未实现；扩展时需要单独定义信任、鉴权和连接生命周期。

#### Generic MCP v1 能力范围

- **配置**：用户在 `userData/config.json` 手写 stdio server 配置。全局 server 在应用启动时连接，工作区 server 在对应工作区激活时连接；启动命令变更会使 fingerprint 信任失效。
- **稳定 gateway**：Provider 始终只看到 `list_mcp_servers`、`read_mcp_server`、`call_mcp_tool` 三个固定工具。目录读取按 server 分页，MCP 的 `tools/list` 本身也完整跟随 server cursor，配置和目录变化不改变顶层工具定义。
- **披露约束**：会话必须先读取包含目标工具的当前 revision 页面才能调用。cursor 绑定 server、revision 和 offset，目录变化后旧 cursor 与旧披露状态失效。
- **工具命名**：通用调用在权限判断和 `tool.proposed` 前展开为 `mcp:<serverId>:<toolName>`，并以 MCP 原始 input schema 校验业务参数。
- **权限**：目录工具在 ReadOnly 下可读；MCP 执行在 ReadOnly 下拒绝、Auto 下模型审批并可升级人工审批、Confirm 下人工审批、Yolo 下直接执行。MCP 审批不可记忆、调用不可自动重放。
- **生命周期**：主进程管理 generic MCP 的 handshake、目录边界、超时、取消、draining、有限指数退避重启、stderr tail 和应用退出清理。ProjectModel/Serena/code intelligence 当前整体关闭，生产 runtime 不启动 Serena，Provider request 与模型可见工具提示不得包含 `project_*` 或 `code_*`，普通 Session 不读取、创建或改写 `.zch`。
- **秘密环境变量**：`env` 仅存非敏感值；`envFromHost` 只保存子进程变量名到主机变量名的映射。主机值只在主进程启动子进程时解析，不进入 renderer、public config、trace 或日志。

MCP stderr 先进行跨块 UTF-8 解码，再按完整秘密值流式脱敏；可能组成秘密的尾部在判定前不公开。短秘密与重叠匹配使用相同规则，流结束后才释放未匹配的尾部，公开 tail 始终有界。字符串与 JSON 诊断复用同一字面匹配规则。

意外退出最多自动重启 5 次，退避从 500 ms 指数增长；握手成功不重置预算。一次连接连续 ready 至少 60 秒后退出，或用户手动重启，才重置预算。目录查询与配置重载遵守待执行退避及耗尽状态；disable/dispose 清理重启定时器，旧连接的迟到回调不能改变新连接状态。
