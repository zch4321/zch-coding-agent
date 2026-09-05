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

### `run_command` 与 Terminal 的解释器边界

`run_command.process` 始终把 `executable + args[]` 交给 `spawn(..., { shell: false })`。`run_command.shell` 也不使用 Node 的隐式 Shell：Main process 根据当前 AppConfig v25 的 `executionEnvironment.commandShell` 解析受支持 profile，再由 profile adapter 生成明确的 executable、固定启动参数和命令字符串参数，最终仍以 `shell: false` 启动。权限预览和 canonical ToolCall 保留模型提交的原始命令，不暴露 adapter wrapper。

Windows 发现只扫描 PATH 与有限的系统/安装目录，内置 profile 为 PowerShell 7、Windows PowerShell、CMD、Git Bash 和 Nushell；`auto` 固定选择 PowerShell 7 → Windows PowerShell → CMD。Git Bash 与 Nushell 只在用户显式选择时使用；System32 的旧 `bash.exe` 不会被误识别为 Git Bash。已保存 profile 消失时，解析结果临时回退到 `auto`，通过只读 `command-shell:list` IPC 把实际路径和 fallback 状态提供给设置页，但不改写保存值。WSL 与任意自定义 executable/args 仍属于 M5 后续范围。

Prompt Harness 在每个外部 Run 开始时读取同一配置并只注入实际解析后的 `command_shell: label (id)`；同一 Run 的后续 Provider 调用不重复刷新。runtime 语义指纹包含 Shell、权限、Provider、工具集合和 module markers 等稳定字段，但排除精确时间、Git 摘要与项目树；只有稳定指纹变化时才采集并追加包含最新 Git/项目树的完整快照。AGENTS 也只在外部 Run 边界检查，因此 Run 中途的规则变更从下一 Run 生效；会话创建、权限更新与 compact 新 epoch 仍按各自边界重建 Harness。`run_command` schema 不接受 shell ID，因此模型不能自行选择未安装解释器。工具执行前会再次解析 Shell，以应对调用期间安装状态变化。内部 Git、Subagent 和其他直接进程不读取该选项。

PowerShell adapter 固定传入 `-ExecutionPolicy Bypass`，并设置 Console 与 pipeline 输出编码；CMD adapter 先切到 code page 65001，Bash/Nushell adapter 设置 UTF-8 locale。应用不预检 Execution Policy，也不把相关失败改写为专用错误；原始 stderr 和 exit code 沿普通 Tool Result 返回。`BoundedProcessOutput` 对 stdout/stderr 独立流式校验 UTF-8；若实际字节无效，则使用启动时探测到的 Windows 当前代码页解码保留区。字节上限、head/tail 截断、discard hash、超时、取消、进程树终止和子进程环境 allowlist 均保持原有边界。`run_command` 是一次性 Tool，不把实时输出投影进 Renderer Terminal。

交互 Terminal 与 `run_command.shell` 共享同一个 `executionEnvironment.commandShell` 配置。`terminal_open` 没有模型可见的 `shell` 参数；TerminalPool 在每次打开时读取当前配置并经 `CommandShellService.resolve()` 解析实际 profile，配置项失效时沿用自动回退且不改写保存值。解析出的 profile `kind = powershell` 时 PTY 固定传入 `-ExecutionPolicy Bypass`，其他 kind 不附加启动参数。设置变更只影响之后打开的 Terminal，已在运行的 Terminal 不重启。

模型可见的 `terminalId` 是进程内全局递增的正整数：应用重启后从 `1` 重新开始，ID 一经分配在当前进程内不复用，启动失败允许留下编号空洞。每个 Session 最多保留 16 个 Terminal（含 opening、running、closing 和已退出但未显式关闭的条目），显式关闭在真实退出及日志收尾后释放名额；打开前同步预留名额，Tool 与 Renderer 并发打开不会越过上限。不存在或不属于当前 Session 的 ID 统一返回 `Terminal not found for this session`。Provider catalog 只保留 `terminal_open/send`，移除 `terminal_read/list/close`；Renderer 的 list/read/close/resize IPC 和多 tab UI 不变。模型把 `terminal_open` 返回的数字 ID 用于 `terminal_send`，并把同一数字 `{ type: 'terminal', id: terminalId }` target 用于 `background_wait/list/cancel`。

TerminalPool 在 spawn PTY 前打开权限为 `0600` 的 `artifacts/terminals/terminal-<id>.log`。raw chunk 一路进入 Renderer/xterm 和原始 scrollback；另一条路经过持久、跨 chunk 的 ANSI sanitizer 进入 model scrollback 与追加式日志，因此 OSC/CSI 分段不会按无状态正则误投影。capture 初始化/追加/close 任一步失败都会更新 backend-owned `artifactAvailable/captureError`。`terminal_send.delayMs` 缺省为 1,000 ms，可显式为 0，最大 60 秒；结果优先返回发送前 cursor 后的增量，否则返回 20 行/8 KiB tail，并始终携带 cursor 和 artifact 状态。

### Terminal 关闭与日志预览

显式关闭只先进入 `closing`，继续捕获最后的输出；实际 PTY exit 和日志追加、关闭完成后才进入 `closed`，移动到有界关闭缓存并释放显式关闭条目的名额。自退出、尚未被用户关闭的底部终端条目保留既有回看行为。关闭失败保留资源与活动状态并允许重试，wait 和会话清理不能将 kill 请求当成真实退出。

Background 按公开 owner 列出当前进程的全部终端，包括 hidden child 与手动终端；底部交互接口仍按实际 Session 校验。右侧日志读取只接收 parent Session、backend 实例和 Terminal ID，由主进程查登记路径并通过 temp PathGuard 校验普通文件；不接受任意路径。文件尾部按 32 KiB 分块，最多扫描 256 KiB，返回最近 200 行且最多 64 KiB，处理 UTF-8 边界。日志可修改、缺失或捕获失败，不能作为任务状态依据。

### Session 临时工作区与 artifact

Desktop temp 根为 `<os.tmp>/zch-coding-agent/<profile-hash>/<session-hash>/`。`SessionTempService` 只接受单个安全 path segment，创建目录 `0700`、文件 `0600`，以同目录临时文件 + rename 原子写 JSON/text；启动时只清理 `mtime` 超过 24 小时的真实目录，不跟随 symlink。正常退出和归档保留，永久删除 Session 或 Project 后立即删除精确 Session 根；没有磁盘配额。Headless 把对应根放在调用者显式 artifacts 目录下并不运行 Desktop retention。

```text
<session-temp>/
├── artifacts/
│   ├── terminals/terminal-<id>.log
│   ├── commands/<run+call-key>/{stdout.log,stderr.log,result.json}
│   ├── subagents/<execution-id>/{result.md,activity.jsonl}
│   ├── swarms/<execution-id>/manifest.json
│   ├── fetch/<run+call-key>/result.json
│   ├── web-search/<run+call-key>.json
│   └── mcp/<run+call-key>.json
└── scratch/
```

Harness 注入真实 root/artifacts/scratch 绝对路径，并给 `run_command` 与 Terminal 环境增加 `ZCH_SESSION_TEMP_DIR/ZCH_SESSION_ARTIFACTS_DIR/ZCH_SESSION_SCRATCH_DIR`，但不覆盖宿主 `TMP/TEMP`。模型投影在已知 `artifactPath/manifestPath/activityPath/resultPath` 字段中使用 `ZCH_SESSION_*_DIR:/...` 跨 Shell 短路径；read/list/glob/grep 在进入 PathGuard 前把该 alias 还原到当前 Session 根，Shell 仍使用自身的环境变量语法。这些动态值不进入 runtime semantic hash，也不生成实时 temp tree。主 Agent 与所有 hidden child 使用公开 owner Session 的同一目录。

`PathGuard` 支持 workspace/session-temp 两个 canonical root：相对路径始终从 workspace 解析，绝对路径必须落入其中之一；只读文件工具还可把精确的 `ZCH_SESSION_*_DIR:/...` alias 展开为当前 Session 绝对路径。打开前后仍检查 lexical/real containment、symlink/junction 与文件身份，alias 中的 `..` 不能越界。read/list/glob/grep 可访问两根；write/apply/delete 只允许 workspace 或 `scratch`，明确拒绝 `artifacts`。scratch mutation 在 Auto/Confirm/Yolo 免审批、Readonly 无写 catalog；它与 workspace mutation 一样不创建应用自有 Diff、文件 journal 或 rewind 记录。Command/Terminal `cwd` 可位于两根，但 spawn 的 Shell 是宿主权限进程而非 OS sandbox，可能访问或改写其他路径。

Command/Terminal/Subagent/Swarm 始终尝试完整留档；Fetch/Web Search 保存已获取/规范化结果，MCP 只在模型投影超过 256 KiB 或 500 行时保存规范化 JSON。Backend state 始终权威，文件只作可分页副本；捕获失败返回 `artifactAvailable = false/captureError`，旧路径不存在时 `read_file` 返回 `ARTIFACT_EXPIRED`。

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
