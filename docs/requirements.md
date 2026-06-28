# 需求文档 · Zch Coding Agent

> 状态：MVP 实现同步版 v0.3 · 最后更新 2026-06-20
> 本文档定义「做什么」。技术怎么做见 [`architecture.md`](./architecture.md)，前端信息架构与验收标准见 [`frontend-spec.md`](./frontend-spec.md)。

---

## 1. 项目概述

### 1.1 是什么
一个基于 **Electron + Vite + Vue 3** 的桌面端 AI 编程助手（Coding Agent）。它能在用户指定的工作区内自主读写文件、执行命令、操作终端，完成真实的软件工程任务。

### 1.2 核心价值
- **有手有眼**：不只是聊天，而是能真正操作文件系统与终端的 Agent。
- **可控可审**：四档权限模型 + 双模型自动审批，在自动化与安全之间可调。
- **可观测**：显式开启调试日志后，完整记录每一次 LLM 调用、流式响应、审批和工具执行，可离线回放并分析上下文与 KV cache 命中效果。
- **可扩展**：插件化生命周期钩子，为未来 MCP / 自定义工具 / RAG 留口子。

### 1.3 非目标（明确不做）
- 不是云端 SaaS，是本地桌面应用。
- 不做代码库全量 embedding 检索（RAG）——MVP 用 `rg`/`list`，但**预留接口**。
- 不做多用户/团队协作。
- MVP 不做插件加载器，只埋事件总线与钩子点。

---

## 2. 核心能力需求

### 2.1 Agent 循环
Agent 基于原生 **Tool Use（Function Calling）** 运行一个循环：

```
用户消息 → LLM 推理（产出文本 + 工具调用）
        → 工具调用经权限管线
        → 执行工具，拿结果
        → 结果回传 LLM，继续推理
        → 直到 LLM 不再调用工具，产出最终回复
```

需求点：
- **可中断**：用户随时可中止当前 Agent 任务。
- **可审批**：每个可能产生副作用的工具调用前，必须经过权限管线（§3）。
- **状态明确**：同一会话同一时间只允许一个活动 run；运行中收到新消息时由 UI 明确选择排队或拒绝，MVP 默认拒绝。
- **协议完整**：LLM 一次返回多个工具调用时，每个调用都必须回填一个结果；拒绝、取消、超时也以结构化工具结果回填，不能静默丢失。
- **有界运行**：配置最大循环轮数、单次和单个 run 的工具输出预算、累计上下文预算；`maxStepsPerRun` 默认值为 200，可在 Limits 设置中调整；上下文达到当前模型 prompt budget 的 `autoCompactTriggerPercent`（默认 80%）时，在安全边界自动压缩旧历史；字节、行数/结果数与估算 token 任一上限先到即截断，并向用户和模型返回续读信息。
- **可回放**：调试日志开启时，循环的请求、响应、流式事件和工具结果必须完整保存，可确定性离线回放原会话；重新请求模型属于单独的“重放请求”，不保证复现随机输出（§5）。
- **提示词可配置**：基础 system prompt 由主进程配置持有，内置 `zh-CN` / `en-US` 两套默认值并允许用户编辑；界面语言变化后，已有会话从下一轮 Provider 调用开始使用对应语言版本。Skill 摘要追加在基础提示词之后。
- **计划审阅门**：模型可用 `plan_set` 创建或替换 Plan，默认进入 `awaiting_review` 并停止执行；用户明确批准或拒绝后，下一轮模型通过 `plan_status({status:"active" | "rejected"})` 记录审阅结果。向模型暴露 `plan_status` 是设计意图，用于把自然语言批准/拒绝转成可审计状态，不绕过权限管线或工具审批。

### 2.2 工具集

工具分为四大类。所有规范化 `ToolCall` 都必须包含独立的 `reason` 意图字段，用于：
1. 人类审批界面的意图展示；
2. 喂给审批模型做判定。

内置工具可在暴露给模型的 schema 中加入保留字段；MCP 等外部工具由 Provider/ToolRegistry 统一包装，规范化后把 `reason` 与业务 `args` 分离，转发外部工具时不得携带该保留字段。`reason` 是不可信声明，不参与工具自身业务参数校验。

每个工具还必须声明机器可读的能力元数据，而不是只用一个 `readonly` 布尔值：
- `effects`：如 `filesystem.read`、`filesystem.write`、`process.spawn`、`terminal.write`、`network.request`。
- `risk`：`low | review | high` 的默认风险级别。
- `supportsAbort`、`defaultTimeoutMs`、`maxOutputBytes`。

所有参数先经 JSON Schema 校验；所有结果使用统一结果信封，明确 `ok/error/cancelled/timeout/truncated`，避免把无限 stdout、二进制或异常对象直接塞进上下文。

#### 2.2.1 文件类
| 工具 | 作用 | 副作用 | `reason` |
|---|---|---|---|
| `read_file` | 按行范围分页读取文件内容 | 无 | **是** |
| `create_file` | 新建不存在的 UTF-8 文件，可自动创建缺失父目录 | 有 | **是** |
| `apply_patch` | 对一个已有文件应用多 hunk 文本补丁 | 有 | **是** |
| `delete_file` | 删除文件（受控路径，替代裸 `rm`） | 有 | **是** |

> 设计意图：把常规删除做成独立工具，便于精确展示路径、数量和审批风险。它不能阻止 `run_command` 间接删除文件，因此命令工具仍必须独立经过权限策略，不能把工具拆分误当成 sandbox。

`read_file` 使用 `startLine + lineCount` 分页，返回实际行范围、总行数、`truncated` 和 `nextStartLine`。默认读取 400 行，单次最多 1000 行，并同时受 64 KiB 与 8K 估算 token 限制；超长单行不能绕过字节/token 上限。

`apply_patch` 第一版一次只修改一个已存在的 UTF-8 文本文件，可包含多个 hunk。补丁路径必须是 workspace 相对路径；禁止二进制、rename、mode change、绝对路径和越界路径。为适配模型常见的计数错误，hunk header 的行数和 new-file 行号只作为提示；上下文/删除行仍必须精确匹配，old line number 失效时只有在精确上下文唯一命中时才可应用。审批绑定原文件 hash、规范化补丁 hash 与结果 hash，执行前重新验证。`create_file` 只创建不存在的文件，并会自动创建缺失父目录；覆盖已有文件应使用 `apply_patch`。

#### 2.2.2 检索类
| 工具 | 作用 | `reason` |
|---|---|---|
| `list_dir` | 列目录 | **是** |
| `glob` | 文件名模式匹配 | **是** |
| `grep` | 内容搜索（底层 `ripgrep`） | **是** |

> 预留：`CodebaseIndexer` 接口（embedding / 模糊搜索），MVP 不实现，但工具注册表与 Agent Loop 设计要兼容未来新增只读工具。

#### 2.2.3 命令类
| 工具 | 作用 | 副作用 | `reason` |
|---|---|---|---|
| `run_command` | 一次性执行进程或 shell 命令，等待结束，返回 stdout/stderr/exit code | 有 | **是** |
| `delay` | 等待一个有界毫秒数，供 terminal 轮询输出时使用 | 无 | **是** |

> `run_command` 用于短测试、构建、一次性脚本。长时间测试、watch、开发服务器、REPL 或需要反复观察输出的命令应使用 `terminal_open` / `terminal_send`，再配合 `delay` 和 `terminal_read` 轮询。
>
> 参数必须区分 `mode: "process"`（`executable + args[]`，默认优先）和 `mode: "shell"`（命令字符串，支持管道/重定向但风险更高）。不能把两者混成一个无法可靠审查的字符串。
>
> **安全边界说明**：MVP 只能保证命令的初始 `cwd` 位于工作区，不能仅靠字符串检查阻止 shell 命令、脚本或子进程访问工作区外资源。若要提供真正的主机级隔离，必须引入容器/OS sandbox；MVP 不承诺该能力。因此 `run_command` 与 PTY 在 Auto/Yolo 下都属于用户主动接受的主机执行风险。

#### 2.2.4 终端类（persistent PTY）
长生命周期的双向伪终端，**Agent 与人类共享同一个终端流**——人可以观察、也可以在同一个 PTY 上输入。

| 工具 | 作用 | 副作用 | `reason` |
|---|---|---|---|
| `terminal_open(cwd, opts)` | 打开新终端，返回 `terminalId` | 有 | **是** |
| `terminal_send(id, text)` | 向终端写入 | 有 | **是** |
| `terminal_read(id, {cursor?, lines?})` | 读最近 N 行或指定 cursor 后的输出 | 无 | **是** |
| `terminal_list()` | 列出所有打开的终端句柄 | 无 | **是** |
| `terminal_close(id)` | 关闭终端 | 有 | **是** |
| `terminal_resize(id, cols, rows)` | 调整终端尺寸 | 无 | **是** |

约定：
- `terminal_read` 返回给 **LLM** 的内容是**去 ANSI 的纯文本**（便于模型理解）。
- **UI** 上人类看到的终端流是**原始带色流**。两者订阅同一 PTY，渲染层不同。
- 与 `run_command` 并存：一次性命令用前者；长跑服务/交互式 REPL/实时观察用 terminal，并使用 `delay` 等待后读取增量输出。
- 终端归属于会话而不是单次 run：中断 run 不自动关闭终端；会话关闭或应用退出时必须清理。

### 2.3 LLM Provider 适配

#### 2.3.1 多 Provider 支持
必须支持接入多家模型供应商，每家单独写 Provider。能用 OpenAI 兼容协议的（DeepSeek、智谱 GLM、Moonshot、本地 Ollama 等）基于 openai SDK 实现；Anthropic 等自有协议的用其官方 SDK 实现。

**MVP 只实现 DeepSeek Provider**，其他留接口与 TODO。

Provider 可实现模型目录查询。DeepSeek 使用鉴权后的 `GET /models` 获取当前凭据可用的模型 ID；该端点只作为可用性目录，不能假设会返回上下文长度、最大输出或工具能力。设置页合并 Provider 返回、应用内置模型资料和用户自定义模型，并始终允许手工输入。

模型能力采用 `用户覆盖 > 内置资料 > 保守默认值`。未知模型默认按 64K 上下文管理并明确标记“能力未知”；不得抓取 Provider 文档 HTML 推断运行时能力。模型目录请求失败时保留上次成功缓存和当前手工配置。

token 预算通过可替换估算器计算。支持 Provider tokenizer、保守估算和用户自定义 `bytesPerToken`；自定义值按 Provider/模型保存。估算只负责上下文规划，所有工具仍必须执行不可关闭的字节、行数/结果数硬上限。Provider 返回的真实 usage 用于记录与校准，不作为事前边界保证。

#### 2.3.2 Reasoning（推理过程）适配
不同供应商的「思考过程」格式各异，是适配中最难、最 provider-specific 的部分：

| Provider | reasoning 形态 | 明文/加密 | 回传要求 |
|---|---|---|---|
| **DeepSeek** | `reasoning_content` 字段 | 明文 | 无工具调用时可省略；发生工具调用后必须按协议回传 |
| **智谱 GLM** | Provider-specific reasoning 字段 | 依模型协议 | 独立适配并用契约测试确认，不能仅因字段同名复用 DeepSeek 假设 |
| **Anthropic** | 有序 `thinking` / `redacted_thinking` block + `signature` | 明文摘要 + 不透明签名/密文 | 工具链路中必须保留完整 block、顺序与不透明字段，不得筛掉 redacted block |
| **OpenAI** | Responses API reasoning output items | 摘要 + 不透明状态 | 用 `previous_response_id` 或完整回传相关 output items；适配器决定策略 |

需求：抽象统一的**供应商延续状态（Provider Continuation State）**。它必须能保留一次 assistant turn 中有序的 provider-native items，而不只是单个 reasoning 字符串。Agent Loop 只保存和搬运该状态，不解析、不重建内部字段。详见架构文档。

### 2.4 会话与工作区
- 一个工作区（workspace）= 一个本地目录。
- 会话（session）绑定一个工作区与一个权限模式。
- 文件工具必须约束在工作区边界内（规范化路径、真实路径与符号链接逃逸检测）。
- MVP 会话状态保存在内存；应用崩溃或重启后不承诺恢复未完成 run。JSONL trace 是审计记录，不是事务恢复日志。

### 2.5 Skills（渐进式专家指令）

#### 2.5.1 是什么
Skills 是高度浓缩的「专家指令」——一段描述某领域最佳实践的 markdown（SKILL.md）。采用**渐进式上下文**加载：

- **摘要阶段**：启动时扫描 skills 目录，把每个 skill 的 frontmatter（name + description + trigger）提取出来，**全部摘要拼成一段注入 system prompt**（便宜，常驻上下文）。
- **正文阶段**：Agent 判断某个 skill 相关时，调用 `read_skill(name)` 工具加载完整正文，按其指令执行（按需，省 token）。

#### 2.5.2 SKILL.md 规范
```markdown
---
name: pdf
description: 专业 PDF 工具集，覆盖报告/海报/论文/提取/合并等
trigger: 用户提到 PDF 处理、生成、转换时
---
（正文：详细执行指令、步骤、注意事项。仅 read_skill 时加载）
```
- 摘要 = frontmatter；正文 = 文件剩余部分。
- 缺失/格式错误的 frontmatter 的 skill：跳过并记日志，不中断启动。

#### 2.5.3 Skills 来源（用户管理目录）
Skills 存于**用户数据目录** `userData/skills/*.md`（不在 app 安装目录，便于升级与用户自管理）。三种安装入口：
1. **直接放文件**：用户手动往目录拷 `.md`。
2. **链接下载**：应用内输入 URL，下载 `.md` 存入目录。
3. **上传安装**：应用内文件选择器，选本地 `.md` 拷入目录。

> 三种入口都写入同一个用户目录；启动时统一扫描。应用本身**不内置** skill 文件。

安全要求：
- Skill 是会影响 Agent 行为的**不可信指令**，安装后必须记录来源、内容哈希和启用状态；下载或上传不等于自动信任。
- URL 安装仅允许 HTTPS，限制重定向次数、文件大小和下载超时，并阻止访问环回、链路本地和内网地址，避免 SSRF。
- Skill 名称只能作为已扫描索引的 key，不能直接拼接成文件路径。

#### 2.5.4 工具
| 工具 | 作用 | 副作用 | `reason` |
|---|---|---|---|
| `read_skill(name)` | 读取指定 skill 的完整正文 | 无 | **是** |

### 2.6 MCP（Model Context Protocol）客户端

#### 2.6.1 是什么
实现 **MCP 客户端**（不是 server），用于连接外部 MCP server，复用第三方工具生态（如 GitHub、数据库、文件系统等 MCP server 提供的工具）。

#### 2.6.2 传输
- **stdio**：spawn 本地 MCP server 子进程（首要）。
- **Streamable HTTP**：连接远程 MCP server（预留，MVP 之后）；旧 HTTP+SSE 仅作为兼容模式。

#### 2.6.3 能力范围（MVP 之后）
> MVP **不实现通用 MCP 工具桥**，只预留接口与配置。Serena 作为专用 code-intelligence 后端接入时，不直接暴露原始 MCP 工具给模型。下面是完整通用 MCP 形态设计：

- **配置**：用户在配置中声明 MCP server 列表（命令 + 参数）。启用 server 时完成 MCP 协议握手（initialize → initialized → tools/list），把 server 暴露的工具注册进统一 `ToolRegistry`。
- **工具命名**：MCP 工具有稳定内部 canonical id；发给不同模型前映射为符合其函数命名限制的安全别名，再可逆映射回 server/tool。
- **权限**：**MCP 工具同样过权限管线**（硬约束、确定性策略、权限模式、审批）。权限管线按工具来源识别，对未知工具默认按「有副作用」处理（走审批）。
- **生命周期**：管理 MCP server 子进程的按需启动、健康检查、退避重启和退出清理；本地 server 命令本身需要用户显式信任。

---

## 3. 权限与安全模型

### 3.1 四档权限模式
会话级配置，决定工具调用如何放行：

| 模式 | 行为 |
|---|---|
| **ReadOnly** | 只放行无本地副作用的工具（read/list/glob/grep/read_skill/terminal_read/terminal_list/delay），其余一律拦截；它不代表“数据不会发送给 LLM” |
| **Auto**（双模型审批） | 先走确定性策略；仍需 review 的副作用工具由审批模型判定：safe→自动执行，dangerous→转人类审批 |
| **Confirm** | 所有副作用工具一律人类审批 |
| **Yolo** | 跳过黑名单、风险策略、审批模型和人工审批，直接执行所有结构合法的工具调用；首次启用必须明确提示其可执行任意主机命令的风险 |

### 3.2 分层权限管线
权限不是单次模型二分类，而是按固定顺序执行：
1. **参数校验**：工具存在、schema 合法、会话和资源归属正确。
2. **执行不变量**：文件工具的工作区契约、terminalId 归属、IPC 所有权等必须成立；不成立代表调用无效，而不是“危险但可批准”。
3. **权限模式**：Yolo 直接放行；其他模式继续进入确定性风险策略。
4. **确定性策略**：能力元数据、可选敏感数据规则、命令黑名单、用户记忆规则和权限模式共同决定 `allow / deny / review`。确定性策略不能为有副作用的常规命令维护静态放行白名单；这类命令在 Auto 下应交给审批模型按具体参数和风险信号判定。
5. **Auto 审批模型**：只处理 `review` 动作；超时、无效输出或模型异常一律降级到人工审批。
6. **执行前复核**：紧邻执行再次检查路径和资源状态，降低 TOCTOU 风险。

主模型（如 DeepSeek V4 Pro）提议动作后，可由**独立的审批模型**（如轻量/小模型）辅助判定。Auto 模式下，工作区内 `create_file` / `apply_patch` 若已通过资源计划、workspace 边界、diff 上限、precondition 和 policy signal 检查，可由确定性策略直接执行，不消耗审批模型 token；`delete_file`、VCS 元数据路径、敏感路径、danger signal、Confirm 模式和用户记住的 review 规则仍转人工审批。其他需 review 的副作用工具才进入审批模型。判定输入刻意精简：

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

### 3.3 执行不变量与风险黑名单
- **执行不变量**不是权限规则：例如 `create_file` 的路径必须属于 workspace、terminal 必须属于当前 session、参数必须满足 schema。违反时调用本身无效，因此所有模式都拒绝；若用户需要访问 workspace 外文件，应切换 workspace 或使用命令工具，而不是让 Yolo 改写文件工具契约。
- **风险黑名单**是权限策略：例如破坏性命令、批量删除、发布/部署、修改凭据等。在 Auto/Confirm 下用于强制或提升人工审批；在 Yolo 下明确跳过。
- **工作区文件写入**：`create_file` 与 `apply_patch` 在资源计划确认路径位于 workspace、diff 有界且没有 danger 信号时，Auto 可由确定性策略直接放行；`delete_file`、敏感路径、VCS 元数据路径和用户记住的 review 规则仍需人工审批。
- **常规开发命令**不是确定性放行规则：例如 `go mod tidy`、`npm install`、`pip install -r requirements.txt` 有副作用但通常可由 Auto 审批模型判为 safe；是否放行取决于当次参数、cwd、路径、网络/脚本行为和风险信号。

命令匹配只能作为风险信号，不能宣称能完整解析 PowerShell/cmd/bash 的所有转义、别名、脚本和子进程行为。

### 3.4 路径安全
文件工具在执行前和打开文件后都需验证规范化路径/真实路径，阻止 `../`、绝对路径越界、符号链接和 junction 绕过。新建文件需验证最近已存在父目录的真实路径，并使用避免跟随符号链接的打开策略。

命令类和终端类只能约束初始 `cwd`；没有 OS sandbox 时不能承诺进程无法访问工作区外路径。

### 3.5 凭据存储
LLM API Key 等敏感配置优先使用 Electron `safeStorage` 异步 API 存储，不落明文。启动时必须检查加密能力；Linux 落到弱后端时要明确告警，不能把 `safeStorage` 描述为跨平台等强度的系统密钥库。

开发和显式真实端点测试可使用 `DEEPSEEK_API_KEY` 作为未配置持久化密钥时的主进程回退。持久化密钥优先；环境变量值不得进入 renderer、日志或工具/Terminal 子进程，只允许公开 `safe-storage | environment | none` 来源状态。

### 3.6 数据外发与可选敏感数据检查
- 工作区代码、工具结果和用户消息可能发送给所配置的 LLM Provider，首次使用必须明确告知。
- 敏感数据检查是**可配置策略**，默认关闭，可设为 `off | warn | confirm`。启用后仅检查即将发送给 LLM 的文件路径和工具输出，不扫描或修改整个工作区。
- 检查信号包括用户配置的路径 glob、常见凭据文件名，以及 PEM、常见 token 前缀、高熵字符串等内容模式。该能力只能降低误发概率，不能保证零漏报或零误报。
- Yolo 跳过 `warn/confirm` 阻断；内部 Provider API Key 不进入消息、工具参数和日志。
- Markdown/HTML 渲染必须禁用原始 HTML 或进行严格 sanitize，避免模型输出造成 renderer XSS。

### 3.7 Electron IPC 安全
- preload 不得直接暴露通用 `ipcRenderer.send/invoke/on`；按业务动作逐个暴露窄 API。
- 主进程校验每个 IPC 的 sender、payload schema、session/resource 归属。
- renderer 启用 `contextIsolation`、sandbox、CSP，并限制导航、新窗口和外链打开。

---

## 4. 用户体验需求

> UI 组件库采用 **Naive UI**（极简风格、按需引入、TS 友好），整体视觉偏极简。

### 4.1 对话界面（Chat UI）
- 流式渲染 LLM 回复（逐 token）。
- Markdown 渲染 + 代码高亮（Shiki）。
- 工具调用过程可视化：显示工具名、参数、`reason`、审批状态、执行结果。
- 推理过程（reasoning）可折叠展示。
- 展示 run 状态：运行中、等待审批、取消中、失败、完成；等待审批期间禁止重复提交同一决定。

#### 4.1.1 项目与对话导航
- UI 中一个项目对应一个 workspace，不重复展示两个概念。
- 左侧项目侧栏提供新对话、对话搜索，以及项目下的二级对话列表；不引入 Task 概念。
- 对话保存本地标题、消息历史、所属项目、创建/更新时间和最近使用的模型/权限模式。
- 搜索只在本地检索对话标题、用户消息和 Agent 文本，不检索工作区文件、工具原始输出、reasoning 或 trace，不访问 Provider。
- 首次发送消息时自动创建 runtime Session；Session/Run ID 不作为常驻产品信息展示。
- 正式 UI 不得使用硬编码项目、对话或工具活动作为占位数据。

### 4.2 终端面板
- 内嵌终端组件，订阅 PTY 原始流，**人类可观察、可输入**。
- 支持多终端（`terminal_list` 对应多个 tab/面板）。
- ANSI 着色渲染。
- 对话输入区位于对话区内部，只占中间对话工作列宽度，不跨项目侧栏或右侧 Artifact 侧栏。
- Terminal 位于完整对话区之后、对话输入区下方的可调整底部面板，只占对话工作列宽度，不出现在对话输入区或右侧 Artifact 侧栏。
- 顶栏提供底部面板开关，并支持 `Ctrl+J` / `Ctrl+\`` 切换。

### 4.3 Diff 预览
- `apply_patch` / `create_file` 的变更在执行前/后以 diff 形式预览。
- 审批绑定变更前文件 hash 与拟写入内容 hash；若文件在审批后发生变化，原批准失效并重新计算 diff。
- 使用有界只读 Diff viewer，支持语法高亮、截断提示和审批状态；P3 不引入 Monaco/CodeMirror 等完整编辑器。
- 每次成功的 `create_file` / `apply_patch` / `delete_file` 按 conversation 保存变更记录、before/after hash 和有界恢复快照；Diff 面板可查看上次及更早的对话变更。
- 用户可显式回退单项变更。回退前必须再次确认，并校验当前文件仍等于该记录的 after 状态；检测到用户或后续工具修改时拒绝覆盖。回退不依赖 Git，也不影响其他文件。
- 变更历史仅保存在主进程 `userData`，不向 renderer 暴露恢复快照；记录数量和总字节数必须有硬上限。

### 4.4 UI 组件库
- 采用 **Naive UI**（极简风格，按需引入，TS 友好）。
- 终端渲染用 **xterm.js**，代码高亮用 **Shiki**，Markdown 用 **markdown-it**。

### 4.5 Skills 管理 UI
- Skills 列表页：展示已安装 skill 的 name/description/trigger/来源。
- 获取方式：①「输入 URL 下载」②「上传本地文件」③ 未来插件/MCP 提供。
- 禁止直接写软件安装目录；所有用户级 skill 落在 `userData/skills/`。

### 4.6 审批交互
- 危险/需人工审批的动作弹出审批面板：展示 `tool / args / reason`。
- 用户可选「批准 / 拒绝 / 批准并记忆此类规则」。
- “记忆规则”必须展示匹配范围，至少包含工具、参数约束、工作区作用域和有效期；不能绕过执行不变量。Yolo 不读取记忆规则。

---

## 5. 可观测性 · 全周期日志

### 5.1 形态
- 每个会话一个 **JSONL 文件**，存于 Electron `userData/logs/`。
- 日志是**调试功能**，配置项 `logging.enabled` 默认 `false`；只有用户显式开启后才创建 trace。
- 开启后采用完整记录模式，不做上下文脱敏或摘要化：完整保存规范化消息、实际 Provider 请求体、原始流事件、聚合响应、reasoning/continuation state、工具参数与结果、审批事件和配置快照。
- “完整”以 Agent 实际可见数据为边界：工具因输出上限而未进入 Agent 的丢弃字节记录 `totalBytes/truncated/discardedHash`，不要求无限落盘；进入模型上下文的内容必须逐字保存。
- 不记录请求传输层凭据，例如 API Key、Authorization header 和 safeStorage 密文；这些信息不属于模型上下文，也不是回放所需数据。
- 开启时必须明确提示日志可能包含源代码、用户输入、模型推理、工具输出以及工作区中被读取的凭据，并支持保留天数/总大小上限。
- 不引入 SQLite（避免 native 依赖）；日志清理 GUI 留待后续版本。

### 5.2 必须记录的事件（每条一行 JSON）
```
session.start   { schemaVersion, seq, eventId, sessionId, workspace, model, mode, ts }
run.start/end   { runId, status, ts }
llm.call        { callId, runId, model, params, messages, providerRequest, rawEvents, response, providerState?, usage, timing, ts }
approval        { callId, policySignals, mode, approver, decision, reason, ts }
tool.call       { callId, runId, tool, args, result, approvedBy, duration, ts }
terminal.event  { terminalId, direction, data/status, seq, ts }
user.message    { text, ts }
agent.message   { text, ts }
session.end     { ts }
```

### 5.3 保真度要求
- 每条事件包含 `schemaVersion + seq + eventId`，异步流事件可用 `parentId/callId/runId` 建立因果关系。
- **离线回放**：不访问模型、不执行工具，按原始流事件和已记录结果确定性重现 UI、消息历史和 Agent 状态机。
- **请求重放/分叉**：从任一 `llm.call` 重建完全相同的 Provider 请求体，用当前凭据重新请求模型；用于比较上下文调整与 cache 行为，但不保证得到相同随机输出。
- **工具重放**默认只注入已记录结果；真实重新执行副作用工具必须是独立显式操作。
- 保存 Provider 返回的完整 usage，包括可用时的 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、输入/输出 token；同时记录 TTFT、总延迟、请求字节数和稳定前缀 hash，供 KV cache 分析。
- DeepSeek 流式调用必须请求最终 usage chunk；cache 命中以 Provider 返回字段为准，不能仅根据本地消息前缀推断。

---

## 6. 插件系统（生命周期钩子）

### 6.1 目标
主要为**插件扩展**服务：允许第三方/未来扩展注册工具、订阅生命周期事件、扩展 Provider。

### 6.2 MVP 范围
**只埋「事件总线 + 钩子点」**，不做插件加载器、不做插件市场。

### 6.3 钩子点（初步）
| 钩子 | 时机 | 可阻断？ |
|---|---|---|
| `onSessionStart` | 会话开始 | 否 |
| `onSessionEnd` | 会话结束 | 否 |
| `beforeLLMCall` | LLM 调用前（可改 messages/params） | 否（改参） |
| `afterLLMCall` | LLM 返回后 | 否 |
| `beforeToolCall` | 工具执行前（可阻断执行） | **是** |
| `afterToolCall` | 工具执行后 | 否 |
| `beforeApproval` | 审批判定前 | 否 |

> 阻断型钩子返回 `{ allow: false, reason }` 可拦截工具执行。

---

## 7. 非功能需求

| 维度 | 要求 |
|---|---|
| **可中断** | 任意 LLM 流与当前工具执行可被用户中止，不残留无主子进程；会话所属 PTY 按既定生命周期保留或关闭 |
| **安全** | 文件路径硬边界 + 分层权限策略 + IPC 隔离 + safeStorage，见 §3 |
| **可扩展** | 新增工具 = 注册一个 schema + handler；新增 Provider = 实现接口 + Reasoning adapter |
| **桌面分发** | electron-builder 打包 Windows（首要），macOS/Linux 后续 |
| **配置化** | 模型、Provider、权限模式、调试日志开关、Skills 开关和用户策略均可配置 |
| **资源有界** | 工具输出、日志大小、循环轮数、并发 run、PTY scrollback 都有上限 |
| **失败隔离** | Provider、工具、日志失败转成结构化事件，不得因未捕获异常直接打崩主窗口 |
| **契约演进** | IPC、日志、配置和 provider state 均带版本，可做向后兼容迁移 |

---

## 8. MVP 范围

**纳入 MVP：**
- DeepSeek Provider（含 reasoning 明文回传）
- 工具集：文件（read/create/apply_patch）、检索（list/glob/grep）、命令（run_command/delay）、终端（open/send/read/list/close）、**skills（read_skill + 摘要注入 + 三种安装入口）**
- 四档权限模式 + 双模型审批（审批模型可先用 DeepSeek 小模型）
- 执行不变量 + 可扩展风险黑名单 + 确定性策略
- Chat UI（Naive UI，流式 + Markdown + 工具可视化）
- 本地项目/对话导航、对话历史和消息搜索
- 终端面板（人类可交互）
- Diff 预览
- JSONL 完整调试 trace（默认关闭）+ 离线回放引擎 + cache usage/时延统计
- IPC 白名单 API、sender/payload 校验、CSP 与安全导航策略
- 上下文/输出预算与取消、超时、进程树清理
- 插件钩子点（埋点，无加载器）

**MVP 之后：**
- GLM / Anthropic / OpenAI Provider（含各自 reasoning adapter）
- 代码库 embedding / RAG 检索
- **MCP 客户端**（stdio + Streamable HTTP，含 server 生命周期管理）
- 插件加载器
- 日志清理 / 回放可视化 GUI（MVP 先提供回放引擎和基础入口）
- 云端对话同步、跨设备历史和团队共享项目

---

## 附录 A · 术语表
- **PTY**：伪终端（pseudo-terminal），长生命周期的双向终端会话。
- **Provider Continuation State**：Provider 为继续多轮工具链路保存的有序不透明状态；Agent Loop 只搬运。
- **执行不变量**：工具 schema、资源归属和 workspace 契约等调用有效性条件，不属于可审批的风险策略。
- **风险黑名单**：Auto/Confirm 下提升审批等级的危险动作规则；Yolo 明确跳过。
- **Auto Approval**：由独立小模型对动作做 safe/dangerous 二分类自动放行的能力。
- **Skill**：高度浓缩的专家指令（SKILL.md），摘要注入上下文，正文按需 read_skill 加载。
- **渐进式上下文**：先给目录（摘要便宜常驻），需要时再读全文（按需省 token）的加载策略。
- **MCP**：Model Context Protocol，连接外部工具 server 的标准协议；本项目只实现客户端。
