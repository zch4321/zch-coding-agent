# Provider、Canonical History 与 Prompt Context

本文规定历史编译、协议适配和压缩边界。接口以 [ModelProvider](../../electron/providers/provider.ts) 和 [MessageRecord](../../shared/message.ts) 为准；代码入口见 [Provider 地图](../code-map/providers-and-context.md)。

返回[架构总览](../architecture.md) · [文档入口](../README.md)。

## Provider History 重建

### 基本查询

下一次请求的 canonical history 来自：

`MessageRepository` 通过 codec 将每一行无损解码为完整 `MessageRecord`。`MessageHistoryCompiler` 检查顺序、`kind/parts` 组合和 assistant tool-call/tool-result 配对，投影为 `CompiledCanonicalHistory`；当前 `providerType` 对应的 `ModelProvider` 再消费完整 history 并转换成具体 wire request。Repository 不返回 Provider DTO。

Session history 不再依赖 main-process `ProviderMessage[]` 或 Responses/Anthropic item arrays。Backend 可以缓存查询结果和已编译 request，但缓存只按 Session revision、route 和 Provider config 失效，不能成为真相源。

### 完整写入规则

#### User message

用户发送时，backend 在 transaction 中插入完整 `kind = 'user_input'` message。Commit 后才开始 provider call；不同 Session 不经过全局或 workspace 准入预留。

#### Assistant final message

Text/reasoning delta 只进入 `ActiveRunExecution` memory buffer，并通过 `run:stream` 推送。Provider 发出 completed turn 后，backend 才插入完整 `kind = 'assistant_turn'` message：公开、非加密的可读投影进入 `normalizedReasoningText`；协议连续性所需的原始结构进入 `providerContinuation`。两者都不按 delta 增量写数据库。

#### Tool call batch

不能在 provider 刚提出 tool call 时写一条缺少 tool result 的持久历史。流程固定为：

1. Provider completed event 直接携带不修改 Session 的 canonical assistant candidate。
2. Backend 在任何 completion event/plugin、canonical append、approval 或工具执行前校验 schema、parts/text/reasoning/JSON bounds、normalized tool-call 一致性，以及 active epoch 内全局唯一的 `callId`；失败只保留脱敏 raw trace/diagnostic。
3. Backend 使用 Provider usage 先完成 hard context-window 判定；达到上限时不发 completion event、不 append assistant candidate，也不执行工具，历史停在上一个完整边界。
4. 校验通过后，backend 在内存保存完整 assistant tool-call message，再执行权限、审批和全部 tool calls，得到每个 call 的 terminal result。
5. 单一 transaction 依次插入 `kind = 'assistant_turn'` message 和所有对应的 `kind = 'tool_result'` messages。
6. Commit 后才发起下一次 provider call。

拒绝、取消、超时也形成完整 tool message。这样数据库任何时刻都不存在“assistant tool call 已持久化，但 required tool result 缺失”的协议断裂状态。

Tool/approval 的实时卡片来自 runtime event；完成后 renderer 从 assistant/tool messages 的 `tool_call/tool_result` parts 和 typed metadata 重建稳定展示。

### 主模型 Provider attempt 重试

每个 ReAct step 只编译一次不可变 Provider request，并以该 request 进行有界 attempt：network、timeout、HTTP 408/409/425/429/5xx 最多重试两次，invalid SSE/JSON、`ProviderCompletionError`（包括 empty/reasoning-only）和无 terminal completion 最多重试一次，总 attempt 不超过三次。服务端 `Retry-After` 优先于指数退避并限制在 60 秒内；abort 会立即终止等待。鉴权、计费/配额、上下文上限、配置与 canonical invariant 错误直接失败。

每个物理 attempt 分配独立 `llm:*` call ID，写一组 `llm.request` 与 `provider.started`，失败时写单条 `llm.failure` 与 `provider.failed`，成功时才写 `llm.response`、usage 并调用 after-LLM plugin hook。Operational Provider 记录携带 `attempt/maxAttempts`；最终 Run 失败复用最后一次 attempt 的 diagnostic ID。before-LLM plugin hook 在逻辑请求编译后只调用一次，避免观察插件因网络补试重复产生副作用。

Provider delta 仍实时发送。若 attempt 失败且允许重试，Session Core 先发 `assistant.stream.reset` 清除该 attempt 的临时 text/reasoning/activity，再发带 `attempt/maxAttempts/delayMs` 的 `provider.retrying`。Public Run snapshot、Renderer overlay 和 internal Agent execution overlay 同步投影该状态；主时间线与 Agents 状态槽显示“正在重试 A/B”，不弹 NMessage。新的 assistant activity 或后续 Run status 会清除 retry 状态。失败 attempt 从不形成 canonical assistant record、工具 proposal 或审批；因此重试可能增加 Provider 费用，但不会重复执行本地工具副作用。

这个简化模型不承诺“宿主文件副作用”和 Message transaction 在进程崩溃下原子一致：如果工具已经修改文件、但应用在完整 tool batch commit 前崩溃，workspace 变化可能存在而对应 tool messages 不存在。Git Review 可以重新查询当前 tracked working-tree 状态，但不能还原丢失的执行归属或调用历史；runtime context 中的 Git 摘要和项目树同样只是提示性快照，不是 crash journal。若未来要求 crash-atomic tool journal，必须重新引入 durable tool/run journal；它不是 v2.1 目标。

### Compact 与 `inHistory`

`inHistory` 表示下一次请求使用的 canonical active history，不表示消息是否在 UI 可见。

自动 compact 只由刚完成响应的 Provider usage 驱动，不用本地 token 估算值决定是否触发：

1. Provider 未返回 `totalTokens`，且也没有完整的 `promptTokens + completionTokens` 时，本次不主动压缩。
2. Provider 已成功返回时，其响应是否适配上下文窗口具有最终权威；usage 达到或超过冻结模型的 `contextWindowTokens` 时保留完整 assistant turn，并按达到压缩阈值处理，不得因本地 profile 拒绝或回滚这次成功响应。
3. usage 达到 `compactThresholdTokens` 且响应包含 tool calls 时，先执行并原子提交完整 tool-result batch，再把包含这些结果的 active history 一起压缩。
4. usage 达到阈值且响应是本轮 final answer 时，不在回答结束后后台启动请求；下一次普通用户 Run 在插入新 user message **之前**先压缩旧历史。若应用编排要求同一 Run 继续，则在 continuation 前立即压缩。
5. 本地估算只记录为 prompt trace 与诊断信息，并继续用于工具、附件等有界输出投影；它既不触发主动压缩，也不得成为普通、压缩或历史转换 Provider 请求的硬门。真实上下文超限由 Provider 拒绝。

压缩调用以完整 active history 为输入；Synthetic compact 由 `compileCompact()` 将编排指令放在最后一个 wire input，原生 compact 使用协议专用字段。Synthetic compact 只有 terminal `finishReason = completed` 才能形成 checkpoint；截断、内容过滤、拒绝和未知终止都 fail closed。截断最多从同一完整 source history 追加更短摘要约束后纠正重试一次；网络、timeout、rate-limit 与 5xx 最多重试两次，完整但非法的响应最多重试一次，总调用数不超过三次。鉴权、计费、输入超窗、过滤/拒绝和取消不重试；`Retry-After` 等待有 60 秒上限且可被 Run abort。原生端点明确不支持或返回完整但不符合原生 checkpoint 契约的响应时，立即切换到拥有独立重试预算的 synthetic 请求。每次尝试及降级请求使用独立 trace call ID，失败尝试的文本 delta 不进入 Renderer；手动命令的 durable journal 只写一次。

Provider 成功后，单一事务把旧 active records 置为 `in_history = 0`，追加 fresh harness 和一个隐藏 `compact_summary`；失败、abort、空结果或重建超限时恢复旧 epoch。原消息始终保留在 append-only 数据库中，只是不再进入后续 Provider request。非取消的最终压缩失败统一以 `COMPACTION_FAILED` 结束 Run，Renderer 继续通过既有 Naive UI message 通道显示“压缩失败，请重试或打开新对话。”。

Responses 原生 compact 保存 opaque output items；Anthropic 原生 compact 保存 opaque assistant compaction blocks；两者不支持原生协议时与 Chat/DeepSeek 一样保存 opaque envelope 中的文本 summary。Core 只管理 record 的历史归属与可见性，不解释或重写 Provider payload。

手动 compact 使用独立 durable command journal：

1. existing Session 在完成语法、route、credential、active-history 和 compression budget 前置校验后，先提交原始 `/compact...` 为 `submission.type = control_command` 的隐藏 `user_input`；它永久 `inHistory = false`。`run:start` 返回的就是这次 command-input commit，随后才允许 compression Provider 调用。
2. 纯 `/compact` 成功后重建 `system → harness* → compact_summary` 并结束；合成文本摘要可以展示，原生 opaque checkpoint 不伪造可见文本。
3. `/compact <正文>` 成功后重建 `system → harness* → summary → derived user`；derived user 通过 `derivedFromMessageId` 指向原始命令，Provider 只看到正文。
4. compression 失败、abort、空摘要或重建超限时 epoch 不变，但已接受的原始命令记录保留；相同 `clientRequestId` 只 dedupe，不再次执行。

自动 compact 不是新的用户提交，因此不创建控制命令。

Compact summary 的 `metadata` 至少记录：

- `replacesThroughSeq`。
- source hash。
- compact prompt id/version/hash。
- compact model route 与标准化 usage。

不再需要独立 `context_checkpoints` table。

### Route 兼容迁移与 Conversation Markdown

Opaque continuation/compact 只能在兼容 route 中原样回放。兼容键固定为 `providerType + providerId + model + endpoint + providerConfigRevision`；`purpose` 与 reasoning 档位不单独改变协议族。下一次 Run 若检测到 active assistant、transcript 或 compact anchor 与目标 route 不兼容，必须在插入新用户消息前执行事务式历史迁移：

1. 从 SQLite 读取该 Session 的完整、非 superseded append-only 分支，而不是只依赖当前分页或 active epoch。
2. 用共同的 `zch-conversation-markdown` 投影恢复用户输入、明文 assistant reasoning/text、orchestrator/interjection、tool call/result 和附件元数据；排除 system/runtime/AGENTS/selected context、控制命令、replay、旧 compact、旧 transcript、Provider continuation 与加密 reasoning。
3. 将 Markdown 放入 `<conversation_transcript><![CDATA[...]]></conversation_transcript>`；正文中的 `]]>` 拆为 `]]]]><![CDATA[>`，并记录 source boundary/hash 与精确 Markdown SHA-256。
4. 预检 `fresh harness → hidden conversation_transcript` 对目标模型有效后，单一 commit 停用旧 active history。随后才插入本次新 user input。

任一步失败都不修改旧 epoch，也不插入用户本次提问。普通 Session 侧栏提供同一投影的本地 Markdown 导出：导出不截断 tool result，保存前必须明确警告可能包含源代码、路径、工具参数/结果、内部编排和明文 reasoning。导出不包含 opaque compact、加密 reasoning 或 Provider continuation，也不能重新导入；hidden Subagent Session 仍不进入公开导出接口。

### Provider continuation

`ProviderContinuationEnvelope` 统一的是可路由、可版本化的外壳，不统一不同供应商的 CoT 数据结构：

它表示“这个已完成 assistant turn 若由兼容 Provider 继续，对应实现需要原样恢复的 provider-native 状态”。它不是 Session 全局 cursor，也不是标准化 reasoning。常见 payload：

```json
{
  "schemaVersion": 2,
  "providerType": "deepseek.chat-completions",
  "format": "assistant-turn.v1",
  "data": {
    "reasoning_content": "exact provider text"
  }
}
```

```json
{
  "schemaVersion": 2,
  "providerType": "generic.anthropic",
  "format": "thinking-blocks.v1",
  "data": {
    "contentBlocks": [
      {
        "type": "thinking",
        "thinking": "...",
        "signature": "..."
      },
      {
        "type": "redacted_thinking",
        "data": "..."
      }
    ]
  }
}
```

```json
{
  "schemaVersion": 2,
  "providerType": "generic.responses",
  "format": "response-state.v1",
  "data": {
    "responseId": "resp_xxx",
    "outputItems": [
      {
        "type": "reasoning",
        "id": "rs_xxx",
        "encrypted_content": "..."
      }
    ]
  }
}
```

`MessageHistoryCompiler` 不解析 `data`。具体 Provider 使用 Message 的 `modelRoute.providerType` 加 envelope 的 `providerType/format` 判断兼容性：

- 兼容：由该 Provider 使用原始 continuation。
- 不兼容、用户切换 Provider/protocol 或 format 未知：忽略 continuation，使用 canonical active `kind + parts` history 重放。
- continuation 损坏：不得从 `normalizedReasoningText` 伪造签名、密文、item id 或原始 block 顺序；只能明确降级重放或返回错误。

Renderer 可以持有同一个 canonical record，但必须把 `providerContinuation` 当作 opaque data，不解释、不展示、不修改。完整原始 Provider response 只进入显式开启的 trace；Message 中只保留协议继续所需的最小状态。

### LLM Provider 适配

#### 多 Provider 支持

必须支持接入多家模型供应商。所有实现直接满足同一个扁平 `ModelProvider.compile/stream + compileCompact/compact` 接口：Provider 自己拥有 canonical history 编译、鉴权/HTTP/SDK、stream 解码、reasoning、usage、continuation 与压缩 checkpoint。不能把某个 SDK 的消息类型当成 Core 的公共消息接口，也不引入 BaseProvider、协议方言继承层或任意 capability 组合。

生产路径实现互不继承的 `DeepSeekProvider`、`GenericChatCompletionsProvider`、`GenericResponsesProvider` 与 `GenericAnthropicProvider`。三种通用兜底分别对应 Chat Completions、Responses 和 Anthropic API style；Google 和其他具体厂商按实际使用需求分别实现，只共享 HTTP/SSE、bounds、tool-call 拼接等纯函数。

模型目录查询保持独立服务。OpenAI-compatible API 使用 Bearer `GET /models`，Anthropic 使用 `x-api-key`、版本 header 和有界分页 `GET /models`。目录解析只能采用协议明确返回的字段：Anthropic 的 `max_input_tokens/max_tokens` 归一化为模型容量；OpenAI 与 DeepSeek 的标准列表当前只保证模型身份信息，不能臆测容量。刷新按大小写敏感的模型 ID 只追加当前持久化清单中不存在的模型，不得覆盖旧条目或删除本次响应缺失的条目；404/405 等不提供目录接口的 Provider 必须保留现有清单并允许用户手工新增模型。新增模型对话框必须同时收集最大上下文、压缩阈值、最大输出长度、可选思考档位和能力等级，确认时原子写入目录、启用池与模型覆盖，不能先产生半配置模型。模型配置行必须允许删除非 Provider 默认模型、非当前辅助模型；删除原子清理本地目录、启用池和模型覆盖，并禁用引用它的模型池条目。Provider 后续仍返回该模型时，目录刷新可以重新发现它。设置页合并 Provider 返回、应用内置模型资料和已保存覆盖；不得抓取 Provider 文档 HTML 推断运行时能力。Provider 编辑页在底部以模型列表展示全部已知模型的“最大上下文、压缩阈值、最大输出长度”，目录没有返回的数值必须自动填入应用默认值而不是显示空配置。

模型能力采用 `用户覆盖 > Provider 明确返回 > 内置资料 > 保守默认值`。未知模型默认按 256K 上下文和 65,536 Token 最大输出管理；上下文不足时收窄输出上限并至少保留 1,024 Token prompt budget。压缩阈值默认为可用 prompt budget 的 80%，并明确标记“能力未知”。Provider 模型配置区必须使用可筛选的穿梭框维护按 Provider 持久化的 `enabledModelIds`；只有启用模型能进入 Composer、主/辅助模型角色和 Swarm 模型池的可选项。Provider 配置只保存连接、目录、默认模型和模型能力标注，不保存默认 reasoning。全局主模型与辅助模型分别保存精确的 `Provider + model + reasoning`；两个角色可以使用同一模型的不同档位，运行时不得从 Provider 隐式继承或升降档。Provider 默认模型可以从完整模型清单中选择，选中后必须原子加入启用池，并在作为 Provider 默认模型期间禁止从穿梭框移除；更换后不得自动停用旧模型。穿梭框只管理运行时候选，不得筛掉下方任何已知模型的 Token 与能力配置行。启用池不进入模型能力覆盖或 Provider revision，但运行 route 必须在开始时确认所选模型仍已启用。新安装不写入虚构模型 ID；未配置 Provider 可以暂时没有默认模型和启用模型，此时禁止启动 Run。全局主模型角色因删除、停用或 reasoning 标注变化而失效时，不自动改写已有 Session；新对话的 Provider/模型选择置空并禁用发送，直到用户显式选择有效 route。用户首次填写或替换 API Key 后，Provider 表单自动保存并立即刷新模型目录；其余 Provider 合法修改也在短暂防抖后自动保存，不要求手动点击保存。AppConfig v14 的 `modelConfigurationIds` 原样迁移为启用池。自动补齐的模型值不固化为用户覆盖，因此修改全局默认值会同步到仍使用默认能力的模型；手工修改过的三项配置按模型保存并随 route revision 冻结。模型目录请求失败时保留上次成功缓存和当前手工配置。对话 Composer 的 Provider/model route 必须来自当前 Session 或新对话草稿，不能复用 Provider 设置页当前正在编辑的卡片；已停用的历史 Session 模型可以显示为当前值，但必须先改选启用模型才能再次发送。

运行限制页采用带分节线的单列布局，百分比配置必须同时显示数值和 `%` 单位。合法修改在短暂防抖后自动保存，页面顶部保留立即保存/失败重试按钮；自动保存不能覆盖保存请求期间产生的更新。

token 预算通过可替换估算器计算。支持 Provider tokenizer、保守估算和用户自定义 `bytesPerToken`；自定义值按 Provider/模型保存。估算只负责调用前硬预算与输出规划，所有工具仍必须执行不可关闭的字节、行数/结果数硬上限。Provider 返回的真实 usage 既用于记录，也是在响应安全边界决定是否进入下一次 compaction 的唯一占用依据；它仍不能替代事前硬边界。

#### Reasoning（推理过程）适配

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

Anthropic 普通 Messages、自动审批/起名以及 native/synthetic compact 请求必须在顶层发送 `cache_control: { type: 'ephemeral' }`，让 Provider 自动把断点推进到最后一个可缓存 block。默认使用 5 分钟 TTL，不发送成本更高的 `ttl: '1h'`；首次 cache creation 计入 miss，只有 Provider 返回的 `cache_read_input_tokens` 计入 hit。缓存长度门槛、精确前缀匹配、TTL、路由稳定性与网关兼容性由 Provider 决定，Application 不伪造命中。

完整原始 Provider request/response 和 stream events 只属于显式开启的 trace。Message 只保存 canonical message parts、可读 reasoning 投影，以及继续协议所需的最小 opaque state。

#### Canonical History 与 ModelProvider

持久化历史使用应用自己的 `MessageRecord`：`kind` 表达内部语义，`parts` 是有序、封闭的 canonical payload。普通 V1 message part 只包含 `text`、`tool_call` 和 `tool_result`；`compact_summary` 另允许单个版本化 `provider_compact` part，以 opaque envelope 保存对应 Provider 的原生 checkpoint 或合成文本摘要。不保存 Provider DTO 派生出来的 `role/content/toolCalls/toolCallId`，也不把任一 SDK 类型暴露给 Persistence、Renderer 或 Agent Core。

`MessageHistoryCompiler` 只按 `seq/inHistory/compact boundary` 选择历史、校验 `kind/parts` 约束和 tool call/result 配对，并生成 `CompiledCanonicalHistory`。随后由 `ModelRouteSnapshot.providerType` 指定的 `ModelProvider.compile()` 消费**完整有序历史**，执行可能是一对多、多对一的协议编译：

- Chat Completions 可把 assistant `tool_call` parts 编译为 `assistant.tool_calls[]`，把每个 result 编译为独立的 `role = 'tool'` message。
- Responses API 可把同一链路编译为 `function_call` / `function_call_output` items。
- Anthropic Messages 可把相邻 tool results 合并到一个 `user` message，并将 `tool_result` blocks 放在其他 content blocks 前面。

因此 wire `role` 只属于特定协议，不是数据库字段；一条 `MessageRecord` 也不保证对应一条 Provider message/item。Provider 的 `stream()` 把响应解码为 normalized events，并在完成时直接返回 canonical assistant parts、可读 reasoning 投影、标准化 usage 和 continuation envelope；Application Service 为其补齐 Session/Message 字段后一次性持久化完整 turn。

主模型的每个 ReAct step 是一个逻辑请求，使用冻结不变的 route、prompt、tools 和 output limit，内部最多执行三次物理 Provider attempt。Network、timeout、HTTP 408/409/425/429/5xx 最多补试两次并遵守不超过 60 秒的 `Retry-After`；invalid SSE/JSON、空 assistant turn、reasoning-only completion 或没有 terminal completion 的 stream 最多补试一次。鉴权、计费/配额、上下文超限、配置错误、canonical/history invariant 失败和用户取消不得重试。每次 attempt 使用独立 Provider call ID并分别写聚合 Trace/Operational Log；只有成功 attempt 的 usage 进入 Run 汇总。失败 attempt 不 append Message、不触发审批或工具，并在下一次 attempt 前发送 `assistant.stream.reset` 清除 Renderer 与 Agents 面板中的临时 text/reasoning；等待可由 Run abort。Plugin 的 before/after hook 仍以逻辑请求为边界各最多调用一次。

同一个扁平 `ModelProvider` 还必须实现 `compactModes/compileCompact/compact`。Synthetic compact 把压缩编排消息放在 wire input 最后一项；原生 compact 按协议专用 request shape 编译。Responses 优先调用原生 `POST /responses/compact` 并保存返回 output items；Anthropic 优先调用 beta context-management compaction 并保存、以 assistant content 重放返回的 compaction block，已知上下文低于其 50k 最小 trigger 时直接使用 synthetic；Chat Completions 与 DeepSeek 始终使用无工具的合成文本摘要。原生端点明确不支持或返回不兼容 checkpoint 时切换到拥有独立重试预算的 synthetic 请求，并按 Provider 配置在进程内缓存能力缺失；鉴权、计费、限流、输入超窗、网络/timeout、5xx 和用户取消不得触发该降级。Synthetic compact 只接受 `finishReason = completed`；截断响应最多从同一完整 source history 以更短的摘要要求纠正重试一次，过滤、拒绝和未知终止原因直接失败。网络、timeout、rate-limit 和 5xx 最多自动重试两次并遵守有界 `Retry-After`，完整但非法的响应最多重试一次，单一 mode 最多三次 Provider call。Core 只验证 `ProviderCompactEnvelope` 的版本、route 兼容性和 JSON bounds，不解释 opaque data。Provider compaction 成功后才以单个事务停用旧 active history、追加 fresh harness 与隐藏 `compact_summary`；失败不得破坏旧 epoch，并通过既有 Renderer message 通道显示“压缩失败，请重试或打开新对话。”。

Tool Result 的 canonical renderer 固定为：单 TextPart 原样、单 JsonPart 只序列化 value、多 part 按顺序换行连接；不能把 `type/json/value` 外壳或内部 `status/content/truncated/totalBytes` 发给模型。Chat Completions、Responses 和 Anthropic 只负责映射 wire 字段与 call ID，Anthropic 错误结果继续设置 `is_error = true`。

`providerId` 表示用户保存的配置实例，`providerType` 表示代码实现；同一供应商的不同 API surface 必须使用不同 type。协议差异依据：[OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)。

## History Compiler 与 ModelProvider

持久化和请求边界固定为：

```text
SQLite row
  <-> Message codec
MessageRecord[]
  -> MessageHistoryCompiler
CompiledCanonicalHistory
  -> ModelProvider.compile(...)
provider wire request
  -> read-only hook / budget / trace
  -> ModelProvider.stream(...)
canonical ProviderEvent / CompletedAssistantTurn
```

`MessageHistoryCompiler` 只负责 provider-independent policy：按 `seq` 排序、选择 `inHistory`、应用 compact 边界、校验 record schema、payload bounds、Session/identity 和严格有序的完整 tool-call/result batch。它不生成 `role`、Provider message 或任何 SDK DTO。

`compile()` 与 `compileCompact()` 必须同步、无网络、无凭据且确定性地消费整个 ordered history；它们不是对每条 MessageRecord 做一对一 `map()`。编译可以提升 harness、合并相邻记录或将一条 record 展开为多个 wire items，但不能改写持久化 history。Synthetic compact 把压缩编排指令作为最后一个 wire input；原生 compact 则按对应协议的 compact request shape 编译。`stream()` 与 `compact()` 负责鉴权、HTTP/SDK、abort、流解码、usage 和恰好一次 terminal completion。Application service 校验结果后生成 ID/Session/seq/metadata 并落盘；Provider 不直接创建或插入 MessageRecord。

`GenericResponsesProvider` 优先使用原生 `POST /responses/compact`，把包含有效 `compaction` item 的 output 原样放入 `ProviderCompactEnvelope`，下一次同兼容 route 请求再原样编译回 input；接口形态以 [OpenAI Responses compaction](https://developers.openai.com/api/docs/guides/compaction) 为准。`GenericAnthropicProvider` 优先使用 beta `context_management` compaction，并以 `pause_after_compaction` 取得、保存和作为 assistant content 原样重放 `compaction` block；已知上下文低于 Anthropic 50k 最小 trigger 时直接使用 synthetic，协议依据见 [Anthropic compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)。两种原生实现只在明确的 capability/契约不兼容错误上降级到无工具 `summary-text.v1`；401/403/429、输入超窗、abort、网络错误和 5xx 不降级。进程内按 Provider type/id、endpoint、model 与配置 revision 缓存原生能力缺失；Chat Completions 与 DeepSeek 始终使用 synthetic。所有路径对 Core 都表现为同一个 opaque compact record。

| Canonical history                          | Chat Completions              | OpenAI Responses                         | Anthropic Messages                          |
| ------------------------------------------ | ----------------------------- | ---------------------------------------- | ------------------------------------------- |
| harness text                               | `system` message              | `instructions` / input message item      | top-level `system`                          |
| user/context/compact text                  | `user` message                | input `message` item                     | `user` text block                           |
| assistant text                             | `assistant` message           | output `message` item                    | `assistant` text block                      |
| assistant `tool_call` part                 | `assistant.tool_calls[]`      | `function_call` item                     | assistant `tool_use` block                  |
| one or more adjacent `tool_result` records | one `tool` message per result | one `function_call_output` item per call | one `user` message with result blocks first |
| native compact checkpoint                  | n/a                           | opaque `compaction` output items         | assistant `compaction` block                |

`role` 只是部分 wire 协议的字段，不是 canonical database field。OpenAI 官方把 Chat Completions 的基本单位称为 Message，而 Responses 使用包括 `message/function_call/function_call_output` 的 Items；Anthropic 则把 client tool result 放在 `user` message 的 `tool_result` content block 中。因此一条 MessageRecord 不要求对应一条 wire message/item。协议依据：[OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)。

三个协议使用同一个 canonical Tool Result renderer：单 TextPart 原样返回，单 JsonPart 只 `JSON.stringify(value)`，多 part 按顺序用换行连接，不序列化 `type/text/json/value` 外壳。各 Provider 只把结果放入自己的 `content/output/tool_result` 字段，并继续用 canonical `callId` 生成 `tool_call_id/call_id/tool_use_id`；Anthropic 在 `isError` 时设置 `is_error = true`。

Provider 实现保持扁平：`DeepSeekProvider`、`GenericChatCompletionsProvider`、`GenericResponsesProvider` 和 `GenericAnthropicProvider` 都直接实现 `ModelProvider`，互不继承。允许共享 HTTP/SSE、bounds、tool-call 拼接、hash/timing 等纯函数，但不引入 BaseProvider、协议方言层或任意 capability 组合。Provider factory 只按 `providerType` 做穷举选择；模型目录查询是独立服务，不扩充核心接口。目录模型容量按 `用户覆盖 > Provider 明确返回 > 内置资料 > 保守默认值` 解析；Anthropic `max_input_tokens/max_tokens` 可以直接归一化，OpenAI-compatible 与 DeepSeek 的标准 `/models` 只返回身份字段时不得猜测容量。

每个解析后的 `ModelProfile` 都携带非空的 `contextWindowTokens`、`compactThresholdTokens` 和 `maxOutputTokens`。Provider 设置页维护一个累计模型目录：目录刷新按大小写敏感的模型 ID 只追加新条目，不覆盖旧条目，也不删除本次响应缺失的条目；不提供目录接口的 Provider 可以通过显式“新增模型”动作把模型持久化到同一清单。该动作在单个配置事务中写入模型 ID、启用状态和包含三项 Token 配置及可选能力标注的 per-model override；校验失败时整个事务不落盘，空默认模型时新增项同时成为 Provider 默认模型。`provider-model-delete` 在同一个配置事务中移除非 Provider 默认、非当前辅助模型的目录项、启用状态和 override，并把引用该 route 的模型池条目置为 disabled；它是本地删除，若 Provider 目录之后仍返回相同 ID，刷新会重新追加。可筛选穿梭框只把完整清单投影为按 Provider 持久化的 `enabledModelIds`，它们是 Composer、主/辅助模型角色和 Swarm 的统一候选池；下方配置行始终覆盖全部已知模型，不再受穿梭框右侧筛选。Provider 默认模型可以从完整清单选择，选中时原子加入启用池，并在穿梭框中禁用移除；更换后旧模型仍保持启用但恢复可移除。启用池不进入 Provider revision 或 `modelOverrides`，但 route resolver 在冻结调用前确认模型仍处于启用池。AppConfig v15 将 v14 的 `modelConfigurationIds` 原样迁移为启用池；新安装允许尚未配置的 Provider 使用空默认模型和空启用池，因此不再伪造模型 ID，Renderer 在选定至少一个模型前禁用 Run。新目录模型即使只有 ID，也会立即用 256K 上下文、65,536 Token 最大输出默认值和可用 prompt budget 的 80% 压缩阈值形成完整 profile；上下文较小时输出默认值会被收窄，以至少保留 1,024 Token prompt budget。自动目录补齐的 profile 继续跟随全局默认值；手工新增对话框确认的显式配置和后续手工覆盖都不被全局设置反向改写。Provider 表单对合法修改采用 600ms 防抖自动保存，保存期间继续编辑时按最新快照追写；首次写入或替换 API Key，以及修改有凭据 Provider 的 Type/Base URL 后，会在保存成功后自动刷新目录。运行时从冻结 route binding 的 profile 读取输出上限与压缩阈值，不再从 Provider wire DTO 或当前可变表单推导。全局 `autoCompactTriggerPercent` 只负责为尚未覆盖的模型生成默认阈值。思考力度枚举为 `off|low|medium|high|xhigh|max` 六档；per-model overrides 还可标注该模型支持的思考档位子集（`reasoningEfforts`）与能力等级（`capability: light|standard|strong`），未标注的模型视为全档位支持。Provider 本身不保存 reasoning；已标注模型只在角色、Composer 和模型池对应的 reasoning 选择中呈现子集。route resolver 在冻结时拒绝标注集外的档位并明确报错，不做自动升降档，API 层不支持时的错误原样透传。`capability` 是 Model Pool 调度能力的唯一配置来源；pool entry 不再复制该标注。

S3 backend foundation 在 AppConfig v16 增加默认空的根 `modelPool`；v17 将 pool entry 的 reasoning 与全局六档枚举统一；v18 删除 entry 中重复的 capability；v19 再删除从未执行的 per-route `maxParallel`；v20 不改变模型池结构，v21 将其收拢为 `models.modelPool`，v22 只迁移模型角色 reasoning 而不改变 pool。模型池 entry 只保存稳定 ID、enabled 和 Provider/model/reasoning，不保存能力等级、并发配额、Provider revision、API key 或 credential reference；能力由对应 Provider 的 `modelOverrides[model].capability` 唯一决定，revision 只作为 `config:set(model-pool)` 的 optimistic concurrency 输入。保存路径先规范化完整数组，再通过共享静态路由规则与能力标注校验 enabled entry 并原子写盘；Provider 删除、模型移除、能力标注移除、reasoning annotation 变为不兼容和显式清凭据会在同一配置写入中禁用引用项，恢复不自动启用。启动/reload 修复 enabled 的静态不兼容或无能力标注引用，环境凭据暂时缺失仍留给 route freeze 显式失败。Renderer 的 `model-pool-settings` Pinia store 独立拥有 entry 草稿、已保存签名和保存状态；Models 设置页引用 Provider store 的公开目录，用 Naive UI Transfer/Tree 把候选投影为 `Provider → model → reasoning` 穿梭树，不复制 Provider 表单状态。叶节点使用 Provider/model/reasoning 三元组编码，因此同一模型的不同 reasoning 是可同时选择的精确 route；UI 不执行 fallback。最低 reasoning 门槛只隐藏左侧未选择候选，已选 route 始终保留在右侧，不进入 AppConfig 或调度策略。用户显式保存时发送一次完整 `config:set(model-pool)`；Provider 写入返回的自动修复配置仅在模型池草稿干净时回填，dirty 草稿保留并提示冲突检查。

Model Pool allocator 是不含 Agent task/name 的纯函数：freezer 先从同一 PublicConfig 快照把 enabled entry 与 Provider 模型能力标注组合为不持久化的 runtime candidate，allocator 再消费 candidate 与能力需求序列，让所有 `actualCapability >= requiredCapability` 的模型参与分配。它按声明顺序先 round-robin `Provider + model`，再轮询选中模型的精确 reasoning route，因此同一模型选择更多 reasoning 叶节点不会获得更高权重；符合要求的模型少于需求数时自然复用，cursor 不跨调用保存。freezer 计算覆盖全部 enabled candidate、派生能力与相应 Provider revision 的顺序敏感 SHA-256 digest，按 allocator 结果对每个唯一 entry 只解析一次 main/compression pair，并在返回前复核所有 digest Provider revision。backend-private prepared plan 保留 `ResolvedModelRoute`/API key；可序列化 safe snapshot v2 只保留 assignment 元数据和安全 route，不含 per-route 并发字段。缺少能力或能力标注在解析凭据前整体失败；已选 entry 不可用或 revision 竞态不会触发 fallback/reassignment。Desktop Swarm 使用该 prepared plan；standalone `subagent_run` 仍继承父 route。

模型路由的静态兼容性由 `shared/model-route.ts` 中的 process-neutral helper 统一解释：Provider 必须存在、模型 ID 非空且位于 `enabledModelIds`，显式选择的 reasoning 必须属于模型标注的 `reasoningEfforts`；未标注模型仍视为支持全部六档。Renderer 的角色草稿预检查、辅助角色持久化校验、Provider 删除 fallback 和运行时 route resolver 都消费同一结果及结构化失败原因。全局主模型角色是新对话偏好而非强制修复不变量：它因模型删除、停用或标注变化而失效时，新对话的 Provider/模型选择保持为空并禁用发送，等待用户显式重新选择；已有 Session 不受影响。该 helper 不检查凭据、Endpoint 安全性或 Provider 实时可用性，这些仍属于运行时边界。

Renderer 的运行限制表单以单列分节展示，`autoCompactTriggerPercent` 明确显示 `%` 单位。表单变更在 600ms 静默期后调用 versioned `config:set(limits)`；store 对发送中的快照签名，并在请求期间又有编辑时继续保存最新快照，避免用旧响应覆盖新输入。顶部按钮复用同一 action，用于立即提交和错误重试。

Run 开始时冻结 `maxToolOutputBytes/maxToolOutputLines`，默认 256 KiB/500 行，并通过 `ToolExecutionContext` 交给每个工具。Tool executor 先产生完整内部结果并运行 canonical projector；统一出口只对 `modelOutputPolicy = bounded` 的投影执行 UTF-8 安全的字节保险，超限时保留头部，并加入 `byteLimitExceeded/totalBytes/totalLines` 与发现到的 artifact/continuation 路径。统一出口不再解释或截断行数；`read_file/background_list` 等 `paged` 工具自行消费行数配置并生成准确 continuation，`passthrough` 当前只用于已有 256 KiB 源文件上限的 `read_skill`。不再维护 `maxToolResultTokens`、`readFileOutputBytes` 或跨 Tool batch/Run 的累计 Tool Result 预算；token estimator 继续用于 prompt 诊断和其他明确的 token 边界。完整 Provider 请求仍受冻结模型 profile 的 prompt budget 与自动压缩约束。

`read_file` 使用文件句柄与固定大小 chunk 真正流式分页。模型以 1-based `startLine` 定位普通页；只有一行超过单页上限时才附加 0-based Unicode code-point `startCharacter`。输出用 `nextStartLine/nextStartCharacter` 明确给出下一位置，不再暴露编码文件身份与字节 offset 的 opaque cursor。读取器把字符位置流式换算为内部字节位置，在 UTF-8 code point 中间安全停下，并检测一次调用期间的文件替换；读到无换行 EOF 时保留同一行字符位置，使后续 append 不丢前缀。`maxToolOutputLines` 只计文件正文，默认一页完整读取 500 个源文件行，空行和 continuation footer 另行追加；字节预算仍为 footer 预留固定空间。workspace 文件仍受 `readFileSourceBytes`，Session temp 只受每页模型输出限制。

ProjectModel 与 code intelligence 暂停期间，Session tooling 不注册 `project_*` 或 `code_*`，provider tool catalog 还会无条件过滤这些保留 ID，旧 IPC 调用统一返回 `NOT_AVAILABLE`；因此 Desktop、Headless、main Agent 和 child Agent 都不能启动 Serena 或触发 `.zch` I/O。Provider parser 删除 intent metadata 后，ToolRegistry/executor 在权限与 schema 校验前再次按注册时记录的实际 intent field 清理，防止 `_agent_intent` 序列化泄漏导致偶发 `additionalProperties` 错误。

Auto approval 的审批模型是统一模型角色配置中的辅助精确 route（`models.auxiliaryModelProvider/auxiliaryModel/auxiliaryModelReasoning`），未配置或解析失败时回退到该 Run 的完整主模型 route；不再存在独立的审批配置。主/辅助角色各自保存 reasoning，Provider 不保存默认档位，也不做隐式升降档。模型角色由 `config:set(models)` 原子写入并经 Renderer Model Roles store 自动保存；创建、复制或保存 Provider 不能改写模型角色，Provider 草稿预检查只读取已保存的辅助精确 route。删除当前引用 Provider 时，辅助角色跟随当前主模型 route；主模型为空时辅助角色清空。加载修复会把不可用的辅助 route 改写为当前主 route。这样避免复制第二套 endpoint/credential 配置，同时保证审批路由不跟随 Provider 卡片草稿漂移。

Auto approval 的稳定前缀仅包含审批规则 prompt，动态 user payload 包含 tool/args/reason/workspace/policy signals。是否命中由各 Provider 的最小前缀、路由和 cache-control 语义决定；Application 不伪造命中，也不填充无意义文本。标准化 usage 将未被缓存覆盖的 input 记为 `cacheMissTokens`：OpenAI-style 用 input/prompt total 减 cached tokens，缺少 cached 指标时全部视为 miss；Anthropic 使用 uncached input 与 cache-creation input 之和，同时保留 raw usage。

Composer route 与 Provider 编辑草稿互相独立：已有对话始终读取冻结在 Session 上的 `modelSelection`，新对话读取显式 draft 或全局 active Provider；模型选项只读取该 route Provider 的 `enabledModelIds`，不能因设置页默认选中第一张 Provider 卡片而串表。历史 Session 引用已停用模型时保留显示值，但发送入口保持禁用，直到用户改选当前启用模型。

三个通用兜底 type 为 `generic.chat-completions`、`generic.responses` 和 `generic.anthropic`。Responses 固定 `store = false`，不使用 `previous_response_id` 或 Conversations API；完整 output items（含 encrypted reasoning）进入 `responses.output-items.v1` continuation 并由本地 history 精确回放。Anthropic 的非 off 思考档位使用 adaptive thinking 与 `output_config.effort`，档位值原样透传；完整 thinking、redacted thinking、signature 和 tool-use blocks 进入 `anthropic.message-content.v1` continuation。所有 Anthropic Messages 与 compact request 都在顶层发送 `cache_control: { type: 'ephemeral' }`，使用自动断点和默认 5 分钟 TTL；不默认选择具有额外写入溢价的 1 小时 TTL，缓存是否实际创建或命中仍以 Provider usage 为准。Anthropic Tool 编译对 Provider-neutral Schema 的 wire 副本移除协议不接受的顶层 `oneOf/allOf/anyOf`，但只在根 `type: object` 已声明组合分支引用的全部同级字段时执行；嵌套组合关键字和 ToolRegistry 持有的完整本地校验 Schema 保持不变，无法无损保留字段目录的投影在网络调用前带工具名失败。两者的 Provider Type/hash 不匹配均回退 canonical replay，同类型损坏 payload 明确报错。

Structured output 是携带 JSON Schema 的 provider-neutral 请求。Responses 编译为 `text.format`，Anthropic 编译为 `output_config.format`；DeepSeek 与 Generic Chat 为保持现有兼容行为继续降级成 `json_object`，Application 仍执行最终 schema 校验。Tool Result wire 字段只包含 canonical renderer 的正文，不包含 executor 的 `status/content/truncated/totalBytes`，也不包含 part 的 `type/value` 标签。
