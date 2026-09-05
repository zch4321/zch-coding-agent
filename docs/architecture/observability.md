# Operational Log、Full Trace 与 Transcript

本文规定日志保真度、隐私和失败隔离。排障步骤见[排障与数据恢复](../guides/troubleshooting.md)，源码入口见[集成与宿主地图](../code-map/integrations-and-hosts.md)。

返回[架构总览](../architecture.md) · [文档入口](../README.md)。

## 可观测性 · 全周期日志

### 形态

- Backend Operational Log 与 Full Session Trace 是两条独立边界。Operational Log 存于 Desktop `userData/logs/runtime/`，Headless 存于 artifact 的 `runtime/logs/runtime/`；默认 `info`，支持 `off | error | warn | info | debug`，单文件固定 5 MB、唯一时间戳归档，默认保留 14 天且总量 50 MB。
- Operational Log 只记录经过白名单约束和脱敏的生命周期、关联 ID、耗时、大小、usage、HTTP 状态与稳定错误码；Provider 请求可以额外记录顶层字段名以及实际 wire 输出上限、reasoning effort 和 thinking mode，但不得包含 API Key/header、Prompt、reasoning 正文、消息正文、Provider body、工具参数/结果、命令、Terminal/文件内容或绝对 workspace 路径。关闭只停止文件写入，错误仍可获得供 UI 展示的 `diagnosticId`。
- 每次日志启用或 Durable Session 恢复创建一个独立 **JSONL capture 文件**，存于 Electron `userData/traces/`；同一 Session 可以关联多个 capture，不能把 `traceId` 等同于 `sessionId`。
- 每个 capture 使用唯一 `traceId`、以独占新文件创建且 `seq` 从 1 开始；旧 capture 不追加、不改名、不回填。
- Full Trace 是**敏感调试功能**，配置项 `logging.trace.enabled` 默认 `false`；只有用户接受隐私提示并显式开启后才创建 trace。Operational 与 Trace 分别配置保留天数和总大小。
- 保存日志开关后必须通知所有已加载 Session：idle Session 立即启停；active Run 在该 Run 完整结束后应用最终保存值。运行中开启不记录当前 Run，运行中关闭仍记录当前 Run 的终态；未加载 Session 在下次 restore 时按当前配置创建 capture。
- `TraceCaptureStatus` 必须公开 `configuredEnabled` 与 `disabled | pending | active | degraded` 状态，并可携带当前 `traceId` 或有界 warning；状态变化通过有序 Session event 同步 renderer。
- capture 创建或写入失败必须降级为 Null logger，不得让模型、工具或 Terminal 操作失败；不完整文件留作诊断，下一 Run 开始前重试创建新 capture。
- 开启后采用内容记录模式：保存规范化消息、实际 Provider 请求体、可检索的最终 wire 控制参数投影、聚合成功响应、reasoning/continuation state、工具参数与结果、审批事件和配置快照。控制参数投影不得重复 messages/input/system/instructions/tools 等内容载荷。正常 Provider stream 不写 `llm.stream`；失败只写一条聚合 `llm.failure`，不保存失败前累计的 partial text/reasoning。
- `llm.failure` 可保存真正导致失败的 HTTP body、无效 SSE/JSON 或非法 completion 证据；内容最多 256 KiB，并记录观察/捕获字节数、截断状态和完整 SHA-256。API Key 仍必须在写入前移除。
- “完整”以 Agent 实际可见数据为边界：工具因输出上限而未进入 Agent 的丢弃字节记录 `totalBytes/truncated/discardedHash`，不要求无限落盘；进入模型上下文的内容必须逐字保存。
- 不记录请求传输层凭据，例如 API Key、Authorization header 和 safeStorage 密文；这些信息不属于模型上下文，也不是回放所需数据。
- 开启时必须明确提示日志可能包含源代码、用户输入、模型推理、工具输出以及工作区中被读取的凭据，并支持保留天数/总大小上限。
- 完整 trace 必须可规范化为只读 `zch-session-transcript`：按 run 展示用户/Assistant/明文 reasoning、内部编排、工具与审批、Provider上下文、Plan、interjection、usage、terminal和生命周期。该格式不可导入或重放；每次 Electron 导出前必须警告，导出内容不做敏感信息扫描或脱敏，用户负责本地保存和后续分享。
- Transcript 不输出 provider wire request/raw response/provider continuation、失败证据正文、工具 schema、加密/opaque reasoning或多模态原始载荷。v3 新 Trace 不从失败请求恢复 partial 输出；读取旧 v2 `llm.stream` 时仍可将遗留明文 delta 标为 partial，已经删除且没有 v3 等价物的 `run.rejected/workspace.writer` 记录只在读取投影中跳过，不改写原文件。多模态只保留类型/MIME/已知大小占位。
- 产品 Session 状态使用 SQLite 持久化；Trace 继续按 capture 分段保存，并通过 `sessionId` 归属同一 Session，不能因数据库存在而降低 trace 保真度。清理活动日志时必须使用真实 active `traceId`，不能把 `sessionId` 当作文件标识。

### 必须记录的事件（每条一行 JSON）

```
operational     { schemaVersion, seq, eventId, level, event, diagnosticId?, correlationIds?, boundedMetadata, ts }
session.start   { schemaVersion, seq, eventId, sessionId, workspace, model, mode, ts }
run.start/end   { runId, status, ts }
llm.request     { callId, runId, scope, messages, providerRequest, modelRoute, requestBytes, ts }
llm.response    { callId, runId, aggregateResponse, providerState?, usage, timing, ts }
llm.failure     { callId, runId, operation, stage, code, diagnosticId?, httpMetadata?, evidence?, timing?, ts }
approval        { callId, policySignals, mode, approver, decision, reason, ts }
tool.call       { callId, runId, tool, args, result, approvedBy, duration, ts }
terminal.event  { terminalId, direction, data/status, seq, ts }
user.message    { text, ts }
agent.message   { text, ts }
session.end     { reason, ts }
```

### 保真度要求

- 每条事件包含 `schemaVersion + seq + eventId`，Provider/Tool/Run 使用 `sessionId/runId/providerCallId/toolBatchId/callId/agentExecutionId/traceId` 建立因果关系。
- **离线检查**：不访问模型、不执行工具，按聚合响应、canonical 消息和已记录工具结果恢复稳定时间线；不承诺重现 token 级流式节奏或失败前 partial UI。
- **请求检查**：保留最终 Provider 请求体用于离线检查、导出和 cache 行为分析；不使用当前凭据在线重放，也不从 trace 创建 Session 分叉。
- **工具重放**默认只注入已记录结果；真实重新执行副作用工具必须是独立显式操作。
- 保存 Provider 返回的完整 usage，包括可用时的 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、输入/输出 token；同时记录 TTFT、总延迟、请求字节数和稳定前缀 hash，供 KV cache 分析。标准化 `cacheMissTokens` 表示未由缓存提供的输入：协议只返回总输入和 cached tokens 时按差值计算，未返回 cached 指标时把输入视为 miss；Anthropic 按 uncached input 加 cache-creation input 计算。原始 usage 必须保留以便审计。
- DeepSeek 流式调用必须请求最终 usage chunk；cache 命中以 Provider 返回字段为准，不能仅根据本地消息前缀推断。
