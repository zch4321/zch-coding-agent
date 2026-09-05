# 工具、权限与执行安全

本文规定工具参数、授权、执行与输出契约。代码入口见[工具与权限地图](../code-map/tools-and-permissions.md)；操作上的权限选择见[配置指南](../guides/configuration.md)。

返回[架构总览](../architecture.md) · [文档入口](../README.md)。

### 工具集

工具分为五大类。所有规范化 `ToolCall` 都必须包含独立的 `reason` 意图字段，用于：

1. 人类审批界面的意图展示；
2. 喂给审批模型做判定。

内置工具可在暴露给模型的 schema 中加入保留字段；MCP 等外部工具由 Provider/ToolRegistry 统一包装，规范化后把 `reason` 与业务 `args` 分离，转发外部工具时不得携带该保留字段。Provider parser 与 ToolRegistry/executor 边界都必须删除实际注册的 intent 字段，避免流式解析或序列化异常把 `_agent_intent` 泄漏到 `additionalProperties: false` 的业务 schema。`reason` 是不可信声明，不参与工具自身业务参数校验。

每个工具还必须声明机器可读的能力元数据，而不是只用一个 `readonly` 布尔值：

- `effects`：如 `filesystem.read`、`filesystem.write`、`process.spawn`、`terminal.write`、`network.request`。
- `risk`：`low | review | high` 的默认风险级别。
- `supportsAbort`、`defaultTimeoutMs`、`modelOutputPolicy`。其中 `bounded` 使用统一模型可见字节安全限制，`paged` 由工具维护准确分页和自身行数语义，`passthrough` 只用于自身已有严格源文件上限的结果。

Provider 生成的参数在记录 `tool.proposed` 和进入权限审批前先规范化：递归删除 schema 明确禁止的多余字段，并转换无歧义的 JSON 标量类型（数字字符串转 number/integer、`true|false` 字符串转 boolean、number/boolean 转 string）。不得把字符串猜测为 JSON object/array、把单值包装成数组、把 null 转成可执行值，也不得把未知工具名自动映射到另一个工具。规范化后的参数仍须通过完整 JSON Schema、工具语义校验、路径边界和权限策略；审批卡、日志与实际执行读取同一份规范化参数。无法修复时，模型可见错误必须包含工具名、具体 JSON Pointer 字段和预期约束，并明确允许修正后重试。

Provider-neutral Tool Schema 是本地参数校验的权威来源，协议适配不得改写它。Anthropic wire schema 不发送顶层 `oneOf`、`allOf` 或 `anyOf`：当根 schema 明确为 object，且组合分支涉及的同级字段都已在根 `properties` 声明时，Provider 只从发送副本删除这些顶层关键字，继续保留嵌套组合约束；若组合分支依赖根目录未声明字段、非 object 分支或无法解析的 `$ref`，必须在网络调用和计费前报告包含工具名的本地错误，不得静默丢字段或放宽本地执行校验。其他 Provider 保持各自协议编译行为。

Backend 内部结果使用统一 `ToolResult` 信封，明确 `ok/error/cancelled/timeout/truncated`，供安全检查、trace 和插件使用；模型历史不接收该信封。敏感数据过滤后，Tool Registry 将成功正文投影为 canonical `TextPart | JsonPart`，错误投影为统一短文本。Run 开始时冻结 `maxToolOutputBytes/maxToolOutputLines`，默认 256 KiB/500 行：字节数由统一出口作为最终安全保险，行数配置交给各工具按自身语义消费，不再由统一出口截断所有 Tool Result。`bounded` 结果超过字节上限时只保留 UTF-8 安全的头部，并在限制内附上原始字节/行数和可用的 artifact/continuation 路径；`read_file`、`background_list` 等 `paged` 结果自行保证正文预算与 continuation 元数据完整。自定义 projector 必须同步、确定性、无 I/O，异常时回退默认安全投影。

Terminal、Command、Subagent 与 Swarm 始终尝试留档。Fetch 与 Web Search 始终保存完整的已获取/规范化结果；MCP 模型投影超过 256 KiB 或 500 行时保存完整规范化 JSON；这些工具的内联结果仍受统一字节保险。MCP catalog 继续保留 4 MiB、100 页、1,000 tools 的独立发现边界。`read_skill` 源文件上限为 256 KiB并完整返回；其他不可分页结果超过统一字节上限时只有头部和截断元数据。

#### 文件类

| 工具          | 作用                                             | 副作用 | `reason` |
| ------------- | ------------------------------------------------ | ------ | -------- |
| `read_file`   | 按行范围分页读取文件内容                         | 无     | **是**   |
| `write_file`  | 创建或整体覆盖 UTF-8 文件，可自动创建缺失父目录  | 有     | **是**   |
| `apply_patch` | 对一个已有文件的最新内容应用多 hunk 精确文本补丁 | 有     | **是**   |
| `delete_file` | 幂等删除文件（受控路径，替代裸 `rm`）            | 有     | **是**   |

> 设计意图：把常规删除做成独立工具，便于精确展示路径、数量和审批风险。它不能阻止 `run_command` 间接删除文件，因此命令工具仍必须独立经过权限策略，不能把工具拆分误当成 sandbox。

`read_file` 从文件句柄流式读取，不为分页把整个文件载入内存。它支持 1-based `startLine`、可选的 0-based Unicode code-point `startCharacter`、`tail` 以及 `lineCount/lineNumbers`；`tail` 与显式起点互斥。结果始终返回下一次可用的 `nextStartLine`，只有停在超长单行中间时才返回非零 `nextStartCharacter`，因此普通分页只需复制下一行号；EOF 后同一行继续 append 时也能从字符偏移续读。读取器在 UTF-8 code point 边界安全停下，并继续检测一次调用期间的文件替换；跨调用不再维护文件身份 cursor。workspace 文件仍受 `readFileSourceBytes` 总源文件上限，Session temp 文件不受该总量限制。每页文件正文直接使用冻结的行数配置（默认完整 500 个源文件行）以及为 continuation 元数据预留空间后的字节配置；空行与 footer 不占用源文件行预算。临时 artifact 已清理时返回 `ARTIFACT_EXPIRED`。

三个 mutation 工具采用 best-effort、last-writer-wins 语义。审批固定 tool/call 和完整 args hash（包括 path/content/patch），并在批准前校验当时的路径与 scope；不生成审批 Diff，也不冻结文件 existence/hash/inode/mtime、父目录 identity 或预期结果。执行时再次经过 PathGuard，symlink/junction、目录、越界路径和受保护根继续拒绝。

`write_file` 在目标不存在时创建文件并自动创建缺失父目录，在目标是允许范围内的普通文件时整体覆盖；覆盖保留执行时文件权限，新文件使用进程 umask 下的 workspace 默认权限。`apply_patch` 一次只修改一个已存在的 UTF-8 文本文件，可包含多个 hunk；禁止 create/delete、二进制、rename、mode change 和越界路径。hunk header 的行号只用于错误定位；每个上下文/删除序列必须在执行时最新内容中逐字命中一次。无匹配或多个匹配均零写入并提示 Agent 重读，不做 fuzzy replacement。读取后再发生并发修改时允许最后完成的原子替换获胜。`delete_file` 执行时重新解析目标：普通文件直接删除且不读取内容、不检查旧 hash、不受文本编辑大小上限约束；已不存在或在删除竞态中消失时幂等成功并返回 `deleted: false`。

应用不记录 Run 开始状态或每次 mutation 的 before/after、Diff、patch、mode 与文件恢复元数据。两个写入若都基于同一旧内容并发发布，最后完成者可能覆盖先完成者，即使逻辑编辑互不冲突；需要隔离或恢复时由用户使用 Git 分支/worktree/commit/stash 等原生能力。

#### 检索类

| 工具       | 作用                          | `reason` |
| ---------- | ----------------------------- | -------- |
| `list_dir` | 列目录                        | **是**   |
| `glob`     | 文件名模式匹配（`fast-glob`） | **是**   |
| `grep`     | 内容搜索（底层 `ripgrep`）    | **是**   |

`glob.pattern` 使用 Bash-style glob 并固定相对于可选 `path`，支持 globstar、brace、character class 和 extglob；模型应使用 `/` 分隔符，Backend 会把 Windows `\` 输入规范化为 `/`。Backend 以 `fast-glob` 流式枚举普通文件，禁止绝对/负模式和任何可展开成父目录的 pattern，不跟随 symlink，并在每个结果上重新执行 workspace containment 校验。`maxResults` 只限制匹配结果：读取第 `maxResults + 1` 项后停止并标记截断，不能在匹配前限制扫描文件数。JavaScript `grep` fallback 使用同一枚举器解释 `include`，显式 file `path` 与 ripgrep 一样优先于 include；正常路径使用 `@vscode/ripgrep` 分发的原生 ripgrep，项目代码只负责安全参数、进程生命周期、JSON 解析和有界结果。敏感路径策略独立使用 `picomatch` 匹配配置中的 glob，不复用文件枚举实现。

模型可见的 `grep` 结果使用 `path:line:text`，`glob/list_dir` 每行一个路径且目录追加 `/`；空结果使用 `[no matches]` 或 `[empty directory]`，只有截断时追加短尾注。不得重复回显 pattern/include/path 等调用参数。

> 预留：`CodebaseIndexer` 接口（embedding / 模糊搜索），当前不实现，但工具注册表与 Agent Loop 设计要兼容未来新增只读工具。

#### 命令类

| 工具          | 作用                                                                | 副作用 | `reason` |
| ------------- | ------------------------------------------------------------------- | ------ | -------- |
| `run_command` | 一次性执行进程或 shell 命令，等待结束，返回 stdout/stderr/exit code | 有     | **是**   |
| `delay`       | 等待一个有界毫秒数，供 terminal 轮询输出时使用                      | 无     | **是**   |

> `run_command` 用于短测试、构建、一次性脚本。长时间测试、watch、开发服务器、REPL 或需要反复观察输出的命令应使用 `terminal_open` / `terminal_send`；用 `background_wait` 等待 PTY 退出或一个采样超时，并读取 Terminal 当前最后 50 行；更早的完整输出通过 `read_file` 分页读取 Terminal artifact。
>
> 参数必须区分 `mode: "process"`（`executable + args[]`，默认优先）和 `mode: "shell"`（命令字符串，支持管道/重定向但风险更高）。不能把两者混成一个无法可靠审查的字符串。
>
> `mode: "shell"` 不接受模型指定的 Shell 名称。Main process 从 `executionEnvironment.commandShell` 解析当前可用解释器，并始终以 `shell: false` 显式启动该可执行文件；Windows 自动选择顺序固定为 PowerShell 7、Windows PowerShell、CMD，Git Bash 与 Nushell 可由用户显式选择。保存的解释器不可用时，本次执行回退到自动选择且设置页显示警告，不静默改写配置。Prompt Harness 只报告本轮实际解析出的 `command_shell`，要求模型使用对应语法，不把未安装候选暴露给模型选择。`mode: "process"` 和内部 Git 命令不受该配置影响。
>
> PowerShell adapter 固定使用 `-ExecutionPolicy Bypass` 启动当前进程，使 `.ps1`、`npm.ps1`、`pnpm.ps1` 等脚本可在 Agent 发起的命令中运行。应用不探测或转换 Execution Policy 失败；PowerShell 的原始 stderr 和 exit code 继续进入普通 Tool Result。
>
> 已知 Shell adapter 必须在启动参数或环境中请求 UTF-8 输出；捕获层仍逐流校验 UTF-8，在 Windows 程序忽略该请求并输出当前代码页时使用探测到的主机代码页解码。该策略减少中文乱码，但不能保证任意第三方程序遵守控制台编码约定。
>
> 模型可见结果以 stdout 为正文，非空 stderr 放在 `[stderr]` 后；只有非零 exit、signal 或截断时追加状态尾注。Git 工具沿用同一 stream 形式，空成功结果返回简短完成提示。
>
> **安全边界说明**：当前只能保证命令的初始 `cwd` 位于工作区，不能仅靠字符串检查阻止 shell 命令、脚本或子进程访问工作区外资源。若要提供真正的主机级隔离，必须引入容器/OS sandbox；当前不承诺该能力。因此 `run_command` 与 PTY 在 Auto/Yolo 下都属于用户主动接受的主机执行风险。

#### 终端类（persistent PTY）

长生命周期的双向伪终端，**Agent 与人类共享同一个终端流**——人可以观察、也可以在同一个 PTY 上输入。

| 工具                                | 作用                                                  | 副作用 | `reason` |
| ----------------------------------- | ----------------------------------------------------- | ------ | -------- |
| `terminal_open(cwd, opts)`          | 打开新终端，返回 `terminalId`、后台 target 与日志路径 | 有     | **是**   |
| `terminal_send(id, text, delayMs?)` | 提交终端输入并自动回车，默认等待 1 秒并返回增量/tail  | 有     | **是**   |

约定：

- `terminal_open` 在启动 PTY 前创建 `artifacts/terminals/terminal-<id>.log`，并返回 `{ type: "terminal", id: terminalId }` 数字 target。应用用跨 chunk 保留状态的 ANSI sanitizer 持续写入无 ANSI、追加式完整日志；Renderer 仍接收同一 PTY 的原始带色流。
- 与 `run_command` 并存：一次性命令用前者；长跑服务、交互式 REPL 或实时观察用 Terminal。每次 `terminal_send` 代表提交一段完整输入，未以换行结束时自动补一次 Enter，已有换行时不重复；`delayMs` 默认 1,000 ms、允许显式为 0、最大 60 秒。返回优先包含发送前 cursor 之后的无 ANSI 增量；没有增量时返回最多 20 行/8 KiB 的短 tail，并始终携带当前 cursor 与 artifact 状态。等待期间取消不会撤回已经写入 PTY 的输入。
- `terminal_open` 不接受模型提交的 Shell。Main process 在每次打开时读取 `executionEnvironment.commandShell` 并经 CommandShellService 解析实际 profile（与 `run_command.shell` 同一配置）；保存的解释器不可用时回退到自动选择且不改写配置。解析为 PowerShell 时 PTY 固定传入 `-ExecutionPolicy Bypass`；其他 Shell 不附加启动参数。设置变更只影响之后打开的终端，已在运行的终端不重启。
- `terminalId` 是进程内全局递增的正整数：应用重启后从 1 重新开始；ID 分配后不复用，启动失败可留下编号空洞。每个 Session 最多保留 16 个终端（包括 opening、running 和已退出但未显式关闭的终端），显式关闭后释放名额；并发打开先预留名额，不能越过上限。Provider catalog 不再暴露 `terminal_read/list/close`；模型通过 `background_wait/list/cancel` 管理状态，人类 Terminal UI 继续通过 Renderer IPC 列举、读取和关闭。不存在或不属于当前 Session 的 ID 统一返回 `Terminal not found for this session`。
- 模型不可见 `terminal_resize` 工具：Renderer 面板自动 fit 后仍通过 `terminal:resize` IPC 同步 PTY 尺寸，模型无法手动调整虚拟终端尺寸。
- Terminal 归属于公开 Session 而不是单次 Run：页面切换、live context 卸载、父 Run 完成/中断、retry/edit/rewind 都不自动关闭；归档、永久删除、Project 删除和应用退出必须先取消并等待收敛。

#### 后台任务

`subagent_run` 与 `swarm_run` 是异步启动工具；统一后台工具管理 Agent 与 Terminal：

| 工具                | 作用                                                                  |
| ------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| `background_wait`   | 按 `any                                                               | all` 等待混合 target 的终态，超时返回全部目标当前快照 |
| `background_list`   | 分页列出当前 Session 最新的 Subagent root、Swarm root 与 Terminal     |
| `background_cancel` | 幂等取消当前 Session 拥有的 root、Swarm child 或 Terminal，可等待收敛 |

- target 统一为 `{ type: "subagent" | "swarm" | "terminal", id: number }`。Subagent/Swarm 共享一个当前应用进程内递增且不复用的 Agent 编号空间；Terminal 遵循相同生命周期但使用独立编号空间，`type` 负责消除同号歧义。两类 ID 都在重启后失效并重新分配；SQLite、Renderer Agents API 与 artifact 目录仍可使用 durable execution UUID，但模型工具不接受它作为操作 target。`background_wait` 默认 `any`；纯 Agent 默认/最大 5 分钟，包含 Terminal 时整次最多 60 秒，`timeoutMs = 0` 为即时快照。Agent 进入终态或 PTY 退出/失败会唤醒，普通 activity 和 Terminal 输出不唤醒；超时不是错误。
- Subagent 终态快照可内联受全局限制的最终回答，并返回 `resultPath/activityPath`；运行中只返回状态和 activity path。Swarm 返回状态、child 计数、每个 child 的数字 target 和 `manifestPath`，不内联聚合结果。Terminal 在退出或 timeout 返回时始终附加当前最后 50 行无 ANSI tail、当前 cursor、截断状态和日志路径；普通输出不会提前唤醒。tail 使用固定 50 行语义并继续受 Run 冻结的 `maxToolOutputBytes` 字节保险；更早内容由模型读取完整日志。
- `background_list` 默认混合返回最新 20 个 root/Terminal，支持类型、`active|finished|all`、limit 和绑定查询条件的 opaque cursor；Swarm child 不作为 root 展平，而随 Swarm 快照返回操作 target，manifest 只保存任务、assignment、路径与 durable 状态，不保存模型操作 ID。`background_cancel.waitMs` 默认 0、最大 60 秒；取消 Swarm root 级联未完成 child，取消单 child 后重新汇总 root。
- child catalog 始终移除 `subagent_run`、`swarm_run` 和全部 `background_*`，防止递归编排。

## 权限与安全模型

### 四档权限模式

会话级配置，决定工具调用如何放行：

| 模式                   | 行为                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ReadOnly**           | 只放行无本地副作用的文件/code/VCS/terminal/instruction 读取与有界 delay；filesystem write/delete、VCS write、project metadata write、process spawn、terminal write、network side effect 和 unknown external effect 一律拦截。它不代表“数据不会发送给 LLM” |
| **Auto**（双模型审批） | 先走确定性策略；仍需 review 的副作用工具由审批模型判定：safe→自动执行，dangerous→转人类审批                                                                                                                                                               |
| **Confirm**            | 所有副作用工具一律人类审批                                                                                                                                                                                                                                |
| **Yolo**               | 跳过黑名单、风险策略、审批模型和人工审批，直接执行所有结构合法的工具调用；首次启用必须明确提示其可执行任意主机命令的风险                                                                                                                                  |

### 分层权限管线

权限不是单次模型二分类，而是按固定顺序执行：

1. **参数校验**：工具存在、schema 合法、会话和资源归属正确。
2. **执行不变量**：文件工具的工作区契约、terminalId 归属、IPC 所有权等必须成立；不成立代表调用无效，而不是“危险但可批准”。
3. **权限模式**：Yolo 直接放行；其他模式继续进入确定性风险策略。
4. **确定性策略**：能力元数据、可选敏感数据规则、命令黑名单、用户记忆规则和权限模式共同决定 `allow / deny / review`。确定性策略不能为有副作用的常规命令维护静态放行白名单；这类命令在 Auto 下应交给审批模型按具体参数和风险信号判定。
5. **Auto 审批模型**：只处理 `review` 动作；超时、无效输出或模型异常一律降级到人工审批。
6. **执行前复核**：紧邻执行再次检查批准的 args/path/scope，以及目标当前是否仍位于允许根并满足普通文件/非 symlink 等路径约束；不把内容 hash 或文件 identity 变化重新解释为审批失效。

主模型（如 DeepSeek V4 Pro）提议动作后，可由**辅助模型**（如轻量/小模型，未配置时为当前主模型）辅助判定。Auto 模式下，工作区内 `write_file` / `apply_patch` 若已通过路径、大小元数据和 policy signal 检查，可由确定性策略直接执行，不消耗审批模型 token；批准固定完整参数，并在执行时重新校验路径与 scope，但不冻结文件内容。`delete_file`、VCS 元数据路径、敏感路径、danger signal、Confirm 模式和用户记住的 review 规则仍转人工审批。其他需 review 的副作用工具才进入审批模型。判定输入刻意精简：

```
审批模型输入 = {
  tool:        <工具名>,
  args:        <完整业务参数>,
  reason:      <主模型声明的调用意图>,
  workspacePath: <工作区绝对路径>,
  policySignals: <确定性策略产生的风险信号>
}
// 不含用户消息历史，不含 LLM 推理过程，不含会话上下文
```

判定输出为二分类：

- `safe` → 跳过人类审批，自动执行。
- `dangerous` → 转人类审批。

审批模型只判断动作本身的风险，不判断它是否符合完整用户意图。它不是安全边界：`reason` 来自主模型，可能错误或具有误导性；最终仍受执行不变量和确定性策略限制。
自动审批模型请求默认超时为 `autoApprovalTimeoutMs = 60000`；超时、无效输出或模型异常一律作为危险信号降级到人工审批，不自动放行。

自动审批使用辅助模型的精确 route（`models.auxiliaryModelProvider/auxiliaryModel/auxiliaryModelReasoning`），未配置或解析失败时回退到该 Run 的完整主模型 route；不存在独立的审批配置，也不得从 Provider 隐式继承思考档位。保存任意 Provider 不得隐式改写模型角色；删除被辅助模型引用的 Provider 时，辅助模型跟随当前主模型 route，主模型为空则清空辅助角色。审批 route 解析最终失败时只记录诊断并回退人工审批。

自动审批请求只有规则提示是稳定前缀，工具、参数、路径和 policy signals 都是动态尾部。Provider 的最小可缓存前缀、路由策略和显式 cache-control 各不相同，因此不能承诺审批调用命中缓存，也不得为追求命中率填充无意义 prompt；统计必须如实记录 Provider usage。

### 执行不变量与风险黑名单

- **执行不变量**不是权限规则：例如内置文件写入必须属于 workspace 或当前 Session `scratch`、Terminal/background target 必须属于当前 Session、参数必须满足 schema。违反时调用本身无效，因此所有模式都拒绝；Yolo 不会改写文件工具契约。
- **风险黑名单**是权限策略：例如破坏性命令、批量删除、发布/部署、修改凭据等。在 Auto/Confirm 下用于强制或提升人工审批；在 Yolo 下明确跳过。
- **工作区文件写入**：`write_file` 与 `apply_patch` 在资源计划确认路径位于 workspace、大小元数据有界且没有 danger 信号时，Auto 可由确定性策略直接放行；`delete_file`、敏感路径、VCS 元数据路径和用户记住的 review 规则仍需人工审批。批准固定完整参数，但不冻结目标文件内容，也不生成 Diff 预览。
- **Session scratch 写入**：`write_file/apply_patch/delete_file` 对当前 Session `scratch` 的操作在 Auto、Confirm 与 Yolo 中免审批；Readonly 仍不暴露写工具，`artifacts` 永远拒绝内置写工具。应用对 workspace 和 scratch mutation 都不创建自有 Diff、FileChange 或分支回滚记录。
- **常规开发命令**不是确定性放行规则：例如 `go mod tidy`、`npm install`、`pip install -r requirements.txt` 有副作用但通常可由 Auto 审批模型判为 safe；是否放行取决于当次参数、cwd、路径、网络/脚本行为和风险信号。

命令匹配只能作为风险信号，不能宣称能完整解析 PowerShell/cmd/bash 的所有转义、别名、脚本和子进程行为。

### 路径安全

root-aware `PathGuard` 把相对路径固定解析到 workspace；绝对路径只允许位于 workspace 或当前 Session temp。`read_file/list_dir/glob/grep` 还可接收精确的 `ZCH_SESSION_*_DIR:/...` alias，并在安全检查前解析到当前 Session 根；内置写工具只允许 workspace 或 `scratch`。执行前和打开后都需验证规范化/真实路径，阻止 `../`、绝对路径越界、符号链接、junction 与 TOCTOU 绕过；新建文件需验证最近已存在父目录并使用避免跟随符号链接的打开策略。

`run_command.cwd` 与 `terminal_open.cwd` 可位于 workspace 或 Session temp。命令类和终端类只能约束初始 `cwd`；Shell 本身仍是宿主权限进程，没有 OS sandbox 时不能承诺其无法访问或修改其他路径，包括 application-owned artifacts。

### 凭据存储

LLM API Key 等敏感配置优先使用 Electron `safeStorage` 异步 API 存储，不落明文。启动时必须检查加密能力；Linux 落到弱后端时要明确告警，不能把 `safeStorage` 描述为跨平台等强度的系统密钥库。

开发和显式真实端点测试可使用 `DEEPSEEK_API_KEY` 作为未配置持久化密钥时的主进程回退。持久化密钥优先；环境变量值不得进入 renderer、日志或工具/Terminal 子进程，只允许公开 `safe-storage | environment | none` 来源状态。

### 数据外发与可选敏感数据检查

- 工作区代码、工具结果和用户消息可能发送给所配置的 LLM Provider，首次使用必须明确告知。
- 敏感数据检查是**可配置策略**，默认关闭，可设为 `off | warn | confirm`。启用后仅检查即将发送给 LLM 的文件路径和工具输出，不扫描或修改整个工作区。
- 检查信号包括用户配置的路径 glob、常见凭据文件名，以及 PEM、常见 token 前缀、高熵字符串等内容模式。该能力只能降低误发概率，不能保证零漏报或零误报。
- Yolo 跳过 `warn/confirm` 阻断；内部 Provider API Key 不进入消息、工具参数和日志。
- Markdown/HTML 渲染必须禁用原始 HTML 或进行严格 sanitize，避免模型输出造成 renderer XSS。

### Electron IPC 安全

- preload 不得直接暴露通用 `ipcRenderer.send/invoke/on`；按业务动作逐个暴露窄 API。
- 主进程校验每个 IPC 的 sender、payload schema、session/resource 归属。
- renderer 启用 `contextIsolation`、sandbox、CSP，并限制导航、新窗口和外链打开。

## IPC、安全与宿主边界

Preload 只暴露冻结 typed API，不暴露 `ipcRenderer`。Command/query/result/event 按 `shared/` schema 校验。

本项目不防御已经完全控制本机的恶意软件，因此不引入数据库加密、多用户 ACL、本地记录签名或同一 OS 用户隔离。

继续保留：

- renderer sandbox 和 contextIsolation。
- sender/frame/origin 与 payload/result schema 校验。
- secrets 不进入 renderer。
- workspace path 和 resource ownership 校验。
- workspace + 当前 Session temp 的 root-aware path guard；application-owned artifacts 与 writable scratch 分离。
- 子进程环境 allowlist。
- tool approval、abort 和 bounded output。

这些同时是业务正确性和模型误操作的边界。
