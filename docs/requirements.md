# 需求文档 · Zch Coding Agent

> 状态：Backend Architecture v2.1 P0–P13 已完成 · 最后更新 2026-07-29
> 本文档定义「做什么」。技术怎么做见 [`architecture.md`](./architecture.md)，前端信息架构与验收标准见 [`frontend-spec.md`](./frontend-spec.md)。
> P0–P13 已实现；后续产品项与已延后的 P3 review 建议进入 roadmap 或独立设计。

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
- **有序并发**：`ToolDefinition.executionMode` 明确区分 `parallel | serial`，未声明时按 `serial` 处理。连续 parallel 调用只并发执行 Tool body，准备/审批和结果提交保持原 call 顺序；serial 调用是前后并行段的完成屏障。
- **有界资源、默认不限 React 步数**：单次和单个 run 的工具输出预算、累计上下文预算继续受限；全应用 `maxConcurrentRuns` 范围为 `1..32`、新安装默认 16，达到上限的新 run 直接拒绝，升级已有配置时保留用户当前值。每个 run 同时最多一个 provider call，不设置独立 provider 并发上限，也不对主聊天流设置默认总墙钟超时。`maxStepsPerRun = 0` 表示 React loop 不限步数并作为默认值；有界自动化部署仍可配置正整数上限。自动压缩只由刚完成响应的 Provider usage 达到当前模型绝对 `compactThresholdTokens` 触发；达到 `contextWindowTokens` 必须在 assistant completion 事件、canonical append 和工具执行前直接失败，不能持久化半个 Tool batch；usage 缺失时不主动压缩。工具响应在完整结果 batch 提交后压缩，final answer 延迟到下一次用户 Run 且在插入新提问前压缩。未显式配置的模型仍按可用 prompt budget 的 `autoCompactTriggerPercent`（默认 80%）生成绝对阈值；本地 token 估算只做调用前硬 preflight 和输出截断，不决定主动压缩。字节、行数/结果数与估算 token 任一上限先到即截断，并向用户和模型返回续读信息。
- **可回放**：调试日志开启时，循环的请求、响应、流式事件和工具结果必须完整保存，可确定性离线回放原会话；重新请求模型属于单独的“重放请求”，不保证复现随机输出（§5）。
- **Prompt Harness**：稳定 base instructions、runtime context、AGENTS、selected context、orchestration request 和 compact history 作为可审计 prompt layers 进入模型请求；runtime context 必须包含 workspace writer 的 `available | writer | readonly_locked` 快照，其他 writer 存在时明确当前 session 只读、禁止副作用并要求 writer 结束后重读文件。状态变化通过 hash 追加新 layer，不修改历史。用户可编辑内容是 assistant preferences，不替换 base harness instructions。
- **计划审阅门**：模型可用 `plan_set` 创建或替换 Plan，默认进入 `awaiting_review` 并停止执行；UI 批准/拒绝会直接记录顶层 Plan 状态并写入 trace，自然语言批准/拒绝也可由模型通过 `plan_status({status:"active" | "rejected"})` 转成可审计状态。Plan review 不是权限模式，不绕过也不替代工具审批。

### 2.2 工具集

工具分为四大类。所有规范化 `ToolCall` 都必须包含独立的 `reason` 意图字段，用于：

1. 人类审批界面的意图展示；
2. 喂给审批模型做判定。

内置工具可在暴露给模型的 schema 中加入保留字段；MCP 等外部工具由 Provider/ToolRegistry 统一包装，规范化后把 `reason` 与业务 `args` 分离，转发外部工具时不得携带该保留字段。Provider parser 与 ToolRegistry/executor 边界都必须删除实际注册的 intent 字段，避免流式解析或序列化异常把 `_agent_intent` 泄漏到 `additionalProperties: false` 的业务 schema。`reason` 是不可信声明，不参与工具自身业务参数校验。

每个工具还必须声明机器可读的能力元数据，而不是只用一个 `readonly` 布尔值：

- `effects`：如 `filesystem.read`、`filesystem.write`、`process.spawn`、`terminal.write`、`network.request`。
- `risk`：`low | review | high` 的默认风险级别。
- `supportsAbort`、`defaultTimeoutMs`、`maxOutputBytes`。

所有参数先经 JSON Schema 校验。Backend 内部结果使用统一 `ToolResult` 信封，明确 `ok/error/cancelled/timeout/truncated`，供安全检查、trace 和插件使用；模型历史不接收该信封。敏感数据过滤后，Tool Registry 将成功正文投影为 canonical `TextPart | JsonPart`，错误投影为统一短文本，再按投影后的实际内容执行单次与 Run 累计 token bound。自定义 projector 必须同步、确定性、无 I/O，异常时回退默认安全投影。

#### 2.2.1 文件类

| 工具          | 作用                                          | 副作用 | `reason` |
| ------------- | --------------------------------------------- | ------ | -------- |
| `read_file`   | 按行范围分页读取文件内容                      | 无     | **是**   |
| `create_file` | 新建不存在的 UTF-8 文件，可自动创建缺失父目录 | 有     | **是**   |
| `apply_patch` | 对一个已有文件应用多 hunk 文本补丁            | 有     | **是**   |
| `delete_file` | 删除文件（受控路径，替代裸 `rm`）             | 有     | **是**   |

> 设计意图：把常规删除做成独立工具，便于精确展示路径、数量和审批风险。它不能阻止 `run_command` 间接删除文件，因此命令工具仍必须独立经过权限策略，不能把工具拆分误当成 sandbox。

`read_file` 使用 `startLine + lineCount` 分页。模型可见结果直接是带行号正文；空文件为 `[empty file]`，只有截断时才追加 `nextStartLine/totalLines/lineTruncated` 尾注，不重复 path 或参数。默认尽量读取到 10,000 行，单次最多 10,000 行，并同时受 128 KiB 与 64K 估算 token 限制；超长单行不能绕过字节/token 上限。每个工具结果独立受默认 64K token 上限保护，不设置跨调用或跨步骤累计的 Run 总预算；Token 估算继续按 UTF-8 字节比例保守计算，不能把字节数直接当成真实 token 数。完整 Provider 请求仍受冻结模型 profile 的 prompt budget 和自动压缩约束。

`apply_patch` 第一版一次只修改一个已存在的 UTF-8 文本文件，可包含多个 hunk。补丁路径必须是 workspace 相对路径；禁止二进制、rename、mode change、绝对路径和越界路径。为适配模型常见的计数错误，hunk header 的行数和 new-file 行号只作为提示；上下文/删除行仍必须精确匹配，old line number 失效时只有在精确上下文唯一命中时才可应用。审批绑定原文件 hash、规范化补丁 hash 与结果 hash，执行前重新验证。`create_file` 只创建不存在的文件，并会自动创建缺失父目录；覆盖已有文件应使用 `apply_patch`。

#### 2.2.2 检索类

| 工具       | 作用                       | `reason` |
| ---------- | -------------------------- | -------- |
| `list_dir` | 列目录                     | **是**   |
| `glob`     | 文件名模式匹配             | **是**   |
| `grep`     | 内容搜索（底层 `ripgrep`） | **是**   |

模型可见的 `grep` 结果使用 `path:line:text`，`glob/list_dir` 每行一个路径且目录追加 `/`；空结果使用 `[no matches]` 或 `[empty directory]`，只有截断时追加短尾注。不得重复回显 pattern/include/path 等调用参数。

> 预留：`CodebaseIndexer` 接口（embedding / 模糊搜索），MVP 不实现，但工具注册表与 Agent Loop 设计要兼容未来新增只读工具。

#### 2.2.3 命令类

| 工具          | 作用                                                                | 副作用 | `reason` |
| ------------- | ------------------------------------------------------------------- | ------ | -------- |
| `run_command` | 一次性执行进程或 shell 命令，等待结束，返回 stdout/stderr/exit code | 有     | **是**   |
| `delay`       | 等待一个有界毫秒数，供 terminal 轮询输出时使用                      | 无     | **是**   |

> `run_command` 用于短测试、构建、一次性脚本。长时间测试、watch、开发服务器、REPL 或需要反复观察输出的命令应使用 `terminal_open` / `terminal_send`，再配合 `terminal_send.delayMs` 或独立 `delay` 和 `terminal_read` 轮询。
>
> 参数必须区分 `mode: "process"`（`executable + args[]`，默认优先）和 `mode: "shell"`（命令字符串，支持管道/重定向但风险更高）。不能把两者混成一个无法可靠审查的字符串。
>
> 模型可见结果以 stdout 为正文，非空 stderr 放在 `[stderr]` 后；只有非零 exit、signal 或截断时追加状态尾注。Git 工具沿用同一 stream 形式，空成功结果返回简短完成提示。
>
> **安全边界说明**：MVP 只能保证命令的初始 `cwd` 位于工作区，不能仅靠字符串检查阻止 shell 命令、脚本或子进程访问工作区外资源。若要提供真正的主机级隔离，必须引入容器/OS sandbox；MVP 不承诺该能力。因此 `run_command` 与 PTY 在 Auto/Yolo 下都属于用户主动接受的主机执行风险。

#### 2.2.4 终端类（persistent PTY）

长生命周期的双向伪终端，**Agent 与人类共享同一个终端流**——人可以观察、也可以在同一个 PTY 上输入。

| 工具                                   | 作用                              | 副作用 | `reason` |
| -------------------------------------- | --------------------------------- | ------ | -------- |
| `terminal_open(cwd, opts)`             | 打开新终端，返回 `terminalId`     | 有     | **是**   |
| `terminal_send(id, text, delayMs?)`    | 向终端写入，可在成功后有界等待    | 有     | **是**   |
| `terminal_read(id, {cursor?, lines?})` | 读最近 N 行或指定 cursor 后的输出 | 无     | **是**   |
| `terminal_list()`                      | 列出所有打开的终端句柄            | 无     | **是**   |
| `terminal_close(id)`                   | 关闭终端                          | 有     | **是**   |
| `terminal_resize(id, cols, rows)`      | 调整终端尺寸                      | 无     | **是**   |

约定：

- `terminal_read` 返回给 **LLM** 的内容是**去 ANSI 的纯文本**（便于模型理解）。
- `terminal_read` 不重复返回 `terminalId`，但始终追加下一次增量读取需要的 `cursor`；只有截断时追加 `truncated/totalBytes`。`terminal_open` 仍返回后续调用必需的 ID。
- **UI** 上人类看到的终端流是**原始带色流**。两者订阅同一 PTY，渲染层不同。
- 与 `run_command` 并存：一次性命令用前者；长跑服务/交互式 REPL/实时观察用 terminal。`terminal_send.delayMs` 在输入成功后等待最多 60 秒，便于紧随其后的 `terminal_read` 读取增量输出；等待期间取消不会撤回已经写入 PTY 的输入。独立 `delay` 继续用于纯等待。
- 终端归属于会话而不是单次 run：中断 run 不自动关闭终端；会话关闭或应用退出时必须清理。

### 2.3 LLM Provider 适配

#### 2.3.1 多 Provider 支持

必须支持接入多家模型供应商。所有实现直接满足同一个扁平 `ModelProvider.compile/stream + compileCompact/compact` 接口：Provider 自己拥有 canonical history 编译、鉴权/HTTP/SDK、stream 解码、reasoning、usage、continuation 与压缩 checkpoint。不能把某个 SDK 的消息类型当成 Core 的公共消息接口，也不引入 BaseProvider、协议方言继承层或任意 capability 组合。

生产路径实现互不继承的 `DeepSeekProvider`、`GenericChatCompletionsProvider`、`GenericResponsesProvider` 与 `GenericAnthropicProvider`。三种通用兜底分别对应 Chat Completions、Responses 和 Anthropic API style；Google 和其他具体厂商按实际使用需求分别实现，只共享 HTTP/SSE、bounds、tool-call 拼接等纯函数。

模型目录查询保持独立服务。OpenAI-compatible API 使用 Bearer `GET /models`，Anthropic 使用 `x-api-key`、版本 header 和有界分页 `GET /models`。目录解析只能采用协议明确返回的字段：Anthropic 的 `max_input_tokens/max_tokens` 归一化为模型容量；OpenAI 与 DeepSeek 的标准列表当前只保证模型身份信息，不能臆测容量。设置页合并 Provider 返回、应用内置模型资料和已保存覆盖；不得抓取 Provider 文档 HTML 推断运行时能力。Provider 编辑页在底部以模型列表展示每个模型的“最大上下文、压缩阈值、最大输出长度”，目录没有返回的数值必须自动填入应用默认值而不是显示空配置。

模型能力采用 `用户覆盖 > Provider 明确返回 > 内置资料 > 保守默认值`。未知模型默认按 256K 上下文和 65,536 Token 最大输出管理；上下文不足时收窄输出上限并至少保留 1,024 Token prompt budget。压缩阈值默认为可用 prompt budget 的 80%，并明确标记“能力未知”。Provider 模型配置区必须使用可筛选的穿梭框维护按 Provider 持久化的 `enabledModelIds`；只有启用模型能进入主模型、Composer、自动审批和未来 Swarm 模型池的可选项，主模型非空时必须属于启用池。穿梭框右侧同时决定下方 Token 配置行。启用池不进入模型能力覆盖或 Provider revision，但运行 route 必须在开始时确认所选模型仍已启用。新安装不写入虚构模型 ID；未配置 Provider 可以暂时没有主模型和启用模型，此时禁止启动 Run。用户首次填写或替换 API Key 后，Provider 表单自动保存并立即刷新模型目录；其余 Provider 合法修改也在短暂防抖后自动保存，不要求手动点击保存。AppConfig v14 的 `modelConfigurationIds` 原样迁移为启用池。自动补齐的模型值不固化为用户覆盖，因此修改全局默认值会同步到仍使用默认能力的模型；手工修改过的三项配置按模型保存并随 route revision 冻结。模型目录请求失败时保留上次成功缓存和当前手工配置。对话 Composer 的 Provider/model route 必须来自当前 Session 或新对话草稿，不能复用 Provider 设置页当前正在编辑的卡片；已停用的历史 Session 模型可以显示为当前值，但必须先改选启用模型才能再次发送。

运行限制页采用带分节线的单列布局，百分比配置必须同时显示数值和 `%` 单位。合法修改在短暂防抖后自动保存，页面顶部保留立即保存/失败重试按钮；自动保存不能覆盖保存请求期间产生的更新。

token 预算通过可替换估算器计算。支持 Provider tokenizer、保守估算和用户自定义 `bytesPerToken`；自定义值按 Provider/模型保存。估算只负责调用前硬预算与输出规划，所有工具仍必须执行不可关闭的字节、行数/结果数硬上限。Provider 返回的真实 usage 既用于记录，也是在响应安全边界决定是否进入下一次 compaction 的唯一占用依据；它仍不能替代事前硬边界。

#### 2.3.2 Reasoning（推理过程）适配

不同供应商的「思考过程」格式各异，是适配中最难、最 provider-specific 的部分：

| Provider      | reasoning 形态                                            | 明文/加密                  | 回传要求                                                                |
| ------------- | --------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| **DeepSeek**  | `reasoning_content` 字段                                  | 明文                       | 无工具调用时可省略；发生工具调用后必须按协议回传                        |
| **智谱 GLM**  | Provider-specific reasoning 字段                          | 依模型协议                 | 独立适配并用契约测试确认，不能仅因字段同名复用 DeepSeek 假设            |
| **Anthropic** | 有序 `thinking` / `redacted_thinking` block + `signature` | 明文摘要 + 不透明签名/密文 | 工具链路中必须保留完整 block、顺序与不透明字段，不得筛掉 redacted block |
| **OpenAI**    | Responses API reasoning output items                      | 摘要 + 不透明状态          | 固定本地无状态，完整回传 output items，不使用服务端 response cursor     |

需求：抽象统一的 **Provider Continuation Envelope**，但不统一 envelope 内部的 CoT 或 provider-native 数据结构。每个完成的 assistant turn 可以同时保存：

- `normalizedReasoningText`：只包含非加密、应用标准化后的可读 reasoning 文本或摘要，用于 UI、导出和通用审计；允许为空，不能用于重建签名、密文、item id 或原始 block 顺序。
- `providerContinuation`：包含 `schemaVersion/providerType/format/data` 的版本化 envelope。`data` 原样保留该 Provider 继续请求所需的有序 provider-native items、签名、密文、cursor 或 response id；Agent Core 和 Renderer 只搬运，不解释、不修改。

Responses 请求必须固定 `store = false` 并回传 encrypted reasoning items；Anthropic 所有非 off 思考档位必须使用 adaptive thinking 与对应 effort，off 不发送 thinking 参数。Structured output 契约必须携带实际 JSON Schema；Responses 与 Anthropic 使用原生 schema 字段，Chat 兜底实现允许降级为 JSON object mode，但 Application 的本地 schema 校验不能省略。

完整原始 Provider request/response 和 stream events 只属于显式开启的 trace。Message 只保存 canonical message parts、可读 reasoning 投影，以及继续协议所需的最小 opaque state。

#### 2.3.3 Canonical History 与 ModelProvider

持久化历史使用应用自己的 `MessageRecord`：`kind` 表达内部语义，`parts` 是有序、封闭的 canonical payload。普通 V1 message part 只包含 `text`、`tool_call` 和 `tool_result`；`compact_summary` 另允许单个版本化 `provider_compact` part，以 opaque envelope 保存对应 Provider 的原生 checkpoint 或合成文本摘要。不保存 Provider DTO 派生出来的 `role/content/toolCalls/toolCallId`，也不把任一 SDK 类型暴露给 Persistence、Renderer 或 Agent Core。

`MessageHistoryCompiler` 只按 `seq/inHistory/compact boundary` 选择历史、校验 `kind/parts` 约束和 tool call/result 配对，并生成 `CompiledCanonicalHistory`。随后由 `ModelRouteSnapshot.providerType` 指定的 `ModelProvider.compile()` 消费**完整有序历史**，执行可能是一对多、多对一的协议编译：

- Chat Completions 可把 assistant `tool_call` parts 编译为 `assistant.tool_calls[]`，把每个 result 编译为独立的 `role = 'tool'` message。
- Responses API 可把同一链路编译为 `function_call` / `function_call_output` items。
- Anthropic Messages 可把相邻 tool results 合并到一个 `user` message，并将 `tool_result` blocks 放在其他 content blocks 前面。

因此 wire `role` 只属于特定协议，不是数据库字段；一条 `MessageRecord` 也不保证对应一条 Provider message/item。Provider 的 `stream()` 把响应解码为 normalized events，并在完成时直接返回 canonical assistant parts、可读 reasoning 投影、标准化 usage 和 continuation envelope；Application Service 为其补齐 Session/Message 字段后一次性持久化完整 turn。

同一个扁平 `ModelProvider` 还必须实现 `compileCompact/compact`。压缩编排消息是 wire input 的最后一项；Responses 实现调用原生 `POST /responses/compact` 并保存返回 output items，Chat Completions、DeepSeek 与 Anthropic 实现无工具的合成文本摘要。Synthetic compact 只接受 `finishReason = completed`；截断响应最多从同一完整 source history 以更短的摘要要求纠正重试一次，过滤、拒绝和未知终止原因直接失败。网络、timeout、rate-limit 和 5xx 最多自动重试两次并遵守有界 `Retry-After`，完整但非法的响应最多重试一次，任一压缩最多三次 Provider call；鉴权、计费、输入超窗和用户取消不得自动重试。Core 只验证 `ProviderCompactEnvelope` 的版本、route 兼容性和 JSON bounds，不解释 opaque data。Provider compaction 成功后才以单个事务停用旧 active history、追加 fresh harness 与隐藏 `compact_summary`；失败不得破坏旧 epoch，并通过既有 Renderer message 通道显示“压缩失败，请重试或打开新对话。”。

Tool Result 的 canonical renderer 固定为：单 TextPart 原样、单 JsonPart 只序列化 value、多 part 按顺序换行连接；不能把 `type/json/value` 外壳或内部 `status/content/truncated/totalBytes` 发给模型。Chat Completions、Responses 和 Anthropic 只负责映射 wire 字段与 call ID，Anthropic 错误结果继续设置 `is_error = true`。

`providerId` 表示用户保存的配置实例，`providerType` 表示代码实现；同一供应商的不同 API surface 必须使用不同 type。协议差异依据：[OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)。

### 2.4 会话与工作区

- 一个工作区（workspace）= 一个本地目录。
- Project 是 backend-owned 的持久化 workspace 注册记录，使用稳定 `projectId` 和规范化绝对路径。移动目录后通过重新关联更新 Project path，不改写 Session identity。设置页以列表管理全部 Project；任意空闲 Project 都可在二次确认后从应用移除。移除会删除应用中归属它的 Sessions/Messages/FileChanges/Subagent 记录并释放运行资源，绝不删除 workspace 目录或项目文件；Trace 日志仍由日志设置独立管理。若移除当前 Project，renderer 必须稳定回退到下一个可用 Project 及其最近的活跃 Session。
- Session 是持久化对话实体，绑定一个 `projectId`、当前模型选择与权限模式；UI 中的“对话”是 Session 的展示名称，不存在独立 Conversation 领域记录或 `conversationId -> sessionId` 映射。
- SQLite 持久化 schema migrations、Projects、Session 元数据、完整 Message history 和有界 FileChanges。Goal/Plan 属于 Session 元数据；完整 assistant/tool/harness 内容统一表示为 Message。Renderer 只保存 backend public records 的副本，不得单独创建已提交消息。
- Database migrations 必须按版本前向执行，在单个 transaction 内提交 schema/data change 和 migration record；已应用文件 checksum 改变或数据库版本高于当前应用时明确拒绝打开，不静默猜测兼容。
- 每个 `MessageRecord` 保存内部 `kind` 与有序 `parts`。`kind` 用于区分真实用户输入、编排消息、runtime context、harness、assistant、tool result、compact summary 和 conversation transcript；它不是 Provider wire role。V1 shared schema 必须按 `kind` 校验 part 组合：用户输入是非空 text；assistant turn 只含 text/tool-call 且记录实际 route；tool result record 只含一个 terminal tool-result，并引用历史中未完成的 call；compact summary 是 legacy text 或单个 provider-compact；conversation transcript 是隐藏 text parts 并绑定目标 route。新 tool result 必须带 `resultProjection = model-content.v1`；active history 中缺少 marker 的旧结果必须在 Provider 网络调用和计费前报 `LEGACY_TOOL_RESULT_UNSUPPORTED`，provider-transfer transcript 对它实际纳入的任何 legacy result 同样 fail closed，但旧会话仍可查看、导出、删除，也不改写 SQLite 历史。
- 每个 `MessageRecord` 必须保存 `visibility = visible | hidden | superseded`，并可用 `turnId` 关联同一轮 context、user、assistant、tool 和 interjection。`visibility` 控制当前分支展示；`inHistory` 只控制模型上下文。Compact 只修改 `inHistory`，不得隐藏历史消息；rewind 将退出当前分支的记录标为 `superseded` 且 `inHistory = false`，不得物理删除。
- Message metadata 是按 `kind` 校验的 application-owned typed annotations，可包含 attachment provenance、prompt id/version/hash、标准化 usage、tool/approval/compact boundary、conversation transcript hash 和 reasoning projection 状态。Metadata 可以来源于 Provider，但删除它不能破坏下一次 Provider 请求；assistant continuation 必须放入 `providerContinuation`，compact 的协议关键状态必须放入 `provider_compact.payload`。
- SQLite 不保存 OpenAI、DeepSeek、Anthropic 或其他 Provider SDK 的请求 DTO。发起请求时，backend 从 `inHistory = true` 的完整 `MessageRecord` 生成 `CompiledCanonicalHistory`，再由当前 `ModelProvider.compile()` 整段编译 wire DTO；Persistence layer 不依赖 Provider。
- Draft 和 draft attachments 是 renderer UI 状态，不进入 backend 或 SQLite，也不要求在切换 Session、renderer reload 或应用重启后保留。
- 每次用户提交形成 backend memory 中的 Active Run；它在开始时冻结包含 `providerType/providerId/model/reasoning/config revision` 的实际 `ModelRouteSnapshot` 和权限模式，但不单独落盘。完成的 assistant message 记录实际 route；Session 的模型/模式修改只影响后续 Run。
- Active Run、stream delta、pending approval、未完成 tool batch、writer lease 和 PTY/process 都是 backend runtime state，不进入 SQLite。
- Final-answer 边界到达的 live interjection 可转为 renderer carryover，并以稳定 request id 按 FIFO 启动后续 Run。某项启动失败时必须移除队列和 overlay、显示可自动消失的 warning、继续下一项且解除输入锁；不提供 carryover 重试或持久队列。
- 同一 canonical workspace 同时最多一个非只读 writer run；`auto`、`confirm`、`yolo` 从 run 启动覆盖 provider、工具、等待审批、interjection continuation 和 cancelling。若不可中止的副作用工具在 cancelled/timeout 结果之后仍在执行，writer 必须继续持有到其底层 Promise settle。writer 数固定为 1，不提供配置。
- `readonly` run 不获取 writer，可与 writer 和其他 readonly run 并行；不同 workspace 可各自拥有 writer。同 workspace 的第二个非只读 run 不排队，返回带 owner Session/Run 的结构化冲突。
- completed、failed、cancelled、异常、session close 和 app dispose 都必须走幂等释放路径。全局 run slot 在 terminal run status 对 renderer 可见前释放；writer 在没有残留副作用时同步释放，有不可中止副作用时延迟到其真正 settle，禁止为满足 UI 终态而提前开放第二个 writer。
- 文件工具必须约束在工作区边界内（规范化路径、真实路径与符号链接逃逸检测）。
- Session canonical history 必须以完整 Message 持久化。应用重启后按 `inHistory = true` 和 `seq` 重建 `CompiledCanonicalHistory`，再由当前 route 的 ModelProvider 生成请求；compact 通过版本化 checkpoint message 和显式 `inHistory` 变更替代旧前缀。若 `providerType + providerId + model + endpoint + providerConfigRevision` 与 active assistant/compact/transcript anchor 不兼容，下一次 Run 必须在插入用户消息前把 SQLite 完整非 superseded 分支投影成 `zch-conversation-markdown`，以 fresh harness + hidden `conversation_transcript` 建立新 epoch；迁移预检或 commit 失败时旧 epoch 原样保留。Fork/rewind 重建 active branch 时必须把 `compact_summary.replacesThroughSeq` 与 `conversation_transcript.sourceThroughSeq` 作为同等 epoch boundary，并在 fork 连续重编号时重映射该边界。
- 只有当前分支中可见的原始用户消息支持重试和编辑。重试保留该用户消息及本轮 context、supersede 后续分支并复用原记录运行，不能插入重复 user message；Assistant 和其他 message kind 必须被 `run:retry` 拒绝。编辑 supersede 该用户整轮及后续，将原文和附件引用恢复到 composer，不自动发送。
- 仅回退可以作用于用户或 Assistant：用户边界移除该用户整轮及之后记录，Assistant 边界保留对应用户消息并从 Assistant 开始移除。每次回退清除当前 Goal/Plan，并在跨 compact 或 conversation transcript epoch 时重建保留前缀的有效 history。文件、终端和 MCP/外部工具副作用不回滚，FileChange 审计继续保留，UI 操作前必须提示。
- Assistant stream delta 只保存在 backend memory；Provider turn 完成后才插入 Message。包含 tool calls 的 assistant turn 必须等每个 call 都有 terminal result 后，与对应 tool messages 在同一 transaction 写入，数据库不得保存协议半截。
- 应用崩溃可以丢失尚未完成的 assistant text/reasoning、tool batch 和 Active Run，不保存 partial message，也不生成持久化 interrupted Run。最后一条已提交 user message 可以暂时没有 assistant reply。
- 如果副作用工具已经修改 workspace、但应用在完整 tool batch transaction 前崩溃，文件变化可以保留而 tool messages 丢失；系统以下一次读取到的实际 workspace 为准。V2.1 不承诺文件系统与消息数据库之间的 crash-atomic journal。
- 文件写入工具的模型可见结果是一行成功摘要。如果副作用已成功但 `file_changes` 持久化失败，摘要尾注必须如实保留 `mutationSucceeded = true`、`CHANGE_HISTORY_PERSIST_FAILED` 和 `revertAvailable = false`；不得把已发生的文件操作报成未发生或自动重试。
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
- **生命周期**：主进程管理 generic MCP 的 handshake、目录边界、超时、取消、draining、有限指数退避重启、stderr tail 和应用退出清理。ProjectModel/Serena/code intelligence 当前整体关闭，生产 runtime 不启动 Serena，Provider request 与模型可见工具提示不得包含 `project_*` 或 `code_*`，普通 Session 不读取、创建或改写 `.zch`。
- **秘密环境变量**：`env` 仅存非敏感值；`envFromHost` 只保存子进程变量名到主机变量名的映射。主机值只在主进程启动子进程时解析，不进入 renderer、public config、trace 或日志。

### 2.7 Read-only Subagent

主 Agent 可以通过默认关闭的 `subagent_run` Tool 委派一个独立只读调查任务：

- 输入只包含 `name` 和 `task`。`name` trim 后为 1–64 个 Unicode 字符，拒绝控制/格式字符和危险对象键；`task` trim 后为 1–32,768 个字符。
- `task` 必须自包含，并作为 child Session 的普通 canonical `user_input`；child 不复制父 Session history，也不接受特殊任务包装。
- Tool description 要求 child 使用只读工具调查，并把结论直接放在最终 assistant response 中，不把答案写入文件。同一 Tool batch 可以包含多个 `subagent_run`，并按普通 parallel Tool 调度。
- 同一 parallel 段先按 call 顺序逐个完成权限检查和审批，始终最多暴露一个 `pendingApproval`；准备完成后并发执行，结果仍按原 call 顺序进入事件和 canonical history。
- child 精确继承父 Run 已冻结的 main/compression route，配置热变更不改变正在运行的 Provider、模型、reasoning 或 credential binding。
- child 直接读取父 Run 的 canonical workspace；每次 Tool 读取看到当时的实时文件与 Git 状态，不创建文件副本、临时 repository、Git bundle 或 refs。
- 模型可见且 executor 可执行的 allowlist 仅为 `read_file/list_dir/glob/grep`、`read_skill`、有界 `delay` 和四个 Git read Tool。非 Git workspace 由 Git Tool 返回普通错误；写入、process、terminal、network、MCP、ProjectModel、code intelligence、Goal/Plan 和递归 Agent Tool 均不提供。
- child 复用唯一 Session/Run/Provider loop，Session 固定 readonly 且对普通 bootstrap、分页、搜索、导出和 Renderer events 隐藏。父 Session/Project 删除级联清理；父归档继续保留。
- child 沿用全局 `maxStepsPerRun`（`0` 表示不限）、模型最大输出和通用 Tool context/output 限制，不增加专属 step/token/result budget。
- 内部成功结果保存 `results[name]` 最终文本，以及耗时、实际 Provider/model、标准化 usage 和输出上限截断标记；进入父模型历史时只投影 `results[name]` 文本，Provider/model/usage 留在内部 meta。不得返回 reasoning、endpoint、凭据、child Session ID、trace 路径或临时绝对路径。
- `workerTimeoutMs` 默认 30 分钟、可配置 1 分钟至 24 小时。父 Run 取消、timeout、Provider failure 和应用退出都必须中断 child 并清理并发 slot；全局并发上限为 1 时启动前明确拒绝。
- 相同 parent Session/Run/call 与参数 hash 可复用已完成结果；参数不同返回冲突。应用重启将遗留 active execution 标记为 `interrupted`，不得自动重试或恢复 stream。

当前阶段已经包含模型池的配置 UI 与 backend foundation，但不改变上述 `subagent_run` 执行路径。Swarm、模型池生产执行接入、递归委派、Serena/code intelligence、自定义 child 工具列表或详细 child Session UI 仍未实现；后续边界见 [`subagent-swarm-roadmap.md`](./subagent-swarm-roadmap.md)。

### 2.8 Model Pool 配置与 backend foundation

- AppConfig v16 首次在根配置加入 `modelPool`，v17 将 entry reasoning 扩展为统一六档，v18 删除重复 capability；当前 v19 保存最多 1,000 个命名 entry，并删除从未执行的 per-route `maxParallel`。该上限仅作为 IPC/config 异常负载边界，不承担并发或 Agent 数量控制；entry 只引用现有 Provider/model/reasoning。调度能力固定为 `light | standard | strong`，唯一来源是对应 Provider 的 `modelOverrides[model].capability`。API key、credential reference 与并发配额不进入 entry。
- 完整模型池使用单个 `config:set(model-pool)` 原子保存。所有 enabled entry 引用的 Provider 必须由唯一且精确的 expected revision 列表覆盖，并在写盘前通过 Provider 存在、模型启用、能力标注、安全 endpoint、模型 profile 和当前凭据绑定校验；任一失败时不得部分写入。disabled entry 只要求结构与规范化 ID 唯一，可保留失效引用供未来 UI 修复。
- Agents 设置页提供模型池独立小节，以 Naive UI Transfer/Tree 按 `Provider → model → reasoning` 展示候选；每个 reasoning 叶节点是一条互不替代的精确 route，同一模型的 `high`、`max` 可以同时入池，且不做自动升降档。顶部“最低思考等级”只过滤左侧候选，低于门槛但已经入池的 route 仍在右侧显示并提示，不改写配置。能力等级只读展示对应 Provider 模型标注；模型池不配置并发，内部 entry ID、顺序和 enabled 状态不作为常规表单暴露。Renderer 使用独立 Pinia store 持有草稿、已保存快照和保存状态；整组修改显式原子保存，不复用 Provider 表单草稿。Provider 编辑触发后端自动禁用时，干净模型池草稿同步回填；未保存草稿则保留并提示重新检查。
- 删除 Provider、移除 entry 引用的启用模型、移除 capability annotation、reasoning annotation 变为不兼容或显式清除凭据时，在同一配置写入中把受影响 entry 置为 disabled，保留顺序和引用；恢复配置不会自动启用。启动/reload 会修复手写的 enabled 静态不兼容或无能力标注引用，但环境凭据暂时缺失不会改写持久配置。
- 纯 allocator 让所有 `actualCapability >= requiredCapability` 的模型参与分配，并按声明顺序先 round-robin `Provider + model`、再轮询该模型的精确 reasoning route；选择更多 reasoning 叶节点不会提高模型权重，每次调用从头开始。符合要求的模型少于 Agent 数时自然重复使用；缺少能力时在 route/credential 解析前整体失败。route freezer 读取单个 PublicConfig 快照，生成包含全部 enabled entry 及 Provider revision 的顺序敏感 SHA-256 digest，并对实际选择的唯一 entry 各解析一次 main/compression route。
- prepared plan 是 backend-private 内存结果，包含 `ResolvedModelRoute` 与 API key；safe snapshot v2 只包含 digest、需求/entry/能力、Provider/model/reasoning/revision 与安全 route snapshot。revision 竞态或已选 entry 不可用会使整个 freeze 失败，不会跳过、切换 Provider 或重新分配。
- `subagents.maxAgentsPerSwarm` 默认 10、范围 1–32，限制未来单个 Swarm Job 创建的 child Agent 总数；`limits.maxConcurrentRuns` 继续独立限制全应用同时 active 的 Run。当前阶段不修改 Headless v4、Runtime Identity v4、`SubagentExecutionPort.runOne` 或 SQLite Job 状态；这些属于 S3 后续接入或 S4。

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

自动审批路由是独立的全局配置，不属于 Provider 卡片或 Provider 保存事务。它引用一个已配置 Provider 来复用协议、endpoint 和凭据，并独立选择模型；保存任意 Provider 不得隐式覆盖审批路由。若所引用 Provider 不存在或凭据不可用，运行时只记录诊断并回退人工审批。

自动审批请求只有规则提示是稳定前缀，工具、参数、路径和 policy signals 都是动态尾部。Provider 的最小可缓存前缀、路由策略和显式 cache-control 各不相同，因此不能承诺审批调用命中缓存，也不得为追求命中率填充无意义 prompt；统计必须如实记录 Provider usage。

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
- Durable command 在数据库 commit 后同时返回提交结果并发布同内容事件；renderer 对回包和事件按 cursor/revision 幂等合并。后端自主提交依赖事件通知，不定时轮询；bootstrap、分页/搜索、按需加载和缺口重同步才使用 query。
- 搜索通过本地后端查询 Session 标题，以及 `kind = 'user_input'/'assistant_turn'` records 中 `type = 'text'` 的 parts；不把 orchestrator/harness/runtime context 当成用户消息，也不检索 tool call 参数、tool result/JSON parts、工作区文件、reasoning、continuation 或 trace，更不访问 Provider。
- 新建对话时只建立 renderer draft，不创建空 Session；首次发送以 `run:start new_session` 原子创建 Session、首轮 context/user records 并启动 Active Run。Session 创建前终端不可用。Session/Run ID 不作为常驻产品信息展示。
- 侧栏的删除操作归档 Session；设置页提供分页的已归档对话列表和恢复入口。永久删除只允许 archived、idle 且没有 fork 子 Session 的记录，删除 Session/Message/FileChange durable 数据但不得改动 workspace 文件；Trace capture 继续由日志设置独立管理。
- 普通 Session 提供单向 Markdown Conversation 导出：用户确认风险后，由 backend 从完整 canonical log 生成 `zch-conversation-markdown` 并原子保存。它恢复用户/Assistant/明文 reasoning、编排、tool call/result 与附件元数据，但排除 system/runtime/AGENTS/selected context、控制命令/replay、compact、generated transcript、Provider continuation 和加密 reasoning。Markdown 导入仍明确不可用；Trace transcript 查看/导出保持独立。
- 正式 UI 不得使用硬编码项目、对话或工具活动作为占位数据。
- 后台异步故障使用版本化、脱敏、有界的 `app:notification`；preload 在 renderer 挂载前缓存最多 64 条。Renderer 的操作 warning/error 使用 `NMessage` 顶部通知，不写入 Timeline 或 durable replica：warning 10 秒自动消失，error 需手动关闭，最多同时 5 条并排队，按 code/Session/message 去重。后台 Session 通知显示对话标题但不得切换当前选择；风险确认、隐私告知、字段校验和持续状态留在所属界面。

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
- `file_changes` 不限制记录条数，只受全应用可配置的 `beforeContent + diff` UTF-8 总字节预算约束（默认 100 MB）；200 仅是单页查询上限。单条恢复 payload 已超过当前 Run 冻结预算时，文件工具必须在副作用前拒绝；Retention 只会让最旧单项丧失 Diff/revert 能力，不能删除 Message 或改动 workspace。

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

### 4.7 Agents 设置

- Agents 设置页提供 Subagent 功能开关、worker timeout 和单次 Swarm Agent 总数上限，沿用设置页 600 ms 自动保存及显式立即保存入口。
- 开关默认关闭；timeout 默认 30 分钟，输入以分钟展示并限制为 1–1,440；`maxAgentsPerSwarm` 默认 10、范围 1–32，从下一次 `/swarm` Run 生效。
- 页面必须提示启用后会产生额外 Provider 请求和费用，并展示当前全局 `maxConcurrentRuns`；并发为 1 时说明无法运行嵌套 Agent。
- 同页模型池小节显式原子保存完整 entry 数组；以 `Provider → model → reasoning` 穿梭树选择精确 route，并只读展示 Provider 模型的能力标注。模型池本身不配置并发或 Agent 数量。
- 当前不提供 child 工具列表、详细子任务页或隐藏 Session 入口；模型池仍未接入生产 Subagent 执行。

---

## 5. 可观测性 · 全周期日志

### 5.1 形态

- 每次日志启用或 Durable Session 恢复创建一个独立 **JSONL capture 文件**，存于 Electron `userData/traces/`；同一 Session 可以关联多个 capture，不能把 `traceId` 等同于 `sessionId`。
- 每个 capture 使用唯一 `traceId`、以独占新文件创建且 `seq` 从 1 开始；旧 capture 不追加、不改名、不回填。
- 日志是**调试功能**，配置项 `logging.enabled` 默认 `false`；只有用户显式开启后才创建 trace。
- 保存日志开关后必须通知所有已加载 Session：idle Session 立即启停；active Run 在该 Run 完整结束后应用最终保存值。运行中开启不记录当前 Run，运行中关闭仍记录当前 Run 的终态；未加载 Session 在下次 restore 时按当前配置创建 capture。
- `TraceCaptureStatus` 必须公开 `configuredEnabled` 与 `disabled | pending | active | degraded` 状态，并可携带当前 `traceId` 或有界 warning；状态变化通过有序 Session event 同步 renderer。
- capture 创建或写入失败必须降级为 Null logger，不得让模型、工具或 Terminal 操作失败；不完整文件留作诊断，下一 Run 开始前重试创建新 capture。
- 开启后采用完整记录模式，不做上下文脱敏或摘要化：完整保存规范化消息、实际 Provider 请求体、原始流事件、聚合响应、reasoning/continuation state、工具参数与结果、审批事件和配置快照。
- “完整”以 Agent 实际可见数据为边界：工具因输出上限而未进入 Agent 的丢弃字节记录 `totalBytes/truncated/discardedHash`，不要求无限落盘；进入模型上下文的内容必须逐字保存。
- 不记录请求传输层凭据，例如 API Key、Authorization header 和 safeStorage 密文；这些信息不属于模型上下文，也不是回放所需数据。
- 开启时必须明确提示日志可能包含源代码、用户输入、模型推理、工具输出以及工作区中被读取的凭据，并支持保留天数/总大小上限。
- 完整 trace 必须可规范化为只读 `zch-session-transcript`：按 run 展示用户/Assistant/明文 reasoning、内部编排、工具与审批、Provider上下文、Plan、interjection、usage、terminal和生命周期。该格式不可导入或重放；每次 Electron 导出前必须警告，导出内容不做敏感信息扫描或脱敏，用户负责本地保存和后续分享。
- Transcript 不输出 provider wire request/raw response/provider continuation、流式重复分片、工具schema、加密/opaque reasoning或多模态原始载荷；中断且没有final message的明文delta标为partial，多模态只保留类型/MIME/已知大小占位。
- 产品 Session 状态使用 SQLite 持久化；Trace 继续按 capture 分段保存，并通过 `sessionId` 归属同一 Session，不能因数据库存在而降低 trace 保真度。清理活动日志时必须使用真实 active `traceId`，不能把 `sessionId` 当作文件标识。

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
session.end     { reason, ts }
```

### 5.3 保真度要求

- 每条事件包含 `schemaVersion + seq + eventId`，异步流事件可用 `parentId/callId/runId` 建立因果关系。
- **离线回放**：不访问模型、不执行工具，按原始流事件和已记录结果确定性重现 UI、消息历史和 Agent 状态机。
- **请求检查**：保留最终 Provider 请求体用于离线检查、导出和 cache 行为分析；不使用当前凭据在线重放，也不从 trace 创建 Session 分叉。
- **工具重放**默认只注入已记录结果；真实重新执行副作用工具必须是独立显式操作。
- 保存 Provider 返回的完整 usage，包括可用时的 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、输入/输出 token；同时记录 TTFT、总延迟、请求字节数和稳定前缀 hash，供 KV cache 分析。标准化 `cacheMissTokens` 表示未由缓存提供的输入：协议只返回总输入和 cached tokens 时按差值计算，未返回 cached 指标时把输入视为 miss；Anthropic 按 uncached input 加 cache-creation input 计算。原始 usage 必须保留以便审计。
- DeepSeek 流式调用必须请求最终 usage chunk；cache 命中以 Provider 返回字段为准，不能仅根据本地消息前缀推断。

### 5.4 Headless 运行输出

- 内部 Headless host 必须复用桌面端唯一 Agent Runtime 组装入口，固定 Yolo 且不增加、删除或替换模型可见工具。
- Headless config v4 必须支持与 Desktop 相同的 `subagents.enabled/workerTimeoutMs`，并迁移 v1–v3 输入；Runtime Identity v4 记录开关和 timeout，child execution 仍使用相同 live workspace、隐藏 Session、Tool profile 和 usage 归属。
- stdout 只允许版本化 JSONL；host 诊断写 stderr；最终 `result.json` 原子写入 workspace 外的 artifacts 目录。
- Provider 凭据只能由受信任配置声明的环境变量名称解析，凭据值不得进入配置回包、JSONL、trace、patch 或子进程环境。
- result 必须记录 session/run id、终态、未完成原因、wall time、最终回复、usage、工具统计、trace 和 patch 路径。`completed` 只表示 Agent run 正常结束，不替代外部业务验收。
- Plan 自动批准必须在前一 run 完全 settle 后，通过有版本的 harness 消息追加到历史和 trace；不得伪装成用户消息。Goal blocked 或自动批准达到上限返回 `needs_human_input`。
- timeout、SIGINT 和 SIGTERM 必须进入共享 interrupt/disposer；补丁采集不得修改 workspace 的真实 Git index。
- 每个 Headless artifact 必须包含 runtime identity；source commit、task/config digest、provider/model、核心预算、prompt/tool hash 或 capability 不同的结果不得直接比较。
- Electron/Headless parity 必须通过共享 trajectory 比较 Provider messages、稳定 prompt layer、工具定义与调用、compact/Plan/MCP 行为和 patch；只允许逐字段声明的 host 差异，禁止宽泛 snapshot 忽略。

---

## 6. 插件系统（生命周期钩子）

### 6.1 目标

主要为**插件扩展**服务：允许第三方/未来扩展注册工具、订阅生命周期事件、扩展 Provider。

### 6.2 MVP 范围

**只埋「事件总线 + 钩子点」**，不做插件加载器、不做插件市场。

### 6.3 钩子点（初步）

| 钩子             | 时机                                         | 可阻断？ |
| ---------------- | -------------------------------------------- | -------- |
| `onSessionStart` | 会话开始                                     | 否       |
| `onSessionEnd`   | 会话结束                                     | 否       |
| `beforeLLMCall`  | LLM 调用前，只读观察不含凭据的已编译请求副本 | 否       |
| `afterLLMCall`   | LLM 返回后                                   | 否       |
| `beforeToolCall` | 工具执行前（可阻断执行）                     | **是**   |
| `afterToolCall`  | 工具执行后                                   | 否       |
| `beforeApproval` | 审批判定前                                   | 否       |

> 阻断型钩子返回 `{ allow: false, reason }` 可拦截工具执行。

---

## 7. 非功能需求

| 维度         | 要求                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **可中断**   | 任意 LLM 流与当前工具执行可被用户中止，不残留无主子进程；会话所属 PTY 按既定生命周期保留或关闭                                 |
| **安全**     | 文件路径硬边界 + 分层权限策略 + IPC 隔离 + safeStorage，见 §3                                                                  |
| **可扩展**   | 新增工具 = 注册一个 schema + handler；新增 Provider = 实现 `compile/stream` + factory/config type                              |
| **桌面分发** | electron-builder 打包 Windows（首要），macOS/Linux 后续                                                                        |
| **配置化**   | 模型、Provider、权限模式、调试日志开关、Skills 开关和用户策略均可配置                                                          |
| **资源有界** | 工具输出、日志大小、循环轮数、并发 run、PTY scrollback 都有上限；新安装默认最多 16 个 active run，同 workspace writer 永远为 1 |
| **失败隔离** | Provider、工具、日志失败转成结构化事件，不得因未捕获异常直接打崩主窗口                                                         |
| **契约演进** | IPC、日志、配置和 Provider Continuation Envelope 均带版本，可做向后兼容迁移                                                    |

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
- 默认关闭的只读 `subagent_run`、实时 workspace/Git 读取、隐藏 durable child Session 与取消/usage 归属
- 插件钩子点（埋点，无加载器）

**MVP 之后：**

- GLM / Google 与其他具体厂商 Provider（含各自 reasoning adapter）
- 代码库 embedding / RAG 检索
- **MCP 客户端**（stdio + Streamable HTTP，含 server 生命周期管理）
- 插件加载器
- 日志清理 / 回放可视化 GUI（MVP 先提供回放引擎和基础入口）
- 云端对话同步、跨设备历史和团队共享项目

---

## 附录 A · 术语表

- **PTY**：伪终端（pseudo-terminal），长生命周期的双向终端会话。
- **Provider Continuation Envelope**：附着在完成 assistant message 上的版本化外壳；`providerType/format` 标识解释者，`data` 保存继续多轮工具链路所需的有序不透明 Provider 状态。统一的是外壳，不是 CoT 数据结构。
- **执行不变量**：工具 schema、资源归属和 workspace 契约等调用有效性条件，不属于可审批的风险策略。
- **风险黑名单**：Auto/Confirm 下提升审批等级的危险动作规则；Yolo 明确跳过。
- **Auto Approval**：由独立小模型对动作做 safe/dangerous 二分类自动放行的能力。
- **Skill**：高度浓缩的专家指令（SKILL.md），摘要注入上下文，正文按需 read_skill 加载。
- **渐进式上下文**：先给目录（摘要便宜常驻），需要时再读全文（按需省 token）的加载策略。
- **MCP**：Model Context Protocol，连接外部工具 server 的标准协议；本项目只实现客户端。
- **Subagent Execution**：由父 Session/Run/Tool call 归属的 backend-private durable execution；复用生产 Agent loop，但 child Session 不进入普通产品查询和 Renderer。
- **Live Workspace View**：只读 child Session 直接绑定父 Run 的 canonical workspace；文件与 Git Tool 在各自读取时观察实时状态，不创建副本、checkpoint 或 refs。
