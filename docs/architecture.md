# 架构设计文档 · My Coding Agent

> 状态：实现同步版 v0.3 · 最后更新 2026-06-19
> 配套：[`requirements.md`](./requirements.md)（做什么）、[`frontend-spec.md`](./frontend-spec.md)（前端信息架构与验收）。本文档讲「怎么搭」。

---

## 1. 架构总览

### 1.1 运行边界

Electron 使用**主进程 + 渲染进程**两类 OS 进程；preload 是运行在 renderer 隔离上下文中的受控桥，不是第三类独立进程。MVP 采用**主进程编排、渲染进程展示**：Agent Runtime 先作为主进程内的独立模块运行，但通过接口隔离，后续可迁移到 `utilityProcess`，避免把 Provider/工具实现直接耦合到窗口生命周期。

```
┌──────────────────────────────────────────────────────────────────┐
│  渲染进程 (Vue 3 + TS, sandboxed)                                 │
│  ┌───────────┬───────────┬───────────┬───────────┬─────────────┐ │
│  │ Chat UI   │ 终端面板  │ Diff 预览 │ 审批面板  │ 文件树/状态 │ │
│  └───────────┴───────────┴───────────┴───────────┴─────────────┘ │
│             ▲ window.agentApi.*  (窄接口 preload 桥)              │
└─────────────┼────────────────────────────────────────────────────┘
              │ IPC
┌─────────────┼────────────────────────────────────────────────────┐
│  主进程 (Node.js, 全权限)                                        │
│  ┌─────────────────────┐    ┌──────────────────────────────────┐ │
│  │ Agent Runtime       │◄──►│   LLM Provider 层                │ │
│  │   - ReAct/Tool循环  │    │   - LLMProvider 接口             │ │
│  │   - 上下文/中断控制 │    │   - Continuation State adapter   │ │
│  └──────────┬──────────┘    │   - [MVP] DeepSeek Provider      │ │
│             │               └──────────────────────────────────┘ │
│  ┌──────────▼──────────────────────────────────────────────────┐ │
│  │   Tool Registry & Executors                                  │ │
│  │   文件类 / 检索类 / 命令类 / 终端类(node-pty)                │ │
│  └──────────┬──────────────────────────────────────────────────┘ │
│  ┌──────────▼──────────────────────────────────────────────────┐ │
│  │   权限管线 (Permission Pipeline)                             │ │
│  │   调用校验 → 模式/风险策略 → 模型/人工审批 → 执行前复核      │ │
│  └──────────┬──────────────────────────────────────────────────┘ │
│  ┌──────────▼──────────────────────────────────────────────────┐ │
│  │   基础设施                                                    │ │
│  │   Plugin EventBus / Logger(JSONL) / Config / safeStorage     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 为什么这样分
- **Agent Loop 在主进程**：它要协调 LLM 流、工具执行、权限审批，三者都依赖 Node 能力。
- **渲染进程是瘦客户端**：流式 token → UI 事件；用户输入 → IPC invoke；无业务逻辑。
- **preload 是能力白名单**：只暴露 `startRun/sendMessage/interrupt/decideApproval/...` 等逐项 API，不暴露通用 `ipcRenderer`。
- **IPC 是安全边界**：所有跨进程调用走版本化契约，并校验 sender、payload、session/resource 归属（§7）。
- **可迁移的 Runtime 边界**：MVP 不先引入额外进程复杂度，但 `AgentRuntime` 不依赖 `BrowserWindow`；UI 推送通过 `EventSink` 接口完成，为后续迁移到 `utilityProcess` 留出边界。

> 当前实现已使用冻结的 `window.agentApi` 白名单，不向 renderer 暴露通用 `ipcRenderer`。

### 1.3 当前实现状态
- P0-P4 已落地主进程安全边界、DeepSeek Agent Loop、文件权限管线、进程执行、共享 PTY、模型目录和上下文预算。
- `SessionManager` 当前仍集中承担会话生命周期、Provider 调用、工具循环、审批和事件发射；功能边界已有接口，但文件过大，后续应拆出 Agent Loop 与 Approval Manager。
- P5 Skills、完整 trace/replay GUI、MCP 和插件加载器尚未完成；Browser 明确为 Post-MVP。
- Windows x64 是当前发布与 native smoke 的主目标；macOS/Linux 尚未作为发布门禁。

---

## 2. 目录结构

```
my-coding-agent/
├── shared/                        # 主进程 / preload / renderer 共用的纯类型与 schema
│   ├── ipc-contract.ts            # 版本化 IPC 方法、事件、payload schema
│   ├── agent-events.ts            # AgentEvent 判别联合
│   └── ids.ts                     # SessionId/RunId/CallId branded types
├── electron/                      # 主进程 + preload
│   ├── main.ts                    # 入口：创建窗口、注册 IPC、装配各模块
│   ├── preload.ts                 # contextBridge 冻结的 AgentApi 白名单
│   ├── ipc/
│   │   ├── index.ts               # 注册所有 invoke handler + 事件
│   │   ├── validate-sender.ts      # sender / frame / origin 校验
│   │   └── validators.ts           # payload runtime schema 校验
│   ├── agent/
│   │   ├── session-manager.ts      # 当前 Agent Loop、会话、审批与事件编排
│   │   ├── provider.ts deepseek-provider.ts
│   │   ├── context-budget.ts model-catalog.ts
│   │   ├── tool-registry.ts permission-pipeline.ts policy-engine.ts
│   │   ├── readonly-tools.ts file-tools.ts text-patch.ts
│   │   ├── process-tools.ts terminal-tools.ts path-guard.ts
│   │   └── context-ingress.ts auto-approver.ts
│   ├── tools/types.ts              # Tool / effects / ToolResult 约定
│   ├── process/                    # run_command、输出边界和进程树终止
│   ├── terminal/                   # node-pty 池与有限 scrollback
│   ├── plugins/
│   │   ├── event-bus.ts           # 事件总线 + 钩子点（§10）
│   │   └── types.ts               # 钩子签名
│   ├── logging/
│   │   ├── logger.ts              # JSONL writer（§11）
│   │   └── events.ts              # 事件结构定义
│   └── config/
│       ├── store.ts               # 配置读写（含 safeStorage）
│       ├── migrations.ts           # 配置版本迁移
│       └── schema.ts              # 配置 schema / 默认值
├── src/                           # 渲染进程 (Vue)
│   ├── main.ts App.vue
│   ├── components/                # Markdown、图标与 TerminalPanel
│   ├── stores/agent.ts            # 项目、对话、运行时与设置状态
│   └── terminal-sequence.ts       # PTY seq 缺口恢复
└── docs/                          # 本文档
```

> 契约只在 `shared/ipc-contract.ts` 定义一次。`shared/` 不得 import Electron、Node 或 Vue，确保三侧都能安全复用；运行时 payload 仍必须校验，TypeScript 类型不能替代安全检查。

### 2.1 工具执行契约
```ts
interface ToolDefinition<TArgs extends JsonValue> {
  id: string
  description: string
  inputSchema: JsonSchema
  effects: Effect[]
  defaultRisk: 'low' | 'review' | 'high'
  supportsAbort: boolean
  defaultTimeoutMs: number
  maxOutputBytes: number
  execute(args: TArgs, ctx: ToolExecutionContext): Promise<ToolResult>
}

interface ToolCall {
  id: string
  toolId: string
  args: JsonValue
  reason: string           // 调用信封元数据，不属于工具业务参数
}

interface ToolExecutionContext {
  sessionId: string
  runId: string
  workspace: CanonicalWorkspace
  signal: AbortSignal
  approvedCall: ApprovedToolCall
}

type ToolResult =
  | { status: 'ok'; content: JsonValue; truncated?: boolean; totalBytes?: number }
  | { status: 'error'; code: string; message: string; retryable: boolean }
  | { status: 'denied' | 'cancelled' | 'timeout'; message: string }
```

工具定义的 `maxOutputBytes` 是不可绕过的内存/IPC 硬边界，不等于允许全部内容进入模型上下文。`ContextBudget` 在其上再应用每工具行数/结果数、单结果估算 token 和单 run 累计工具 token 预算；截断结果必须包含可继续读取的游标或行号。默认 `read_file` 为 400 行，硬上限 1000 行、64 KiB、8K 估算 token；`run_command` 保留有界头尾而不是只保留前缀。

上下文裁剪以完整用户轮次和 assistant tool-call/tool-result 组为最小单位，禁止逐条删除而破坏 Provider 工具协议。必须为下一次模型输出预留空间；未知模型按保守上下文窗口处理。

`ApprovedToolCall` 只能由权限管线创建，绑定 `sessionId/runId/callId/toolId/args/argsHash/resourcePreconditions/approvedBy`。文件写入的 precondition 至少包含审批时的目标路径和原文件 hash。`ToolExecutor` 只接受 `ApprovedToolCall`，不提供 `execute(toolId, args)` 这种可绕过权限的入口。执行前再次核对 schema、`argsHash` 与资源 precondition；文件已变化时批准失效并重新生成 diff/审批。

它不是加密 token，也不需要落盘；MVP 可用不可变对象 + 私有构造函数实现。它解决的是内部 API 正确性和 TOCTOU，不是替代操作系统 sandbox。

`ToolRegistry.schemasForProvider()` 在发给模型时为工具 schema 包装保留的 intent 字段，Provider 解析 tool call 后将其提升为 `ToolCall.reason` 并从 `args` 删除。MCP 转发只发送清理后的业务 `args`。若外部 schema 与保留字段冲突，注册时生成不冲突的字段名并记录映射。

`run_command` 的 schema 显式区分：
```ts
type RunCommandArgs =
  | { mode: 'process'; executable: string; args: string[]; cwd?: string }
  | { mode: 'shell'; command: string; cwd?: string; shell?: string }
```
优先使用 `process` 模式，避免不必要的 shell 解析；`shell` 模式默认提高风险级别。两种模式都使用受控环境变量合并、超时、输出上限和进程树终止；Provider API Key 等应用秘密不得继承给子进程。

文件修改使用 `apply_patch({path, patch})`。第一版仅更新一个已有 UTF-8 文件，允许多个 hunk；解析后在内存中严格应用，任何 context 不匹配或歧义均整体拒绝，不做 fuzzy apply。审批展示由实际 before/after 重新生成的 canonical diff，而不信任模型提交的 diff header。批准绑定路径、原内容 hash、patch hash 和结果 hash；执行前复核后使用同目录临时文件原子替换。`write_file` 默认只创建不存在的文件，`delete_file` 保持独立高风险动作，不再暴露 `edit_file`。

---

## 3. Agent Loop（核心状态机）

### 3.1 状态
```
IDLE ──(用户消息)──► CALLING_LLM ──► EVALUATING_TOOLS
                         ▲                 │
                         │                 ├─► AWAITING_APPROVAL
                         │                 │          │
                         │                 └─► RUNNING_TOOL(S)
                         │                            │
                         └────────────────────────────┘

CALLING_LLM ──(无工具调用)──► COMPLETED ──► IDLE
活动状态 ──(中断)──► CANCELLING ──► CANCELLED ──► IDLE
活动状态 ──(不可恢复错误/预算耗尽)──► FAILED ──► IDLE
```

`Session` 是长期会话，`Run` 是一次用户消息触发的执行。一个 session 同时最多一个 active run。PTY 归属于 session，因此取消 run 不自动销毁 PTY。

### 3.2 伪代码
```ts
async function runAgent(session: Session, run: Run, userInput: string) {
  session.messages.push({ role: 'user', content: userInput })
  await log('run.start', { runId: run.id })

  try {
    for (let step = 0; step < session.limits.maxSteps; step++) {
      run.abort.signal.throwIfAborted()
      const prepared = contextBudget.prepare(session.messages)

      // streamChat 返回 AsyncIterable<ProviderEvent>；
      // reducer 组装文本、tool args delta 和 provider continuation state。
      const turn = await collectProviderTurn(provider.streamChat({
        messages: prepared.messages,
        tools: registry.schemasFor(session),
        signal: run.abort.signal,
      }))
      await logLlmCall(prepared, turn)

      session.messages.push({
        role: 'assistant',
        content: turn.text,
        toolCalls: turn.toolCalls,
        providerState: turn.providerState,
      })

      if (!turn.toolCalls.length) {
        await log('agent.message', { runId: run.id, text: turn.text })
        return complete(run)
      }

      // 有副作用的调用默认串行；互不依赖的只读调用后续可受控并行。
      for (const call of turn.toolCalls) {
        const decision = await permission.evaluate(session, run, call)
        const result = decision.allow
          ? await registry.execute(call, {
              session,
              signal: run.abort.signal,
              limits: session.limits,
            })
          : ToolResult.denied(decision.reason)

        // 拒绝、取消、超时、执行错误都必须产生 tool result。
        session.messages.push({ role: 'tool', toolCallId: call.id, content: result })
        await logToolCall(call, decision, result)
      }
    }

    throw new AgentLimitError('max_steps')
  } catch (error) {
    return finishRunFromError(run, error)
  } finally {
    await log('run.end', { runId: run.id, status: run.status })
  }
}
```

关键点：
- **Provider state 随 assistant turn 保存**，下一轮由同一 provider adapter 序列化；Agent Loop 不解析内部 payload（§4.2）。
- **中断是协作协议**：`AbortSignal` 传给 Provider 和工具；命令工具还必须终止进程树。超时先优雅终止，超过 grace period 后强制终止。
- **审批等待可取消**：每个 pending approval 绑定 `sessionId + runId + callId`，中断、窗口销毁或会话结束时自动失效；重复决定必须幂等拒绝。
- **工具结果有界**：stdout/stderr、文件内容和 PTY scrollback 超限时截断，并附 `truncated/totalBytes`；完整大结果可落临时 artifact，但不会自动进入模型上下文。
- **上下文预算**：优先保留 system、最近用户轮次、未完成工具链路和 provider 必需 continuation state；压缩不能破坏 provider 的工具调用协议。
- **失败不等于丢消息**：Provider/工具异常转为 run 事件和用户可见错误；只有协议明确允许时才把错误作为 tool result 继续给模型。

---

## 4. LLM Provider 与延续状态

### 4.1 LLMProvider 接口
```ts
interface LLMProvider {
  readonly id: string
  readonly capabilities: {
    toolCalls: boolean
    parallelToolCalls: boolean
    reasoningDisplay: 'none' | 'summary' | 'full'
    continuation: 'none' | 'message-fields' | 'content-blocks' | 'response-items'
  }

  streamChat(req: {
    messages: AgentMessage[]               // assistant turn 可含 providerState
    tools: ToolSchema[]
    reasoning?: { mode: 'auto' | 'off'; effort?: string }
    signal: AbortSignal
  }): AsyncIterable<ProviderEvent>
}
```

`ProviderEvent` 是判别联合，至少包含 `text.delta`、`reasoning.delta`、`tool.start`、`tool.args.delta`、`usage`、`completed`、`error`。Provider 内部负责把 SDK 的流事件归一化；Agent Loop 不依赖某个 SDK 的 chunk 结构。

每个 Provider 同时保留可序列化的 `raw` 事件。请求通过 `InstrumentedTransport` 发送：它在注入 Authorization 等传输层凭据之前保存 `providerRequest`，并记录实际发送的 JSON body、响应流 chunk、TTFT 和总耗时。完整 trace 因而覆盖“Agent 规范化消息 → Provider wire request → 原始响应 → 规范化 turn”四层，便于定位上下文或 adapter 问题。

### 4.2 Provider Continuation State
单个 `ReasoningEnvelope { text, echo }` 不足以表达“thinking block、tool_use、text 相互有序”或 OpenAI Responses output items。改为把供应商继续下一轮所需状态绑定到整个 assistant turn：

```ts
interface ProviderContinuationState {
  providerId: string
  protocol: 'deepseek-chat' | 'anthropic-messages' | 'openai-responses' | string
  version: 1
  payload: JsonValue       // 完整、有序、JSON 可持久化的不透明 provider-native 状态
  requiredUntil?: 'tool-chain-end' | 'conversation-end'
}

interface AssistantMessage {
  role: 'assistant'
  content: string
  toolCalls: ToolCall[]
  reasoningDisplay?: string
  providerState?: ProviderContinuationState
}
```

各 Provider 的保真规则：

| Provider | `payload` 保存什么 | 下一轮序列化规则 |
|---|---|---|
| **DeepSeek** | assistant message 所需的 `reasoning_content/content/tool_calls` | 含工具调用的 thinking 链路必须把 `reasoning_content` 随原 assistant turn 回传；无工具调用的历史 CoT 可省略 |
| **GLM** | 按该模型实际协议保存，不能因字段同名就假设与 DeepSeek 完全一致 | 由 GLM adapter 和契约测试决定 |
| **Anthropic** | 完整且有序的 `thinking`、`redacted_thinking`、`text`、`tool_use` blocks | 工具链路中按收到的 block 和顺序回传；`signature/data` 视为不透明字符串，不筛选、不重建 |
| **OpenAI** | Responses API 的 response id 和/或相关 output items（含 phase 等协议字段） | 优先使用 `previous_response_id`；需要无状态持久化/回放时保存并回传完整相关 items |

流转：
```
provider stream → reducer 生成 AssistantMessage + providerState
                → 存入 session.messages
下一轮调用      → 同一 provider 将规范化消息序列化为原生请求
```

Provider state 只能由生成它的 Provider 解释。会话中切换 Provider 时，不尝试跨供应商转换历史 reasoning；只保留可见文本和工具结果，并明确开始新的 provider continuation 链。

### 4.3 Provider 实现策略
- **协议优先于 SDK**：即使多家兼容 OpenAI SDK，也为每家保留独立 Provider/adapter；baseURL 相同不代表 reasoning、stream delta、tool-call 约束相同。
- **能用 OpenAI SDK 的**（DeepSeek/GLM/Moonshot/Ollama）可共享底层 transport helper，但不共享未经验证的协议假设。MVP 实现 DeepSeek。
- **自有协议的**（Anthropic）：用其官方 SDK，单独写 adapter。
- **注册表**：`registry.get(config.provider)` 实例化对应 Provider，配置存 baseURL/apiKey/model/reasoning 开关。
- **契约测试**：每个 Provider 用录制 fixture 覆盖普通文本、流式 reasoning、单/多工具调用、拒绝工具结果、取消和续接请求。

### 4.4 凭据
API Key 经 `safeStorage` 异步 API 加密后以 base64 密文存于配置，运行时仅在 Provider 请求边界短暂解密，不进入 renderer、工具参数或日志。启动时检查加密后端；不可用或弱后端时阻止静默降级并提示用户。

---

## 5. Skills 模块（渐进式专家指令）

### 5.1 数据模型
```ts
interface SkillSummary {        // 摘要，注入 system prompt
  name: string                  // frontmatter.name
  description: string           // frontmatter.description
  trigger?: string              // frontmatter.trigger（可选）
}

interface Skill extends SkillSummary {
  path: string                  // 文件绝对路径
  body: string                  // frontmatter 之后的正文（read_skill 时返回）
  source: 'manual' | 'download' | 'upload'   // 安装来源
  sha256: string
  enabled: boolean
  trustedAt?: string
}
```

### 5.2 启动期：扫描 + 摘要构建
`SkillsManager` 在应用启动时：
1. 扫描 `userData/skills/*.md`，拒绝符号链接和超出大小上限的文件。
2. 逐个解析 frontmatter（用 YAML 解析器的安全 schema，禁止自定义 tag）；**格式错误或缺字段者跳过并记日志**，不中断。
3. 计算内容哈希，并与 `userData/skills/index.json` 中的来源、启用和信任记录合并。
4. 只为已启用的 skill 构建摘要索引，按名称排序并缓存。
5. 提供 `getSummaries(): SkillSummary[]` 与 `read(name): Skill`（供工具调用）。

### 5.3 摘要注入 system prompt
Agent Loop 构造 messages 时，把已启用摘要拼成一段塞进 system prompt；设置总字符/token 上限，超限时只注入名称与短描述，不能让 Skills 无限挤占上下文：
```
你可以调用以下 skill。判断相关时用 read_skill(name) 读取完整指令后执行。
可用 skills:
- pdf: 专业 PDF 工具集，覆盖报告/海报/论文/提取/合并等。触发: 用户提到 PDF 处理/生成/转换时
- <name>: <description>。触发: <trigger>
...
```
> 摘要常驻上下文（便宜）；正文按需 read_skill（省 token）。摘要内容会随 `llm.call` 写入日志。

### 5.4 read_skill 工具
```ts
// 注册为只读工具，不过权限管线
{
  name: 'read_skill',
  params: { name: string },
  effects: ['instruction.read'],
  handler: (args) => skillsManager.readByIndexedName(args.name).body,
}
```

`read_skill` 只能从内存索引按精确 name 读取，不能把 name 作为路径片段。正文进入上下文前带来源和 hash 标记，让日志能够定位实际执行的是哪个版本。

### 5.5 安装入口（三种，统一写 userData/skills/）
| 入口 | 流程 |
|---|---|
| 直接放文件 | 用户手动拷 `.md` 到目录，下次启动/手动刷新时扫描到 |
| 链接下载 | `installFromUrl(url)` → 校验 HTTPS/目标地址 → 限制重定向、超时、大小 → 校验 `.md` → 原子写入目录 |
| 上传安装 | 主进程打开文件选择器 → 校验所选文件 → 原子拷入目录；renderer 不直接提交任意主机路径 |

下载前解析每一跳 DNS，并拒绝 loopback、link-local、RFC1918/ULA 等私有地址；重定向后重复检查，防止 SSRF/DNS rebinding。安装后默认 `enabled=false`，用户查看来源与摘要后显式启用。重复 name 采用“拒绝并要求用户处理”，不静默覆盖。

### 5.6 IPC（渲染进程管理 skills）
| 通道 | 方向 | Payload | 返回 |
|---|---|---|---|
| `skills:list` | R→M | — | `SkillSummary[]` |
| `skills:installFromUrl` | R→M | `{ url }` | `{ ok }` |
| `skills:chooseAndInstallFile` | R→M | — | `{ ok, skill? }` |
| `skills:refresh` | R→M | — | `SkillSummary[]` |
| `skills:setEnabled` | R→M | `{ name, enabled }` | `{ ok }` |

---

## 6. MCP 客户端（接口预留，MVP 之后）

> 本节定义完整形态，MVP 不实现。但 ToolRegistry（§2 目录 `tools/registry.ts`）与权限管线（§9）**现在就按「可接 MCP 工具」设计**。

### 6.1 配置
```json
{
  "mcp": {
    "servers": {
      "github": { "transport": "stdio", "command": "npx", "args": ["-y", "@mcp/github"] },
      "db":     { "transport": "streamable-http", "url": "https://mcp.example.com/mcp" }
    }
  }
}
```

旧 `http+sse` 仅作为兼容 transport，不作为新配置默认值。配置含 `enabled/trusted/protocolVersion/envSecretRefs/authRef`；密钥只通过 secret 引用解析，不把明文 token 写进 JSON，也不允许 URL 内嵌凭据。远程授权优先按 MCP/OAuth 能力协商，静态 bearer token 仅作为显式配置的兼容方式。

### 6.2 生命周期
`McpLifecycle` 在用户启用或会话首次需要时按需启动：
- **stdio**：spawn 子进程，经 stdin/stdout 走 JSON-RPC。
- **streamable-http**：使用 POST/GET 与可选 SSE，处理 session id、协议版本和显式取消。
完成 MCP 握手（`initialize` → `notifications/initialized` → `tools/list`）后，把 server 暴露的工具注册进 `ToolRegistry`。
含：启动超时、崩溃检测、指数退避重启、最大重试次数和应用退出清理。stdio server 的 stdout 只允许 MCP 帧，stderr 单独作为诊断流。

### 6.3 工具桥接进 ToolRegistry
内部 canonical id 使用 `mcp:<serverName>:<toolName>`。由于不同 LLM 对函数名字符和长度限制不同，Provider 在发给模型前生成稳定、可逆的安全别名，不能假设带点名称总能被模型 API 接受。handler 负责把调用转发给对应 MCP client。

MCP 返回的工具 schema、description 和 result 都是不可信输入：限制数量/大小、校验 JSON Schema 子集，并在进入 system prompt、日志和 UI 前做边界标记与截断。

### 6.4 权限（关键设计）
**MCP 工具同样过权限管线**：
- 权限管线按工具注册来源识别，不依赖可伪造的名称前缀。
- **未知/外部工具默认按「有副作用」处理**——即默认走审批，除非用户显式配置某 MCP 工具为只读。
- schema、会话归属等执行不变量始终适用；风险黑名单和敏感数据外发策略在 Auto/Confirm 下适用，Yolo 明确跳过。
- MCP server 自报 `readOnlyHint/destructiveHint` 只能作为风险信号，不能直接决定放行。

> 设计意图：MCP server 是外部不可信代码，默认从严。

---

## 7. IPC 契约

preload 对 renderer 暴露冻结的 `window.agentApi`，每个方法绑定固定 IPC channel。回调只接收业务 payload，不暴露 Electron `IpcRendererEvent`；通用 `window.ipcRenderer` 已移除。

### 7.1 Invoke（请求-响应）
| preload 方法 / 内部通道 | Payload | 返回 |
|---|---|---|
| `createSession` / `session:create` | `{ workspace, mode, provider }` | `{ sessionId }` |
| `startRun` / `run:start` | `{ sessionId, message, clientRequestId }` | `{ runId }` |
| `interruptRun` / `run:interrupt` | `{ sessionId, runId }` | `{ accepted }` |
| `decideApproval` / `approval:decide` | `{ sessionId, runId, callId, decision, rememberRule? }` | `{ accepted }` |
| `getConfig` / `config:get` | `{ section }` | 脱敏后的 section |
| `setConfig` / `config:set` | 版本化 discriminated union | `{ ok, version }` |
| `sendTerminalInput` / `terminal:input` | `{ sessionId, terminalId, data }` | `{ accepted }` |
| `openTerminal` / `terminal:open` | `{ sessionId, cwd?, cols?, rows? }` | `{ terminal }` |
| `listTerminals` / `terminal:list` | `{ sessionId }` | `{ terminals }` |
| `resizeTerminal` / `terminal:resize` | `{ sessionId, terminalId, cols, rows }` | `{ accepted }` |
| `closeTerminal` / `terminal:close` | `{ sessionId, terminalId }` | `{ accepted }` |
| `getTerminalSnapshot` / `terminal:snapshot` | `{ sessionId, terminalId }` | 有界 ANSI snapshot 与当前 seq |
| `listSkills` / `skills:list` | — | `SkillSummary[]` |
| `installSkillFromUrl` / `skills:installFromUrl` | `{ url }` | `{ ok, skill? }` |
| `chooseAndInstallSkill` / `skills:chooseAndInstallFile` | — | `{ ok, skill? }` |
| `refreshSkills` / `skills:refresh` | — | `SkillSummary[]` |

### 7.2 事件（主进程 → 渲染进程，单向推送）
所有 Agent UI 更新尽量统一为 `agent:event`，payload 是版本化 `AgentEvent` 判别联合，避免 channel 数量和监听清理逻辑失控：

| Event type | 关键字段 | 用途 |
|---|---|---|
| `run.status` | `{ sessionId, runId, status, seq }` | run 状态机更新 |
| `assistant.text.delta` | `{ sessionId, runId, delta, seq }` | 流式 token |
| `assistant.reasoning.delta` | `{ sessionId, runId, delta, seq }` | 可展示推理摘要 |
| `tool.proposed` | `{ sessionId, runId, callId, tool, args, reason, seq }` | 工具调用已提出 |
| `approval.requested` | `{ sessionId, runId, callId, policySignals, expiresAt, seq }` | 请求人工审批 |
| `tool.completed` | `{ sessionId, runId, callId, result, seq }` | 工具执行结果 |
| `session.closed` | `{ sessionId, seq }` | 会话关闭 |

PTY 原始流使用独立 `terminal:event`，因为吞吐和背压策略不同：

| Event type | Payload |
|---|---|
| `terminal.output` | `{ sessionId, terminalId, chunk, seq }` |
| `terminal.status` | `{ sessionId, terminalId, status, exitCode?, seq }` |

每个 handler 执行前：
1. 校验发送方是当前受信任窗口的主 frame。
2. 用 runtime schema 校验 payload，并限制字符串/数组大小。
3. 校验 session、run、call、terminal 之间的所有权。
4. 对 `clientRequestId` 或 `(runId, callId)` 做幂等处理。

---

## 8. 终端模块（persistent PTY）

### 8.1 资源模型
基于 `node-pty`，每个终端是主进程里的一等资源：
```
TerminalResource {
  terminalId: string (uuid)
  sessionId: string
  pty: IPty
  cwd, shell, cols, rows
  status: 'starting' | 'running' | 'exited' | 'closed'
  scrollback: ByteRingBuffer         // 按字节设硬上限，保留原始 ANSI chunk
  outputSeq: number
  subscribers: Set<WebContents>      // 订阅的渲染窗口
}
```

### 8.2 双向流
- **输出**：pty.onData → 写有限 scrollback + 经 `terminal:event` 推送给订阅窗口（**原始带 ANSI**，UI 着色渲染）。每个 terminal 独立维护 seq；UI 检测到缺口时只请求一次有限快照，并按 snapshot seq 去重恢复期间排队的 chunk。
- **输入（人类）**：渲染进程 `terminal:input` → pty.write（人类可在终端上打字）。
- **输入（Agent）**：`terminal_send` 工具 → 同样 pty.write，但**经权限管线审批**。
- **Agent 读取**：`terminal_read` 工具 → 从 scrollback 取最近 N 行或指定 cursor 后的增量，**strip ANSI 后**返回给 LLM，并受字符数上限约束。

### 8.3 句柄管理
- `terminal_list` 返回所有 `[{id, cwd, status, shell}]`。
- 所有操作先校验 terminal 属于当前 session，renderer 不能猜 UUID 跨会话操作。
- `terminal_close` 终止 PTY 进程树、清缓冲、通知订阅者 `status:closed`；重复 close 幂等。
- **会话结束时**：必须清理所有归属该会话的 PTY，避免僵尸进程。

### 8.4 中断与清理
- Agent 中断时，不关闭人类正在观察的终端；但停止 Agent 后续的 `terminal_send`。
- 应用退出时 `dispose()` 全部 pty。
- `run_command` 和 PTY 都只能约束初始 cwd，不能在无 OS sandbox 时宣称限制了子进程的文件/网络访问。

---

## 9. 权限管线（Permission Pipeline）

### 9.1 流程
```
工具调用 {tool, args}
   │
   ▼
[A] ToolRegistry + JSON Schema + 资源归属校验
   ├─ 失败 → INVALID_CALL
   └─ 通过 ↓
[B] 执行不变量
   ├─ 文件工具越出 workspace / 跨会话句柄 / 非法 IPC → INVALID_CALL
   └─ 通过 ↓
[C] 当前模式
   ├─ Yolo → ALLOW
   ├─ ReadOnly 且有副作用 → DENY
   └─ Auto / Confirm → [D]
[D] 确定性低风险规则 / 审批模型
   ├─ 黑名单 / 高风险 → HUMAN_REVIEW
   ├─ Confirm 且有副作用 → HUMAN_REVIEW
   ├─ Auto safe → ALLOW
   └─ Auto dangerous / timeout / invalid → HUMAN_REVIEW
   │
   ▼
[E] 人类审批
   ├─ deny → DENY
   └─ allow → [F]
[F] 执行前重新解析路径和资源状态
   ├─ 状态已变化 → 批准失效，重新评估
   └─ 未变化 → EXECUTE
```

核心决策类型：
```ts
type PermissionDecision =
  | { kind: 'allow'; approvedBy: 'readonly' | 'policy' | 'model' | 'human' | 'yolo' }
  | { kind: 'invalid'; code: string; reason: string }
  | { kind: 'deny'; code: string; reason: string }
  | { kind: 'review'; request: ApprovalRequest }
```

### 9.2 审批模型
```ts
{
  tool: { id, effects, defaultRisk }
  args: object
  reason: string
  workspacePath: string
  policySignals: Array<{ code, severity, detail }>
}
```
不包含主模型推理和完整会话历史，因此审批模型只判断动作的固有风险，不判断它是否符合用户完整意图。`reason` 仅是待核验声明，不是事实。输出必须通过严格 schema：`{ decision: 'safe' | 'dangerous', note: string }`；网络错误、超时、非 JSON 或未知枚举一律按 `dangerous` 处理。

审批模型只辅助 Auto 模式，不能把无效调用变成有效调用。模型提示和工具参数都可能含 prompt injection，因此模型判定不作为唯一风险控制。

### 9.3 确定性策略
- 文件工具：基于规范化路径、真实路径、操作类型、文件数量和预计 diff 大小。
- 命令工具：提取 shell、可执行文件、cwd、重定向/管道/命令替换等风险信号；**不宣称完整理解 shell 语义**。
- MCP 工具：来源默认为外部不可信，server hints 仅作信号。
- 可选敏感数据策略：在工具输出进入 LLM 上下文前，按 `off | warn | confirm` 检查路径 glob 和内容模式；默认 `off`，Yolo 跳过阻断。

文件工具的 workspace 边界属于其调用契约；任意命令执行不具备同等路径隔离，必须在 UI 和模式说明中明确。

#### 9.3.1 敏感数据检查实现
统一在 `ContextIngressFilter` 做，不把规则散落到各 Provider：
1. **路径预检**：`read_file` 等工具执行前检查 `.env*`、`*.pem`、`id_rsa`、`.npmrc`、云凭据目录和用户 glob。`confirm` 模式可在读取前询问，避免先把内容放进内存/UI。
2. **内容后检**：对实际准备写入 LLM message 的文本检查 PEM block、常见 token 前缀、JWT、连接串和高熵片段。`grep`、命令输出、PTY 读取、MCP 结果都走同一入口。
3. **作用范围**：只扫描即将发送的那部分文本；被输出上限截掉且不会进入上下文的内容不扫描。原文件不改写。
4. **决策**：`off` 不扫描；`warn` 记录 signal 并继续；`confirm` 暂停当前 tool result 入栈，人工批准后原文进入上下文；Yolo 直接跳过 filter。

这不是 DLP 保证。正则和熵检测都会有漏报/误报，所以它是可选提醒机制，不应被描述为“敏感数据不会泄漏”。

### 9.4 记忆规则
用户规则是结构化对象，不保存模糊自然语言：
```ts
interface RememberedRule {
  id: string
  effect: 'allow' | 'review'
  toolId: string
  workspaceScope: string | '*'
  argConstraints: JsonLogic
  expiresAt?: string
  createdFromCallId: string
}
```

规则不能匹配密钥原文，也不能改变工具 schema、workspace 和资源归属等执行不变量；规则命中和最终展开条件必须在审批 UI 中可见。Yolo 不查询记忆规则。

### 9.5 钩子接入
`beforeToolCall` 钩子位于调用校验之后、最终执行复核之前，只能进一步阻断或提高风险，不能把无效调用变成有效调用（§10）。

---

## 10. 插件 / 事件总线

### 10.1 事件总线
主进程内一个简单发布订阅。MVP 只埋钩子点，不做加载器：
```ts
interface PluginApi {
  on(hook: HookName, fn: HookHandler): () => void   // 返回取消订阅
  emit(hook: HookName, ctx: HookContext): Promise<HookResult>
  registerTool(tool: ToolDefinition): void
}
```

观察型 hook 接收只读快照；可变更型 hook 返回显式 patch，不共享可变对象引用。每个 hook 有超时和错误隔离，失败默认不阻塞主流程，但安全型 `beforeToolCall` 失败按阻断处理。

### 10.2 钩子点
| 钩子 | 时机 | 可阻断 |
|---|---|---|
| `onSessionStart` | 会话开始 | 否 |
| `onSessionEnd` | 会话结束 | 否 |
| `beforeLLMCall` | LLM 调用前（可改 messages/params） | 否（改参） |
| `afterLLMCall` | LLM 返回后 | 否 |
| `beforeToolCall` | 工具执行前 | **是**（返 `{allow:false}`） |
| `afterToolCall` | 工具执行后 | 否 |
| `beforeApproval` | 审批判定前 | 否 |

### 10.3 未来
插件不能修改或重建 `ProviderContinuationState` 的不透明 payload，也不能把无效调用变成有效调用。

插件加载器（从 userData 加载 JS 插件包）、MCP 客户端（§6），均在 MVP 之后。加载本地 JS 插件等价于执行任意主机代码，必须有签名/来源/显式信任和权限声明；不能把事件总线本身误当成插件 sandbox。Hook context 和 result 均带版本，允许后续兼容演进，而不是承诺签名永不变化。

---

## 11. 日志（JSONL 全周期 trace）

### 11.1 实现
- `Logger` 在 `session.start` 时于 `userData/logs/{sessionId}.jsonl` 打开写入流。
- 每事件一行 `JSON.stringify`，通过单会话写入队列保证 `seq` 单调递增；处理 stream backpressure，不能无限堆内存。
- `logging.enabled=false` 时使用 NullLogger，不创建 trace；用户显式开启后采用单一的完整 trace 模式，不做 audit/diagnostic 分级。
- `session.end`、窗口崩溃或应用退出时尽力 flush；异常中断后允许最后一行不完整，读取器需容错。
- 按天数和总字节数轮转/清理；清理失败不影响 Agent 主流程，但必须产生可见诊断。

### 11.2 事件结构（与需求 §5.2 一致）
```jsonl
{"schemaVersion":1,"seq":1,"eventId":"...","type":"session.start","sessionId":"...","workspace":"...","model":"...","mode":"auto","ts":"..."}
{"schemaVersion":1,"seq":2,"eventId":"...","type":"run.start","sessionId":"...","runId":"...","ts":"..."}
{"schemaVersion":1,"seq":3,"eventId":"...","type":"llm.request","runId":"...","callId":"...","normalizedMessages":[],"providerRequest":{},"requestBytes":0,"prefixHash":"...","ts":"..."}
{"schemaVersion":1,"seq":4,"eventId":"...","type":"llm.stream","runId":"...","callId":"...","providerEvent":{},"elapsedMs":0,"ts":"..."}
{"schemaVersion":1,"seq":5,"eventId":"...","type":"llm.response","runId":"...","callId":"...","rawResponse":{},"normalizedTurn":{},"providerState":{},"usage":{"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":0},"timing":{"ttftMs":0,"totalMs":0},"ts":"..."}
{"schemaVersion":1,"seq":6,"eventId":"...","type":"approval","runId":"...","callId":"...","policySignals":[],"approver":"model","decision":"safe","ts":"..."}
{"schemaVersion":1,"seq":7,"eventId":"...","type":"tool.call","runId":"...","callId":"...","tool":"run_command","args":{},"result":{},"approvedBy":"model","durationMs":123,"ts":"..."}
{"schemaVersion":1,"seq":8,"eventId":"...","type":"terminal.event","terminalId":"...","direction":"output","data":"...","ts":"..."}
{"schemaVersion":1,"seq":9,"eventId":"...","type":"run.end","runId":"...","status":"completed","ts":"..."}
```

### 11.3 保真与隐私
- 开启后完整保存规范化消息、实际 Provider 请求体、每个原始流事件、聚合响应、reasoning/continuation state、工具参数/结果和审批上下文，不做内容脱敏。
- 完整性边界是 Agent 实际观察到的数据。工具执行器在输出上限外主动丢弃的字节不属于上下文，trace 记录 `totalBytes/truncated/discardedHash`；进入 Agent/LLM 的每个字节必须保存。
- API Key、Authorization/cookie、safeStorage 密文等传输层凭据不写日志；它们不属于模型上下文，重放请求时从当前 secret store 注入。
- 如果工作区文件或工具输出本身含凭据，它们会作为完整上下文进入日志。启用开关必须明确提示这一点，并允许用户快速打开日志目录和清空 trace。
- Anthropic `signature/data`、OpenAI reasoning items 等按 JSON 字符串值原样保存，不修改字段内容、不丢 block/item、不改变顺序；无需声称“JSON parse 本身会破坏签名”。

### 11.4 回放与 KV cache 分析
`TraceReplay` 提供两种模式：
- **offline**：按 `seq` 重放 user/assistant/tool/approval/terminal 事件，使用记录的流间隔或加速时间轴，完全不访问 Provider、不执行工具；结果应与原 UI/状态机一致。
- **fork**：选择任意 `llm.request`，恢复其完整 `providerRequest`，用当前凭据重新发送；默认不重新执行历史工具，只使用已记录 tool result。新结果写入新的 trace，并记录 `forkedFromEventId`。

每次 LLM 调用记录：
- Provider 原始 `usage`；DeepSeek 至少包括 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。
- `input/output/reasoning tokens`（Provider 提供多少记录多少）、请求字节数、消息数、工具 schema 字节数。
- DNS/连接时间（SDK 可获得时）、TTFT、流持续时间、总延迟。
- 完整请求体 hash，以及在 system prompt、tool schema、每条 message/item 边界计算的有序 `prefixFingerprints[]`，便于定位哪一段上下文变化导致前缀失配；cache 是否命中始终以 Provider usage 为准。

DeepSeek 流式请求设置 `stream_options.include_usage=true`，确保结束前收到完整 usage chunk。

---

## 12. 配置

```ts
interface AppConfig {
  schemaVersion: 1
  activeProvider: 'deepseek'                  // MVP 固定, 留扩展
  providers: {
    deepseek: {
      baseURL: string
      model: string
      modelCatalog: Array<{ id: string; ownedBy?: string }>
      modelCatalogFetchedAt?: string
      modelOverrides: Record<string, { contextWindowTokens?: number; maxOutputTokens?: number }>
      apiKeyRef: string                       // 指向 secret store 中的密文记录
      reasoning: 'auto' | 'off'
    }
  }
  approval: {
    approverProvider: string                  // Auto 模式审批模型 provider
    approverModel: string                     // 如 deepseek-chat(小)
  }
  permission: {
    builtinPolicies: boolean
    rememberedRules: RememberedRule[]
    sensitiveData: {
      mode: 'off' | 'warn' | 'confirm'
      pathGlobs: string[]
      contentPatterns: string[]
    }
  }
  limits: {
    maxStepsPerRun: number
    maxToolOutputBytes: number                // 不可关闭的内存/IPC 硬边界
    maxContextTokens: number                  // 未知模型的保守默认值
    maxToolResultTokens: number
    maxToolTokensPerRun: number
    tokenEstimation: { mode: 'conservative' | 'custom-bytes'; bytesPerToken: number }
    commandTimeoutMs: number
    terminalScrollbackBytes: number
  }
  logging: {
    enabled: boolean
    retentionDays: number
    maxTotalBytes: number
  }
  workspace: { lastOpened?: string }
  skills: { enabled: boolean; maxSummaryChars: number }
}
```
非敏感配置存于 `userData/config.json`，密文记录单独存储并由 `apiKeyRef` 引用。写配置采用“临时文件 + fsync + rename”的原子替换，并保留可迁移的 `schemaVersion`。renderer 的 `config:get` 永不返回密文。MCP servers 配置见 §6.1，MVP 不启用。

### 12.1 模型目录与能力来源

主进程通过 secret store 取凭据并请求 Provider 的模型目录，renderer 不接触 API Key。DeepSeek `GET /models` 只提供模型 ID、对象类型和 owner，不提供上下文窗口；目录结果与内置 `ModelProfile` 按 ID 合并，用户可输入目录外模型并覆盖上下文/最大输出。刷新失败不清空缓存，UI 显示来源和最后刷新时间。

有效模型能力按 `用户覆盖 > 内置资料 > 保守默认值` 解析。token 估算器是 Provider/模型可替换接口；自定义 `bytesPerToken` 使用 UTF-8 字节数计算，但始终与工具字节、行数和结果数硬限制同时生效。

---

## 13. 数据流：一次工具调用完整链路

以 Auto 模式下 `run_command({mode:"process", executable:"npm", args:["test"]})` 为例：
```
1. Agent Loop: provider.streamChat 返回 toolCall(run_command,
   {args:{mode:"process", executable:"npm", args:["test"]}, reason:"跑测试"})
2. → permission.evaluate(session, run, call)
     2a. schema、session ownership、cwd 检查通过
     2b. policy-engine 标记 effects=[process.spawn]，并指出 npm script 可执行任意项目脚本
     2c. 模式=Auto → approver-model 判定 {tool, args, workspacePath, policySignals}
         → 返回 dangerous（例如检测到测试可能跑任意脚本）
     2d. → IPC 推送 approval.requested（含 sessionId/runId/callId/expiry）
3. 渲染进程：ApprovalDialog 展示 tool/args/reason，用户点「批准」
     → preload decideApproval(...)，主进程再次校验 sender 和调用归属
4. permission 得到 allow → 执行前复核 cwd/资源状态 → registry.execute
     → run_command 执行，受 timeout/output limit/AbortSignal 约束
5. log('tool.call', {args, boundedResult, approvedBy:'human'})
6. 结果回填 session.messages(role:tool) → 继续 Agent Loop 下一轮
```

---

## 14. 技术选型汇总

| 领域 | 选型 | 备注 |
|---|---|---|
| 框架 | Electron + Vite + Vue 3 + TypeScript | 当前实现锁定 Electron 42、Vite 8 与 Vue 3 |
| LLM SDK | openai SDK（DeepSeek）+ 自封装 LLMProvider | 各家独立 Provider + continuation adapter |
| 终端 | node-pty | persistent PTY；官方 N-API prebuild，源码回退用 electron-rebuild |
| 代码高亮 | Shiki | |
| 代码编辑/diff | Monaco 或 CodeMirror | 包体积权衡后定 |
| 终端渲染 | xterm.js | 订阅 PTY 原始流 |
| Markdown | markdown-it + Shiki code | 禁用 raw HTML 或接严格 sanitizer |
| 状态管理 | Pinia | |
| 日志 | 自实现 JSONL writer | 不引入 SQLite |
| 配置加密 | Electron safeStorage | |

Windows x64 打包默认使用 node-pty 官方 N-API prebuild，并将整个 node-pty 包放入 `app.asar.unpacked`。`@electron/rebuild` 仅作为必须源码编译时的显式回退；构建和解包产物均执行真实 PTY smoke。

### 14.1 已知风险
- **node-pty 是 native 模块**：Windows x64 默认验证并打包官方 prebuild；缺少目标 prebuild 时才运行 `npm run rebuild:native:source`。跨架构构建（如 arm64 mac）仍需独立 native smoke。
- **主进程故障域**：MVP Runtime 在主进程内，未捕获异常可能影响窗口生命周期；模块边界必须可迁移到 `utilityProcess`，并在 MVP 后评估迁移。
- **命令不是 sandbox**：cwd/path guard 不限制脚本和子进程访问主机；Yolo/Auto 必须如实提示风险。真正隔离需要容器或 OS sandbox。
- **Provider 协议变化**：Reasoning/tool-call 字段演进快，必须用 provider fixture 契约测试和版本能力表维护，不能只依赖“OpenAI compatible”标签。
- **日志隐私**：完整调试 trace 可能包含源码、工作区凭据和模型推理；必须默认关闭、显式开启，并提供留存上限和清理。
- **依赖基线过旧**：当前 `package.json` 的 Electron 30 已不是可长期发布的安全基线；升级可能影响 vite-plugin-electron、native module ABI 和 safeStorage API，需在第一阶段解决。

---

## 15. 测试策略

### 15.1 单元测试
- `path-guard`：`..`、绝对路径、大小写、UNC、符号链接、Windows junction、新建文件父目录替换等。
- `policy-engine`：四种模式 × effects × 风险黑名单 × remembered rules 的决策矩阵，并验证 Yolo 跳过全部风险策略。
- `context-budget`：截断后仍保持 assistant tool call 与全部 tool results 配对，且保留 provider 必需状态。
- `trace fidelity`：请求/流事件/响应/tool result 能无损离线重放；验证传输层 API Key 不进入 trace，但消息中的原始内容保持不变。

### 15.2 契约与集成测试
- Provider fixture：流式文本、reasoning、单/多工具调用、DeepSeek continuation、拒绝结果、取消和异常 chunk。
- IPC：未知 channel 不可达、payload 超限被拒、伪造 session/run/terminal id 被拒、重复审批幂等。
- 工具：临时工作区内验证文件操作原子性、命令超时、输出截断、Windows 进程树终止。
- Skills：恶意 YAML、重复 name、符号链接、超大文件、重定向到私网地址。

### 15.3 Electron E2E 与打包验证
- 验证 `window.ipcRenderer` 不存在、`window.agentApi` 只有白名单方法。
- 用恶意 Markdown/代码片段验证 CSP 和 sanitizer，确保不能触发任意 IPC。
- Windows 打包产物中启动 `node-pty`、执行/取消命令、读写日志和 safeStorage round-trip。

默认 CI 不调用真实付费模型；真实 Provider smoke test 使用显式环境开关和独立密钥。

---

## 16. 实施顺序

1. **安全基线**：升级并锁定 Electron/构建依赖；替换通用 preload；配置 CSP、导航和 sender 校验。
2. **共享契约**：落地 IDs、IPC schema、AgentEvent、ToolResult、配置迁移和完整 trace logger/replay。
3. **只读闭环**：Session/Run 状态机、DeepSeek 流式 Provider、上下文预算、read/list/glob/grep。
4. **权限与写工具**：执行不变量、policy engine、审批 UI、`ApprovedToolCall`、write/edit/delete 和 diff。
5. **进程能力**：`run_command` 的 process/shell 双模式、取消/超时/进程树、再接 node-pty。
6. **Skills 与完善 UI**：安全安装/信任/启用流程、终端面板、trace/cache 分析视图。

每一阶段必须先通过对应测试再开放下一档副作用能力。MCP、插件加载器和 Runtime 迁移到 `utilityProcess` 不进入 MVP 首轮。

---

## 附录 A · 与需求文档的映射
| 需求章节 | 架构落点 |
|---|---|
| §2.1 Agent 循环 | §3 Agent Loop |
| §2.2 工具集 | §2.1 工具契约 + §8 终端 |
| §2.3 LLM/Reasoning | §4 Provider 与 Continuation State |
| §2.4 会话与工作区 | §3 状态机 + §9 Hard Constraints |
| §2.5 Skills | §5 Skills |
| §2.6 MCP | §6 MCP 客户端 |
| §3 权限模型 | §9 权限管线 |
| §4 UI 需求 | §7 IPC + §2 目录 `src/components/` |
| §5 日志 | §11 JSONL trace |
| §6 插件钩子 | §10 事件总线 |

## 附录 B · 协议依据
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache)
- [Anthropic Extended Thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [OpenAI Reasoning Models](https://developers.openai.com/api/docs/guides/reasoning)
- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [MCP Transports 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
