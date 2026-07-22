# 需求文档 · Zch Coding Agent

> 状态：Backend Architecture v2.1 配套需求 · 最后更新 2026-07-22
> 本文档定义「做什么」。技术怎么做见 [`architecture.md`](./architecture.md)，前端信息架构与验收标准见 [`frontend-spec.md`](./frontend-spec.md)。
> v2.1 条目是迁移目标，不表示当前 legacy 实现已经满足；迁移状态见架构文档 §20。

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
- **状态明确**：同一 Session 同一时间只允许一个活动 Run；运行中收到新消息时默认拒绝，但切换到其他对话不取消后台 Run。
- **协议完整**：LLM 一次返回多个工具调用时，每个调用都必须回填一个结果；拒绝、取消、超时也以结构化工具结果回填，不能静默丢失。
- **有界运行**：配置最大循环轮数、单次和单个 run 的工具输出预算、累计上下文预算；全应用 `maxConcurrentRuns` 范围为 `1..32`、默认 4，达到上限的新 run 直接拒绝。每个 run 同时最多一个 provider call，不设置独立 provider 并发上限。`maxStepsPerRun` 默认值为 200，可在 Limits 设置中调整；上下文达到当前模型 prompt budget 的 `autoCompactTriggerPercent`（默认 80%）时，在安全边界自动压缩旧历史；字节、行数/结果数与估算 token 任一上限先到即截断，并向用户和模型返回续读信息。
- **可回放**：调试日志开启时，循环的请求、响应、流式事件和工具结果必须完整保存，可确定性离线回放原会话；重新请求模型属于单独的“重放请求”，不保证复现随机输出（§5）。
- **Prompt Harness**：稳定 base instructions、runtime context、AGENTS、selected context、orchestration request 和 compact history 作为可审计 prompt layers 进入模型请求；runtime context 必须包含 workspace writer 的 `available | writer | readonly_locked` 快照，其他 writer 存在时明确当前 session 只读、禁止副作用并要求 writer 结束后重读文件。状态变化通过 hash 追加新 layer，不修改历史。用户可编辑内容是 assistant preferences，不替换 base harness instructions。
- **计划审阅门**：模型可用 `plan_set` 创建或替换 Plan，默认进入 `awaiting_review` 并停止执行；UI 批准/拒绝会直接记录顶层 Plan 状态并写入 trace，自然语言批准/拒绝也可由模型通过 `plan_status({status:"active" | "rejected"})` 转成可审计状态。Plan review 不是权限模式，不绕过也不替代工具审批。

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

| 工具          | 作用                                          | 副作用 | `reason` |
| ------------- | --------------------------------------------- | ------ | -------- |
| `read_file`   | 按行范围分页读取文件内容                      | 无     | **是**   |
| `create_file` | 新建不存在的 UTF-8 文件，可自动创建缺失父目录 | 有     | **是**   |
| `apply_patch` | 对一个已有文件应用多 hunk 文本补丁            | 有     | **是**   |
| `delete_file` | 删除文件（受控路径，替代裸 `rm`）             | 有     | **是**   |

> 设计意图：把常规删除做成独立工具，便于精确展示路径、数量和审批风险。它不能阻止 `run_command` 间接删除文件，因此命令工具仍必须独立经过权限策略，不能把工具拆分误当成 sandbox。

`read_file` 使用 `startLine + lineCount` 分页，返回实际行范围、总行数、`truncated` 和 `nextStartLine`。默认读取 400 行，单次最多 1000 行，并同时受 64 KiB 与 8K 估算 token 限制；超长单行不能绕过字节/token 上限。

`apply_patch` 第一版一次只修改一个已存在的 UTF-8 文本文件，可包含多个 hunk。补丁路径必须是 workspace 相对路径；禁止二进制、rename、mode change、绝对路径和越界路径。为适配模型常见的计数错误，hunk header 的行数和 new-file 行号只作为提示；上下文/删除行仍必须精确匹配，old line number 失效时只有在精确上下文唯一命中时才可应用。审批绑定原文件 hash、规范化补丁 hash 与结果 hash，执行前重新验证。`create_file` 只创建不存在的文件，并会自动创建缺失父目录；覆盖已有文件应使用 `apply_patch`。

#### 2.2.2 检索类

| 工具       | 作用                       | `reason` |
| ---------- | -------------------------- | -------- |
| `list_dir` | 列目录                     | **是**   |
| `glob`     | 文件名模式匹配             | **是**   |
| `grep`     | 内容搜索（底层 `ripgrep`） | **是**   |

> 预留：`CodebaseIndexer` 接口（embedding / 模糊搜索），MVP 不实现，但工具注册表与 Agent Loop 设计要兼容未来新增只读工具。

#### 2.2.3 命令类

| 工具          | 作用                                                                | 副作用 | `reason` |
| ------------- | ------------------------------------------------------------------- | ------ | -------- |
| `run_command` | 一次性执行进程或 shell 命令，等待结束，返回 stdout/stderr/exit code | 有     | **是**   |
| `delay`       | 等待一个有界毫秒数，供 terminal 轮询输出时使用                      | 无     | **是**   |

> `run_command` 用于短测试、构建、一次性脚本。长时间测试、watch、开发服务器、REPL 或需要反复观察输出的命令应使用 `terminal_open` / `terminal_send`，再配合 `delay` 和 `terminal_read` 轮询。
>
> 参数必须区分 `mode: "process"`（`executable + args[]`，默认优先）和 `mode: "shell"`（命令字符串，支持管道/重定向但风险更高）。不能把两者混成一个无法可靠审查的字符串。
>
> **安全边界说明**：MVP 只能保证命令的初始 `cwd` 位于工作区，不能仅靠字符串检查阻止 shell 命令、脚本或子进程访问工作区外资源。若要提供真正的主机级隔离，必须引入容器/OS sandbox；MVP 不承诺该能力。因此 `run_command` 与 PTY 在 Auto/Yolo 下都属于用户主动接受的主机执行风险。

#### 2.2.4 终端类（persistent PTY）

长生命周期的双向伪终端，**Agent 与人类共享同一个终端流**——人可以观察、也可以在同一个 PTY 上输入。

| 工具                                   | 作用                              | 副作用 | `reason` |
| -------------------------------------- | --------------------------------- | ------ | -------- |
| `terminal_open(cwd, opts)`             | 打开新终端，返回 `terminalId`     | 有     | **是**   |
| `terminal_send(id, text)`              | 向终端写入                        | 有     | **是**   |
| `terminal_read(id, {cursor?, lines?})` | 读最近 N 行或指定 cursor 后的输出 | 无     | **是**   |
| `terminal_list()`                      | 列出所有打开的终端句柄            | 无     | **是**   |
| `terminal_close(id)`                   | 关闭终端                          | 有     | **是**   |
| `terminal_resize(id, cols, rows)`      | 调整终端尺寸                      | 无     | **是**   |

约定：

- `terminal_read` 返回给 **LLM** 的内容是**去 ANSI 的纯文本**（便于模型理解）。
- **UI** 上人类看到的终端流是**原始带色流**。两者订阅同一 PTY，渲染层不同。
- 与 `run_command` 并存：一次性命令用前者；长跑服务/交互式 REPL/实时观察用 terminal，并使用 `delay` 等待后读取增量输出。
- 终端归属于会话而不是单次 run：中断 run 不自动关闭终端；会话关闭或应用退出时必须清理。

### 2.3 LLM Provider 适配

#### 2.3.1 多 Provider 支持

必须支持接入多家模型供应商。一个 Provider module 可以组合目录查询、鉴权/HTTP/SDK transport 与一个或多个 Provider Protocol Adapter；不能把某个 SDK 的消息类型当成 Core 的公共消息接口。复用 OpenAI Chat Completions 协议的 DeepSeek、智谱 GLM、Moonshot、本地 Ollama 等可以共享 Chat Completions Adapter，OpenAI Responses 与 Anthropic Messages 使用各自的 Adapter。

**MVP 只实现 DeepSeek Provider**，其他留接口与 TODO。

Provider 可实现模型目录查询。DeepSeek 使用鉴权后的 `GET /models` 获取当前凭据可用的模型 ID；该端点只作为可用性目录，不能假设会返回上下文长度、最大输出或工具能力。设置页合并 Provider 返回、应用内置模型资料和用户自定义模型，并始终允许手工输入。

模型能力采用 `用户覆盖 > 内置资料 > 保守默认值`。未知模型默认按 64K 上下文管理并明确标记“能力未知”；不得抓取 Provider 文档 HTML 推断运行时能力。模型目录请求失败时保留上次成功缓存和当前手工配置。

token 预算通过可替换估算器计算。支持 Provider tokenizer、保守估算和用户自定义 `bytesPerToken`；自定义值按 Provider/模型保存。估算只负责上下文规划，所有工具仍必须执行不可关闭的字节、行数/结果数硬上限。Provider 返回的真实 usage 用于记录与校准，不作为事前边界保证。

#### 2.3.2 Reasoning（推理过程）适配

不同供应商的「思考过程」格式各异，是适配中最难、最 provider-specific 的部分：

| Provider      | reasoning 形态                                            | 明文/加密                  | 回传要求                                                                |
| ------------- | --------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| **DeepSeek**  | `reasoning_content` 字段                                  | 明文                       | 无工具调用时可省略；发生工具调用后必须按协议回传                        |
| **智谱 GLM**  | Provider-specific reasoning 字段                          | 依模型协议                 | 独立适配并用契约测试确认，不能仅因字段同名复用 DeepSeek 假设            |
| **Anthropic** | 有序 `thinking` / `redacted_thinking` block + `signature` | 明文摘要 + 不透明签名/密文 | 工具链路中必须保留完整 block、顺序与不透明字段，不得筛掉 redacted block |
| **OpenAI**    | Responses API reasoning output items                      | 摘要 + 不透明状态          | 用 `previous_response_id` 或完整回传相关 output items；适配器决定策略   |

需求：抽象统一的 **Provider Continuation Envelope**，但不统一 envelope 内部的 CoT 或 provider-native 数据结构。每个完成的 assistant turn 可以同时保存：

- `normalizedReasoningText`：只包含非加密、应用标准化后的可读 reasoning 文本或摘要，用于 UI、导出和通用审计；允许为空，不能用于重建签名、密文、item id 或原始 block 顺序。
- `providerContinuation`：包含 `schemaVersion/adapterId/format/data` 的版本化 envelope。`data` 原样保留该 Adapter 继续请求所需的有序 provider-native items、签名、密文、cursor 或 response id；Agent Core 和 Renderer 只搬运，不解释、不修改。

完整原始 Provider request/response 和 stream events 只属于显式开启的 trace。Message 只保存 canonical message parts、可读 reasoning 投影，以及继续协议所需的最小 opaque state。

#### 2.3.3 Canonical History 与 Provider Protocol Adapter

持久化历史使用应用自己的 `MessageRecord`：`kind` 表达内部语义，`parts` 是有序、封闭的 canonical payload。V1 part 只包含 `text`、`tool_call` 和 `tool_result`；不保存 Provider DTO 派生出来的 `role/content/toolCalls/toolCallId`，也不把任一 SDK 类型暴露给 Persistence、Renderer 或 Agent Core。

`MessageHistoryCompiler` 只按 `seq/inHistory/compact boundary` 选择历史、校验 `kind/parts` 约束和 tool call/result 配对，并生成 `CompiledCanonicalHistory`。随后由 `ModelRouteSnapshot.adapterId` 指定的 Provider Protocol Adapter 消费**完整有序历史**，执行可能是一对多、多对一的协议编译：

- Chat Completions 可把 assistant `tool_call` parts 编译为 `assistant.tool_calls[]`，把每个 result 编译为独立的 `role = 'tool'` message。
- Responses API 可把同一链路编译为 `function_call` / `function_call_output` items。
- Anthropic Messages 可把相邻 tool results 合并到一个 `user` message，并将 `tool_result` blocks 放在其他 content blocks 前面。

因此 wire `role` 只属于特定协议，不是数据库字段；一条 `MessageRecord` 也不保证对应一条 Provider message/item。Adapter 还负责把 Provider stream 解码为 normalized events，并在完成时返回 canonical assistant parts、可读 reasoning 投影和 continuation envelope；Application Service 为其补齐 Session/Message 字段后一次性持久化完整 turn。

同一供应商的不同协议必须使用不同 `adapterId`，例如 `openai.chat-completions` 与 `openai.responses`。协议差异依据：[OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)。

### 2.4 会话与工作区

- 一个工作区（workspace）= 一个本地目录。
- Project 是 backend-owned 的持久化 workspace 注册记录，使用稳定 `projectId` 和规范化绝对路径。移动目录后通过重新关联更新 Project path，不改写 Session identity。移除 Project 会删除应用中它的 Sessions/Messages/FileChanges，绝不删除 workspace 目录或项目文件。
- Session 是持久化对话实体，绑定一个 `projectId`、当前模型选择与权限模式；UI 中的“对话”是 Session 的展示名称，不存在独立 Conversation 领域记录或 `conversationId -> sessionId` 映射。
- SQLite 持久化 schema migrations、Projects、Session 元数据、完整 Message history 和有界 FileChanges。Goal/Plan 属于 Session 元数据；完整 assistant/tool/harness 内容统一表示为 Message。Renderer 只保存 backend public records 的副本，不得单独创建已提交消息。
- Database migrations 必须按版本前向执行，在单个 transaction 内提交 schema/data change 和 migration record；已应用文件 checksum 改变或数据库版本高于当前应用时明确拒绝打开，不静默猜测兼容。
- 每个 `MessageRecord` 保存内部 `kind` 与有序 `parts`。`kind` 用于区分真实用户输入、编排消息、runtime context、harness、assistant、tool result 和 compact summary；它不是 Provider wire role。V1 shared schema 必须按 `kind` 校验 part 组合：用户输入是非空 text；assistant turn 只含 text/tool-call 且记录实际 route；tool result record 只含一个 terminal tool-result，并引用历史中未完成的 call。
- Message metadata 是按 `kind` 校验的 application-owned typed annotations，可包含 attachment provenance、prompt id/version/hash、标准化 usage、tool/approval/compact 摘要和 reasoning projection 状态。Metadata 可以来源于 Provider，但删除它不能破坏下一次 Provider 请求；协议关键或只能由 Adapter 理解的数据必须放入 `providerContinuation`。
- SQLite 不保存 OpenAI、DeepSeek、Anthropic 或其他 Provider SDK 的请求 DTO。发起请求时，backend 从 `inHistory = true` 的完整 `MessageRecord` 生成 `CompiledCanonicalHistory`，再由当前 Provider Protocol Adapter 整段编译 wire DTO；Persistence layer 不依赖 Provider。
- Draft 和 draft attachments 是 renderer UI 状态，不进入 backend 或 SQLite，也不要求在切换 Session、renderer reload 或应用重启后保留。
- 每次用户提交形成 backend memory 中的 Active Run；它在开始时冻结包含 `adapterId/providerId/model/reasoning profile/config revision` 的实际 `ModelRouteSnapshot` 和权限模式，但不单独落盘。完成的 assistant message 记录实际 route；Session 的模型/模式修改只影响后续 Run。
- Active Run、stream delta、pending approval、未完成 tool batch、writer lease 和 PTY/process 都是 backend runtime state，不进入 SQLite。
- 同一 canonical workspace 同时最多一个非只读 writer run；`auto`、`confirm`、`yolo` 从 run 启动覆盖 provider、工具、等待审批、interjection continuation 和 cancelling。若不可中止的副作用工具在 cancelled/timeout 结果之后仍在执行，writer 必须继续持有到其底层 Promise settle。writer 数固定为 1，不提供配置。
- `readonly` run 不获取 writer，可与 writer 和其他 readonly run 并行；不同 workspace 可各自拥有 writer。同 workspace 的第二个非只读 run 不排队，返回带 owner Session/Run 的结构化冲突。
- completed、failed、cancelled、异常、session close 和 app dispose 都必须走幂等释放路径。全局 run slot 在 terminal run status 对 renderer 可见前释放；writer 在没有残留副作用时同步释放，有不可中止副作用时延迟到其真正 settle，禁止为满足 UI 终态而提前开放第二个 writer。
- 文件工具必须约束在工作区边界内（规范化路径、真实路径与符号链接逃逸检测）。
- Session canonical history 必须以完整 Message 持久化。应用重启后按 `inHistory = true` 和 `seq` 重建 `CompiledCanonicalHistory`，再由当前 route 的 Protocol Adapter 生成请求；compact 通过完整 summary message 和显式 `inHistory` 变更替代旧前缀。
- Assistant stream delta 只保存在 backend memory；Provider turn 完成后才插入 Message。包含 tool calls 的 assistant turn 必须等每个 call 都有 terminal result 后，与对应 tool messages 在同一 transaction 写入，数据库不得保存协议半截。
- 应用崩溃可以丢失尚未完成的 assistant text/reasoning、tool batch 和 Active Run，不保存 partial message，也不生成持久化 interrupted Run。最后一条已提交 user message 可以暂时没有 assistant reply。
- 如果副作用工具已经修改 workspace、但应用在完整 tool batch transaction 前崩溃，文件变化可以保留而 tool messages 丢失；系统以下一次读取到的实际 workspace 为准。V2.1 不承诺文件系统与消息数据库之间的 crash-atomic journal。
- 如果文件副作用已成功但 `file_changes` 持久化失败，terminal tool result 必须如实报告 `mutationSucceeded = true`、`CHANGE_HISTORY_PERSIST_FAILED` 和 `revertAvailable = false`；不得把已发生的文件操作报成未发生或自动重试。
- JSONL trace 是可选审计记录，不是事务恢复日志，也不能作为 Session 状态的唯一来源。

### 2.5 Skills（渐进式专家指令）

#### 2.5.1 是什么

Skills 是高度浓缩的「专家指令」——一段描述某领域最佳实践的 markdown（SKILL.md）。采用**渐进式上下文**加载：

- **摘要阶段**：启动时扫描 skills 目录，把每个 skill 的 frontmatter（name + description + trigger）提取出来，作为 harness selected context/skills summary 注入（便宜，常驻上下文）。
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

| 工具               | 作用                      | 副作用 | `reason` |
| ------------------ | ------------------------- | ------ | -------- |
| `read_skill(name)` | 读取指定 skill 的完整正文 | 无     | **是**   |

### 2.6 MCP（Model Context Protocol）客户端

#### 2.6.1 是什么

实现 **MCP 客户端**（不是 server），用于连接外部 MCP server，复用第三方工具生态（如 GitHub、数据库、文件系统等 MCP server 提供的工具）。

#### 2.6.2 传输

- **stdio**：spawn 本地 MCP server 子进程（首要）。
- **Streamable HTTP**：连接远程 MCP server（预留，MVP 之后）；旧 HTTP+SSE 仅作为兼容模式。

#### 2.6.3 Generic MCP v1 能力范围

- **配置**：用户在 `userData/config.json` 手写 stdio server 配置。全局 server 在应用启动时连接，工作区 server 在对应工作区激活时连接；启动命令变更会使 fingerprint 信任失效。
- **稳定 gateway**：Provider 始终只看到 `list_mcp_servers`、`read_mcp_server`、`call_mcp_tool` 三个固定工具。目录读取按 server 分页，MCP 的 `tools/list` 本身也完整跟随 server cursor，配置和目录变化不改变顶层工具定义。
- **披露约束**：会话必须先读取包含目标工具的当前 revision 页面才能调用。cursor 绑定 server、revision 和 offset，目录变化后旧 cursor 与旧披露状态失效。
- **工具命名**：通用调用在权限判断和 `tool.proposed` 前展开为 `mcp:<serverId>:<toolName>`，并以 MCP 原始 input schema 校验业务参数。
- **权限**：目录工具在 ReadOnly 下可读；MCP 执行在 ReadOnly 下拒绝、Auto 下模型审批并可升级人工审批、Confirm 下人工审批、Yolo 下直接执行。MCP 审批不可记忆、调用不可自动重放。
- **生命周期**：主进程管理 handshake、目录边界、超时、取消、draining、有限指数退避重启、stderr tail 和应用退出清理。Serena 复用 stdio connection，但只暴露稳定 `code_*` facade。
- **秘密环境变量**：`env` 仅存非敏感值；`envFromHost` 只保存子进程变量名到主机变量名的映射。主机值只在主进程启动子进程时解析，不进入 renderer、public config、trace 或日志。

---

## 3. 权限与安全模型

### 3.1 四档权限模式

会话级配置，决定工具调用如何放行：

| 模式                   | 行为                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ReadOnly**           | 只放行无本地副作用的文件/code/VCS/terminal/instruction 读取与有界 delay；filesystem write/delete、VCS write、project metadata write、process spawn、terminal write、network side effect 和 unknown external effect 一律拦截。它不代表“数据不会发送给 LLM” |
| **Auto**（双模型审批） | 先走确定性策略；仍需 review 的副作用工具由审批模型判定：safe→自动执行，dangerous→转人类审批                                                                                                                                                               |
| **Confirm**            | 所有副作用工具一律人类审批                                                                                                                                                                                                                                |
| **Yolo**               | 跳过黑名单、风险策略、审批模型和人工审批，直接执行所有结构合法的工具调用；首次启用必须明确提示其可执行任意主机命令的风险                                                                                                                                  |

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

- **Workspace writer** 是审批之前的执行不变量：非只读 run 必须先原子取得 workspace writer；Confirm/Yolo 或人工批准都不能绕过另一个 writer owner。
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
- “对话”直接对应 backend-owned Session；标题、完整消息历史、所属项目、创建/更新时间和模型/权限模式由后端持久化并推送给 renderer。Draft 仅属于 renderer 输入组件。
- 搜索通过本地后端查询 Session 标题，以及 `kind = 'user_input'/'assistant_turn'` records 中 `type = 'text'` 的 parts；不把 orchestrator/harness/runtime context 当成用户消息，也不检索 tool call 参数、tool result/JSON parts、工作区文件、reasoning、continuation 或 trace，更不访问 Provider。
- 新建对话时立即创建持久化 Session；首次发送消息启动内存 Active Run。Session/Run ID 不作为常驻产品信息展示。
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
- 每次成功的 `create_file` / `apply_patch` / `delete_file` 按 Session 保存变更记录、before/after hash 和有界恢复快照；Diff 面板可查看上次及更早的 Session 变更。
- 用户可显式回退单项变更。回退前必须再次确认，并校验当前文件仍等于该记录的 after 状态；检测到用户或后续工具修改时拒绝覆盖。回退不依赖 Git，也不影响其他文件。
- 变更历史保存在主进程 `userData/agent.db` 的 `file_changes` 表。它不是 Message、Run journal、trace 或模型历史；恢复用 `beforeContent` 只对 backend 可见，renderer 只获得不含快照的 `FileChangeSummary`。
- `file_changes` 的记录数量和 `beforeContent + diff` UTF-8 总字节数必须有硬上限。单条恢复 payload 已超过总上限时，文件工具必须在副作用前拒绝；Retention 只会让过旧单项丧失 Diff/revert 能力，不能删除 Message 或改动 workspace。

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

- 每个 Session 一个 **JSONL 文件**，存于 Electron `userData/traces/`。
- 日志是**调试功能**，配置项 `logging.enabled` 默认 `false`；只有用户显式开启后才创建 trace。
- 开启后采用完整记录模式，不做上下文脱敏或摘要化：完整保存规范化消息、实际 Provider 请求体、原始流事件、聚合响应、reasoning/continuation state、工具参数与结果、审批事件和配置快照。
- “完整”以 Agent 实际可见数据为边界：工具因输出上限而未进入 Agent 的丢弃字节记录 `totalBytes/truncated/discardedHash`，不要求无限落盘；进入模型上下文的内容必须逐字保存。
- 不记录请求传输层凭据，例如 API Key、Authorization header 和 safeStorage 密文；这些信息不属于模型上下文，也不是回放所需数据。
- 开启时必须明确提示日志可能包含源代码、用户输入、模型推理、工具输出以及工作区中被读取的凭据，并支持保留天数/总大小上限。
- 完整 trace 必须可规范化为只读 `zch-session-transcript`：按 run 展示用户/Assistant/明文 reasoning、内部编排、工具与审批、Provider上下文、Plan、interjection、usage、terminal和生命周期。该格式不可导入或重放；每次 Electron 导出前必须警告，导出内容不做敏感信息扫描或脱敏，用户负责本地保存和后续分享。
- Transcript 不输出 provider wire request/raw response/provider continuation、流式重复分片、工具schema、加密/opaque reasoning或多模态原始载荷；中断且没有final message的明文delta标为partial，多模态只保留类型/MIME/已知大小占位。
- 产品 Session 状态使用 SQLite 持久化；Trace 继续按每个 Session 一个 JSONL 文件保存，不能因数据库存在而降低 trace 保真度。日志清理 GUI 留待后续版本。

### 5.2 必须记录的事件（每条一行 JSON）

```
session.start   { schemaVersion, seq, eventId, sessionId, workspace, model, mode, ts }
run.start/end   { runId, status, ts }
run.rejected    { runId, reason, limit?, active?, writerSessionId?, writerRunId?, ts }
workspace.writer { sessionId, runId, workspace, acquired|released|rejected, owner?, ts }
llm.call        { callId, runId, model, params, messages, providerRequest, rawEvents, response, providerContinuation?, usage, timing, ts }
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

### 5.4 Headless 运行输出

- 内部 Headless host 必须复用桌面端唯一 Agent Runtime 组装入口，固定 Yolo 且不增加、删除或替换模型可见工具。
- stdout 只允许版本化 JSONL；host 诊断写 stderr；最终 `result.json` 原子写入 workspace 外的 artifacts 目录。
- Provider 凭据只能由受信任配置声明的环境变量名称解析，凭据值不得进入配置回包、JSONL、trace、patch 或子进程环境。
- result 必须记录 session/run id、终态、未完成原因、wall time、最终回复、usage、工具统计、trace 和 patch 路径。Agent `completed` 不代表 benchmark correctness。
- Plan 自动批准必须在前一 run 完全 settle 后，通过有版本的 harness 消息追加到历史和 trace；不得伪装成用户消息。Goal blocked 或自动批准达到上限返回 `needs_human_input`。
- timeout、SIGINT 和 SIGTERM 必须进入共享 interrupt/disposer；补丁采集不得修改 workspace 的真实 Git index。
- 每个 Headless artifact 必须包含 runtime identity；source commit、case/config digest、provider/model、核心预算、prompt/tool hash 或 capability 不同的结果不得直接比较。
- Electron/Headless parity 必须通过共享 trajectory 比较 Provider messages、稳定 prompt layer、工具定义与调用、compact/Plan/MCP 行为和 patch；只允许逐字段声明的 host 差异，禁止宽泛 snapshot 忽略。

### 5.5 Linux Docker worker

- Worker image 必须从与桌面/Headless 相同的 source commit 构建并复用唯一 Headless bundle；v1 只支持 Linux x64、Node 24 LTS 和 glibc，其他 daemon、架构、libc 或 native ABI 返回 `unsupported`。
- Agent container 必须使用非 root、只读 rootfs、drop 全 capabilities、no-new-privileges、默认 seccomp，以及 PID、CPU、内存、tmpfs、磁盘和 wall-time 预算。允许的 bind mount 仅为单次 workspace、artifacts、只读输入和 credential file。
- 默认 Provider proxy 模式下，Agent 只能加入该 run 的 internal network且只能读取单次 proxy token；真实 Provider key 只存在 coordinator 内存和 proxy 专用临时 secret file，不得进入 Agent config/env、trace、JSONL、artifacts 或 Docker inspect env。
- 直接 credential 模式仅作为显式受控开发 fallback。两种模式都必须使用 Headless config 中声明的 provider-scoped credential 名称，task 不得选择 credential、网络或权限模式。
- coordinator 必须在 timeout、cancel、异常和正常完成后执行有限 stop、kill fallback、bounded log/artifact 收集、container/network 删除和 secret 删除；清理结果写入版本化 `worker-result.json`，coordinator/environment 故障不得计为模型任务失败。
- Docker smoke 必须验证一次真实工具写入轨迹和一次挂起 Provider 强制终止，确认 secret 不泄漏、sandbox 参数生效且没有残留 Agent/proxy container 或 run network。该测试显式 opt-in，不进入无 Docker 的默认 `npm test`。

### 5.6 Benchmark case contract

- Native BenchmarkCase v1 必须记录 case/suite/revision、任务、repository provenance、固定 archive/tree hash、Linux platform、case image OCI digest、setup、公开检查、grader protocol、acceptance groups、feedback policy、修改范围和资源预算；未知字段和越界预算一律拒绝。Core中的review record只记录确定性self-check，不要求prompt/test alignment或人工批准。
- Suite index 必须固定每个 manifest hash；manifest 必须继续固定 archive、tree 和 private spec hash。Dataset adapter id/revision 纳入 suite identity，adapter 或任一 transitive 输入变化都必须得到新 identity，不能静默覆盖冻结 suite。
- Agent descriptor 只能包含 task、公开检查、修改范围和预算。Private spec 路径、hidden commands、oracle/gold patch、mutants、外部数据集 `fail_to_pass` / `pass_to_pass` 不得进入 descriptor、workspace、Headless config、trace 或 Docker build context。
- Workspace 必须从固定 archive 向空目录重建；archive path 需要 containment、重复项和 tree hash 校验。准备后的 Git 只保留当前 baseline commit，不得含 remote、tag、reflog、hooks、不可达未来对象或缓存历史。
- 非 abstain 自建 case 的 baseline 必须失败；abstain/no-change case 的 baseline 与 `no-change` oracle 必须通过。两类 case 的 oracle 都要通过全部公开与私有行为组，且至少两个合理 mutant 必须通过公开检查但被声明的隐藏行为组拒绝。完整准备和评判重复三次，证据签名不一致视为 flaky/invalid。
- 通用adapter边界必须内置native、monthly-swebench与swe-rebench；runner不能依赖native archive的准备、patch捕获或grader细节。外部dataset只能归一化公开Agent descriptor，不能借adapter把solution、gold/test patch、测试ID或verifier字段带入Agent面。
- `core-harness-8`固定8项并保留baseline/oracle、每项至少两个mutant和三次稳定性自检。外部数据质量直接信任上游，不增加语义审核Agent、prompt/test alignment或人工批准。
- 外部workspace必须使用Docker named volume挂载到任务原生路径；Agent image只能从官方任务环境叠加当前ZCH Headless runtime，Provider proxy继续使用通用worker image。Grader每次使用fresh volume、上游verifier、`network=none`、非root、只读rootfs和资源限制。
- 每个新外部case/image digest首次使用时缓存一次baseline未解决和oracle已解决的机器兼容检查；失败必须归类为infrastructure incompatible并按cohort固定顺序递补，不得评价数据集语义质量。

### 5.7 Benchmark runner protocol

- Runner 默认使用 `strict`：每个 trial 从冻结 archive 创建 pristine workspace，只启动一个独立 Headless container；Agent 退出后才在宿主可信边界创建新的 evaluator workspace并应用 patch，任何 evaluator 输出都不得回流 Agent。
- `repair-once` 只对 manifest 明确允许的 case 开启。首轮完成后 Headless 发出一次阶段事件，runner 评判当前 patch，并通过 attach stdin 最多返回一次清洗后的 `<benchmark_feedback>`；修复必须复用同一 workspace、session 和 append-only history，最终 patch必须在另一份干净 evaluator workspace重评。
- `public` feedback 只能包含公开检查摘要；`diagnostic` 还可包含公开 manifest 已声明的验收组名称和通用失败类别。两者均禁止隐藏源码、私有命令输出、精确隐藏期望、oracle/gold patch 和外部数据集 evaluator 字段。
- Trial 结果必须分别记录 `resolvedInitial`、`resolvedAfterFeedback`、`recovered`、首轮指标、修复阶段增量指标和累计指标。修复成功不得回填首次通过；`pass@k` 必须是 k 个独立 pristine trial，不得复用 session、container、workspace、credential token 或 Provider continuation。
- Resume 只允许复用 identity 一致、带 complete marker 且整棵 artifact checksum 一致的 immutable trial。`.incomplete-*` staging 不计入样本也不复用；已有 final artifact 缺失、被篡改或 identity 不同必须拒绝覆盖。
- Runner 完成前必须删除 Agent workspace、扫描 artifacts 是否含真实 Provider credential，并保存零命中报告。凭据命中时必须删除该 staging；唯一例外是明确标为restricted且不进入shareable report的 `session-transcript.restricted.md`，它按本地用户负责原则不扫描或脱敏，其他patch、trace、JSONL、stderr和证据仍必须扫描。

### 5.8 Isolated grader and scoring

- 正式 grader 必须运行在与 Agent 分离的 container，使用 `network=none`、非 root、只读 rootfs、drop all capabilities、no-new-privileges、PID/CPU/内存/tmpfs/wall limits。只允许挂载干净 evaluator workspace、只读 private input 和独立 output；Docker socket、Agent artifacts、Provider credential 和宿主 home不得出现。
- 宿主从冻结 archive重建 workspace并应用 patch；private spec只序列化到一次性只读 grader input，不进入 Agent image/workspace/config/trace。Grader output必须校验 schema、case/input/image identity及完整命令计划，input执行前后 hash必须一致。
- 结果状态固定区分 `unsupported`、`invalid`、`attempted` 和 `graded`。Docker/capability/image/grader/coordinator故障归为 unsupported/invalid；Agent patch不能应用、越过 modification scope或违反 diff hygiene归为 attempted，不得混入 deterministic graded样本。
- 硬门禁至少覆盖 patch apply/scope/hygiene、Agent execution boundary、Headless result、runtime image identity、worker/grader cleanup、credential scan、grader sandbox/input immutability/completion。任一 infrastructure gate失败时，即使功能检查通过也不得 resolved。
- 完成等级固定为 L0 无有效改动、L1 合法 patch、L2 setup/build/static通过、L3公开回归通过、L4至少一个行为组通过、L5全部 critical行为组与回归门禁通过。Partial correctness按 acceptance group做 macro-average，单组增加测试数量不得改变组权重。
- 可分享 `evaluation.json` 只能包含公开检查、行为组聚合、失败类别、硬门禁和 grader identity。Private check id/command、命令 stdout/stderr和 grader input只能存在于本地 restricted artifact或完全省略；命令输出默认只保存 hash。

### 5.9 Benchmark metrics and comparison

- 每个工具调用必须产生一个 terminal `tool.attempt`，区分 validation、permission 与 execution stage，并记录 outcome、effects、duration、输入/输出字节、截断及错误码。Schema 无效、权限拒绝、执行失败与成功不得合并为“已完成”。
- Trial usage 必须按 main、approval、title、compression scope 汇总 prompt/completion/reasoning/cache hit/cache miss/total token。Provider 未返回的 request 或字段必须保存为 `null`/unknown，不得以零、字符数或 tokenizer 估算替代精确 usage。
- 工具、patch 与 trajectory 指标必须覆盖 proposed/executed/succeeded/failed/denied、tool/effect 分类、重复参数签名、首次有效编辑/测试、最终验证后空转、文件与增删行、测试/二进制改动、workspace 外写入、LLM request、continuation、compact、Plan/Goal、MCP和 terminal。
- 测试识别必须覆盖结构化process/shell参数、常见package/language runner和直接执行test/spec文件；terminal_send成功只表示输入被接受，不能作为最终验证通过时间。
- 成本只能由显式 run-group `priceSnapshot` 的逐 usage-field rate计算；snapshot source/revision/hash必须进入 artifact 与 trial identity。任何被定价 usage 字段 unknown 时 scope和总成本也必须 unknown。
- `costPerResolvedUsd`、tokens/tool calls per resolved必须以全部 trial 总消耗除以 resolved 数，不能丢弃失败 trial。另行报告 unresolved token/cost和 resolved duration中位数。
- A/B 必须逐 trial匹配 cohort、suite/case identity、runtime/case/grader image、Provider/model/profile/reasoning、资源预算、protocol/feedback、trial index与 price snapshot。任一不一致必须拒绝并列出字段路径；可比较结果输出paired delta、win/loss/tie、总体resolve delta与置信区间，并按safety、correctness、efficiency词典序排序。

### 5.10 Benchmark CLI, profiles, and artifacts

- 必须提供独立opt-in的`benchmark:smoke`、`benchmark`、`benchmark:full`和`benchmark:external`；默认`npm test`、`npm run build`和Electron E2E不得隐式构建镜像、连接Provider或运行benchmark。Core三个preset分别为3×1、8×3、8×5；external固定Monthly 8 + SWE-rebench 8且每项3 trials。CLI必须对suite/case/trial数量设置硬上限。
- External run开始时必须解析最新Monthly release与SWE-rebench leaderboard split，并按seed无放回抽取；Monthly固定4 bugfix + 4 non-bug，SWE-rebench按仓库和patch规模分层，整个cohort同仓库最多一项。缺字段、image不可用、资源越界或兼容失败按固定随机顺序递补并记录原因。
- `cohort.json`必须固定两个dataset release/commit、adapter revision、seed、16个case hash、官方任务image digest和派生Agent image digest。`--seed`用于生成，`--cohort`用于A/B复用，两者互斥；run内目录变化不得改变已固定cohort。
- CLI必须复用 Headless config和同一 Docker worker/runner/grader，不得实现第二份 Agent loop。Provider key只从 config声明的主机环境变量读取，默认经 proxy credential模式传递；命令输出、identity、config snapshot、summary和shareable report不得包含 key值。
- 经过schema校验的公开case descriptor必须以独立`<benchmark_case>` Harness层进入首次模型请求，并在trace中记录为orchestrator context；不得拼接到用户task或伪装成`user.message`。Native case可显示public checks、allowed/denied paths和资源预算；外部case只显示problem statement、公开范围和预算，不显示测试列表。两者都不能包含private evaluator字段。
- Run-group identity必须固定 preset、suite/adapter、case identity、runtime image digest、source commit、Headless config、Provider/model/profile/reasoning、protocol/feedback、trial数和price snapshot。非空输出目录只有 identity完全一致时才能恢复；trial复用仍须满足各自complete marker和artifact hash。
- Artifact必须按 run-group/suite/case/trial/attempt分层，足以离线复核manifest、task、runtime identity、patch、grader、trace、JSONL、stderr、usage/tool metrics、泄漏扫描和最终等级。缺失trace metrics的执行必须标为incomplete，不能生成虚假效率汇总。
- `shareable-report.json`只能包含公开evaluation、聚合metrics、comparison identity和无路径summary。Raw trace/JSONL/stderr、config snapshot、case-result、grader input/private check/command/output必须列入restricted artifact清单；redaction文件必须声明删除字段。
- External summary必须分别显示Monthly、SWE-rebench、50/50 source macro与总体结果；不同来源的trial不能相互替补或隐藏单项结果。
- 有完整trace的trial必须复用共享conversation Markdown serializer生成 `conversation.restricted.md`，包含user/assistant/orchestrator正文和reasoning，且在leak scan与artifact hash之前写入。该文件只用于人工阅读，不得伪造tool消息，也不得进入shareable report。
- 有完整trace的trial还必须用桌面端同一normalizer生成 `session-transcript.restricted.md`，包含工具、审批、内部编排、明文reasoning和折叠Provider上下文；它进入artifact hash和restricted清单，但从credential scan的输入中按精确artifact路径排除。

---

## 6. 插件系统（生命周期钩子）

### 6.1 目标

主要为**插件扩展**服务：允许第三方/未来扩展注册工具、订阅生命周期事件、扩展 Provider。

### 6.2 MVP 范围

**只埋「事件总线 + 钩子点」**，不做插件加载器、不做插件市场。

### 6.3 钩子点（初步）

| 钩子             | 时机                                                  | 可阻断？   |
| ---------------- | ----------------------------------------------------- | ---------- |
| `onSessionStart` | 会话开始                                              | 否         |
| `onSessionEnd`   | 会话结束                                              | 否         |
| `beforeLLMCall`  | LLM 调用前（可改已编译请求副本/params，不改持久历史） | 否（改参） |
| `afterLLMCall`   | LLM 返回后                                            | 否         |
| `beforeToolCall` | 工具执行前（可阻断执行）                              | **是**     |
| `afterToolCall`  | 工具执行后                                            | 否         |
| `beforeApproval` | 审批判定前                                            | 否         |

> 阻断型钩子返回 `{ allow: false, reason }` 可拦截工具执行。

---

## 7. 非功能需求

| 维度         | 要求                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **可中断**   | 任意 LLM 流与当前工具执行可被用户中止，不残留无主子进程；会话所属 PTY 按既定生命周期保留或关闭                          |
| **安全**     | 文件路径硬边界 + 分层权限策略 + IPC 隔离 + safeStorage，见 §3                                                           |
| **可扩展**   | 新增工具 = 注册一个 schema + handler；新增 Provider 协议 = transport + Protocol Adapter + reasoning/continuation codec  |
| **桌面分发** | electron-builder 打包 Windows（首要），macOS/Linux 后续                                                                 |
| **配置化**   | 模型、Provider、权限模式、调试日志开关、Skills 开关和用户策略均可配置                                                   |
| **资源有界** | 工具输出、日志大小、循环轮数、并发 run、PTY scrollback 都有上限；默认最多 4 个 active run，同 workspace writer 永远为 1 |
| **失败隔离** | Provider、工具、日志失败转成结构化事件，不得因未捕获异常直接打崩主窗口                                                  |
| **契约演进** | IPC、日志、配置和 Provider Continuation Envelope 均带版本，可做向后兼容迁移                                             |

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
- **Provider Continuation Envelope**：附着在完成 assistant message 上的版本化外壳；`adapterId/format` 标识解释者，`data` 保存继续多轮工具链路所需的有序不透明 Provider 状态。统一的是外壳，不是 CoT 数据结构。
- **执行不变量**：工具 schema、资源归属和 workspace 契约等调用有效性条件，不属于可审批的风险策略。
- **风险黑名单**：Auto/Confirm 下提升审批等级的危险动作规则；Yolo 明确跳过。
- **Auto Approval**：由独立小模型对动作做 safe/dangerous 二分类自动放行的能力。
- **Skill**：高度浓缩的专家指令（SKILL.md），摘要注入上下文，正文按需 read_skill 加载。
- **渐进式上下文**：先给目录（摘要便宜常驻），需要时再读全文（按需省 token）的加载策略。
- **MCP**：Model Context Protocol，连接外部工具 server 的标准协议；本项目只实现客户端。
