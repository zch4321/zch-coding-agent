# 实现计划 · My Coding Agent

> 状态：草案 v0.2 · 最后更新 2026-06-15
> 配套：[`requirements.md`](./requirements.md)（做什么）、[`architecture.md`](./architecture.md)（怎么搭）、[`frontend-spec.md`](./frontend-spec.md)（前端信息架构与验收）。
> 本文档定义实施顺序、阶段边界和可执行验收标准；需求与架构文档优先于本文档。

---

## 0. 实施原则与固定决策

1. **阶段串行**：P0-P5 按顺序推进。每阶段测试和验收门禁通过后，才开放下一档副作用能力。
2. **测试先行**：Provider 使用录制 fixture；默认 CI 不调用真实付费模型。真实 Provider smoke test 仅通过显式环境开关运行。
3. **副作用递进**：P2 仅工作区只读，P3 开放文件写入，P4 开放进程与 PTY，P5 只增加用户主动触发的 Skill 安装能力。
4. **安全边界不可审批绕过**：schema、IPC sender、资源归属和 workspace 边界属于执行不变量，ReadOnly/Auto/Confirm/Yolo 均不能绕过。
5. **契约单一来源**：`shared/` 保存跨主进程、preload、renderer 的纯类型和运行时 schema，不 import Electron、Node 或 Vue。
6. **两类事件分离**：
   - `AgentEvent`：主进程推给 UI 的版本化状态事件。
   - `TraceEvent`：写入 JSONL 的完整审计/回放事件。
7. **一个 session 一个 trace 文件**：留存天数和总大小通过清理已关闭 session 的旧 trace 实现，不把一个 session 拆成多个日志文件；当前活动 trace 可临时使总量超过上限，session 关闭后立即清理。
8. **Windows 为 MVP 发布目标**：主 CI 和打包门禁运行在 `windows-latest`；跨平台单元测试可并行运行，但 macOS/Linux 不阻塞首个 MVP。
9. **包管理固定为 npm**：提交 `package-lock.json`，`package.json` 使用精确版本；新增依赖必须同步更新锁文件。
10. **运行时 schema 方案固定**：共享契约使用 TypeBox 生成 JSON Schema，主进程使用 Ajv 校验；TypeScript 类型不替代运行时校验。

### 全阶段工程基线

- P0 建立 `lint`、`format:check`、`typecheck`、`test`、`test:e2e`、`build` 脚本。
- 所有资源型模块提供 `dispose()`，统一注册到应用级 `Disposer`。
- 所有异步边界把错误转换为版本化结构化错误或事件，不允许未捕获异常直接结束主窗口。
- 所有队列、输出、上下文、循环步数、日志和 PTY scrollback 均有显式上限。

---

## P0 · 安全基线与工程脚手架

> 目标：消除当前模板与架构的冲突，建立可测试、可打包的安全地基。本阶段不引入 Agent 能力。

### 功能清单

- [x] **P0-1 依赖、构建和发布基线**
  - 将 Electron 从 30 升级到实施时仍受官方支持的稳定版本；本计划初始目标为 Electron 42.x 最新补丁。
  - 升级并验证 Vite、Vue、TypeScript、`vite-plugin-electron`、`electron-builder` 的兼容版本，全部使用精确版本。
  - 移除 renderer 的 Electron/Node polyfill 配置和不再需要的 `vite-plugin-electron-renderer`。
  - 修正 `electron-builder.json5` 的 `appId`、`productName`、Windows x64 target；P4 再加入 `node-pty` rebuild/unpack。
  - 生成并提交 `package-lock.json`。
- [x] **P0-2 窄 preload 桥**
  - 删除通用 `window.ipcRenderer`。
  - 暂时暴露冻结的 `window.agentApi` 空骨架；后续只能从版本化 IPC 契约逐项增加方法。
  - 更新全局类型，renderer 不得 import `electron`。
- [x] **P0-3 renderer 隔离与内容安全**
  - 显式设置 `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、`webSecurity:true`。
  - 生产环境注册受限的 `app://` 安全协议加载打包资源；开发环境只允许精确的 `VITE_DEV_SERVER_URL` origin。
  - 对生产和开发响应注入 CSP：至少包含 `default-src 'self'`、`script-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`；根据 Naive UI/xterm/Shiki 的实际需求单独收紧 `style-src/img-src/font-src/connect-src`，禁止内联脚本。
  - `will-navigate`/`will-frame-navigate` 对非应用 URL 调用 `event.preventDefault()`；`setWindowOpenHandler` 默认返回 `deny`。
  - 拒绝未声明的 Chromium permission request，不启用 `<webview>`。
  - 移除模板事件 `main-process-message`。
- [x] **P0-4 测试、Lint 与 CI**
  - 接入 Vitest、Vue Test Utils、ESLint flat config、Prettier、`vue-tsc --noEmit`。
  - 接入 Electron E2E runner，能启动、检查窗口、关闭并等待进程退出。
  - GitHub Actions 至少包含 Windows 上的 `lint`、`typecheck`、`test`、`test:e2e`、`build`；可额外使用 Linux 跑快速单元测试。
- [x] **P0-5 生命周期清理**
  - 实现 `Disposer`：支持注册、逆序执行、幂等、单项失败隔离和总超时。
  - 在 `before-quit` 执行清理；窗口销毁时注销窗口级 listener。

### 测试点

- **T-P0-1**：E2E 断言 `window.ipcRenderer === undefined`，`Object.keys(window.agentApi)` 等于 P0 白名单。
- **T-P0-2**：renderer 中 `require` 和 `process` 不可用，无法加载 `child_process`。
- **T-P0-3**：包含 `<script>`、inline event handler 和 `javascript:` URL 的测试内容均不能执行。
- **T-P0-4**：外部主 frame/iframe 导航触发 `preventDefault()`；所有 `window.open` 返回 `deny`。
- **T-P0-5**：任一 disposer 抛错时其余 disposer 仍执行，重复 dispose 不重复释放资源。
- **T-P0-6**：干净 checkout 执行 `npm ci` 后全部 CI 脚本成功。

### 验收标准

1. `src/` 不 import `electron`，全仓库不存在 `exposeInMainWorld('ipcRenderer', ...)`。
2. Electron 主版本处于官方支持窗口，并锁定具体补丁版本。
3. CSP E2E 中内联脚本执行次数为 0；应用自身样式、字体和代码高亮正常加载。
4. 外部导航、新窗口和未声明权限请求的允许次数均为 0。
5. E2E 启动和关闭后 Electron 进程退出码为 0。
6. Windows CI 的 `lint/typecheck/test/test:e2e/build` 全绿。

---

## P1 · 共享契约、配置与可观测地基

> 目标：落地版本化契约、密钥存储、IPC 注册器、完整 trace writer 和无副作用回放 reducer。

### 功能清单

- [x] **P1-1 共享契约**
  - `shared/ids.ts`：`SessionId/RunId/CallId/TerminalId/EventId` branded types。
  - `shared/agent-events.ts`：完整 `AgentEvent` 联合，包含 `run.status`、text/reasoning delta、tool proposed/completed、approval requested、session closed。
  - `shared/ipc-contract.ts`：invoke、`agent:event`、`terminal:event` 的版本、payload、result schema。
  - `electron/tools/types.ts`：纯工具契约 `ToolDefinition/ToolCall/ToolResult/Effect`，供插件总线和 P2 执行器复用。
  - 明确所有规范化 `ToolCall` 均有独立 `reason` 字段；副作用工具的 provider schema 强制要求，纯只读工具缺失时规范化为空字符串。
- [x] **P1-2 配置与 Secret Store**
  - `AppConfig`、默认值和 `schemaVersion` 迁移；非敏感配置使用同目录临时文件、file fsync、rename 的原子替换。
  - 内部配置中的 `apiKeyRef` 只引用密文记录；renderer 只接收 `PublicConfig`，以 `credentialConfigured` 表示状态。
  - `config:set` 使用版本化 discriminated union；凭据变更分支接收明文后立即用 safeStorage 异步 API 加密，不记录 payload。
  - 启动后检查异步加密可用性；Linux 同时拒绝 `basic_text` 弱后端；解密处理临时不可用和 `shouldReEncrypt`。
- [x] **P1-3 JSONL Trace Logger**
  - `TraceEvent` 覆盖架构 §11.2 的全部事件，每行包含 `schemaVersion/seq/eventId/type/ts`。
  - 每 session 一个有界写入队列，正确处理 stream backpressure；`seq` 在入队时分配并严格单调。
  - `logging.enabled=false` 使用 `NullLogger`，不创建文件。
  - reader 忽略崩溃产生的不完整最后一行；关闭 session、窗口崩溃和应用退出时尽力 flush。
  - 按 `retentionDays/maxTotalBytes` 清理最旧的已关闭 trace；清理失败只产生可见诊断，不中断 Agent。
- [x] **P1-4 IPC 安全注册器**
  - 所有 handler 统一执行：主 frame/sender 校验、schema 校验、字符串/数组大小限制、结构化错误转换。
  - 预先定义完整 MVP IPC，包括配置、工作区选择、session create/close、run、approval、terminal 和 skills；未实现 handler 返回明确的 `NOT_AVAILABLE`，不注册任意动态 channel。
  - renderer callback 只收到业务 payload，不收到 `IpcRendererEvent`。
- [x] **P1-5 插件事件总线骨架**
  - 定义全部 7 个 hook 的版本化 context/result。
  - 定义 `registerTool` 注册端口契约；P1 不加载插件，P2 创建 ToolRegistry 后再绑定实际注册实现。
  - 观察型 hook 接收只读快照；`beforeLLMCall` 返回显式 patch；`beforeToolCall` 只能阻断或提高风险。
  - hook 有超时和错误隔离；`beforeToolCall` 失败默认阻断，其他 hook 失败不阻断主流程。
- [x] **P1-6 最小 Trace Replay**
  - 实现纯 reducer：按 `seq` 把 TraceEvent 转换为 UI/Agent 状态，不访问 Provider、不执行工具。
  - 支持实时速度和加速时间轴；未知新事件按 schemaVersion 策略跳过或拒绝。
  - fork 只定义接口和 fixture，实际重发在 P5 完成。

### 测试点

- **T-P1-1**：`shared/` import Electron、`node:` 或 Vue 时架构规则失败；类型与 schema 的样例值双向通过。
- **T-P1-2**：并发写入 10,000 条事件，行数和 seq 完整；人为截断最后一行后 reader 仍返回此前完整事件。
- **T-P1-3**：写入压力超过 high-water mark 时 producer 等待，待写队列长度不超过配置上限。
- **T-P1-4**：多个关闭 trace 超过留存上限时删除最旧文件，活动 trace 不被删除或分段。
- **T-P1-5**：`PublicConfig` 不含密文、明文 key 或内部 `apiKeyRef`；凭据配置状态仍可读取。
- **T-P1-6**：safeStorage 不可用、Linux `basic_text`、临时不可用和 key rotation 均得到预期结构化结果。
- **T-P1-7**：伪造 sender、子 frame、超长 payload、未知 channel 均被拒。
- **T-P1-8**：`beforeToolCall` 超时/抛错均阻断；其他 hook 超时只记录诊断。
- **T-P1-9**：至少两段 trace 经 replay reducer 后得到确定的 AgentEvent/UI state 序列。

### 验收标准

1. `shared/` 对 Electron、Node、Vue 的 import 违规数为 0。
2. 10,000 条 trace 的 seq 无重复、无回退、无中间缺失。
3. logger 待写队列峰值不超过配置上限，关闭后所有已接受事件均已 flush。
4. renderer 可观察到的配置中测试密钥和密文出现次数均为 0。
5. 每个已注册 IPC 至少有一个 sender 或 payload 负向测试。
6. 两段录制 trace 的 replay 输出与预期状态逐字段一致。

---

## P2 · 只读闭环（DeepSeek + 工作区检索）

> 目标：用户可完成首次配置、选择工作区、创建会话、发送消息、查看流式回复，并让 Agent 执行严格限制在 workspace 内的只读任务。

### 功能清单

- [ ] **P2-1 首次配置、工作区和会话生命周期**
  - 提供 DeepSeek base URL/model/reasoning/credential 设置 UI；密钥只通过窄 IPC 进入主进程。
  - 首次创建会话前明确告知用户：消息、代码和工具结果可能发送给 Provider；记录用户确认版本。
  - 用户启用完整 trace 前展示独立告知：日志可能包含源码、用户输入、推理过程、工具输出和工作区凭据；默认保持关闭。
  - `chooseWorkspace` 由主进程打开目录选择器；`createSession` 绑定 canonical workspace、mode 和 provider。
  - 实现 `closeSession`：取消 active run、失效 pending approval、释放 session 资源、写 `session.end` 并发送 `session.closed`。
- [ ] **P2-2 Session/Run 状态机**
  - 实现 `IDLE/CALLING_LLM/EVALUATING_TOOLS/AWAITING_APPROVAL/RUNNING_TOOLS/CANCELLING/COMPLETED/CANCELLED/FAILED`。
  - 一个 session 同时最多一个 active run；运行中提交新消息默认结构化拒绝。
  - `clientRequestId` 幂等；中断传播同一个 `AbortSignal`，并在 grace period 内结束 run。
- [ ] **P2-3 DeepSeek Provider**
  - `LLMProvider.streamChat()` 返回 `AsyncIterable<ProviderEvent>`，归一化 text/reasoning/tool delta、usage、completed 和 error。
  - 保存 provider-native `ProviderContinuationState`；含工具调用时完整回传 DeepSeek `reasoning_content/content/tool_calls`。
  - Instrumented transport 在注入 Authorization 前保存 `providerRequest`，逐 chunk 记录原始事件、TTFT、总耗时和请求字节数。
  - 流式请求设置 `stream_options.include_usage=true`。
- [ ] **P2-4 工具注册表、执行器与只读权限路径**
  - 实现 registry、provider schema 映射、`ApprovedToolCall`、timeout/abort/输出上限。
  - ToolExecutor 只接受 `ApprovedToolCall`；只读工具也经过 schema、ownership、workspace 不变量和只读快速放行，不提供绕过入口。
  - 注册 `read_file/list_dir/glob/grep`；结果使用统一有界信封。
- [ ] **P2-5 Path Guard**
  - 处理相对路径、绝对路径、UNC、大小写、`..`、symlink、junction 和最近已存在父目录。
  - 打开前和打开后复核真实路径；所有文件/搜索工具复用同一实现。
- [ ] **P2-6 上下文预算与协议完整性**
  - 使用保守 token 估算并预留输出窗口；记录估算器版本。
  - 截断必须保留 system、最近用户轮次、未完成工具链和 provider state。
  - 一次返回多个 tool call 时逐个产生 tool result；拒绝、取消、超时和错误也不得静默丢失。
- [ ] **P2-7 Context Ingress Filter**
  - 在任何工具结果进入下一次 LLM 请求前统一执行 `off/warn/confirm`。
  - `read_file` 支持路径预检；所有文本结果支持内容后检；默认 `off`。
  - `confirm` 暂停的是结果入上下文，不改变原文件，不扫描不会发送给模型的截断部分。
- [ ] **P2-8 Chat UI**
  - 接入 Naive UI、Pinia、markdown-it、Shiki。
  - 展示流式文本、reasoning 折叠、只读工具调用、run 状态和结构化错误。
  - 提供 Context Ingress `confirm` 的最小确认面板，展示命中的路径/规则和即将发送的有界内容摘要；重复决定幂等拒绝。
  - markdown-it 禁用 raw HTML；链接协议白名单化，外链只能通过受控主进程动作打开。
  - 订阅卸载时清理 listener，按 event seq 检测重复或丢片。

### 测试点

- **T-P2-1**：首次外发告知未确认时禁止创建会话；确认后只记录版本/时间，不记录密钥。
- **T-P2-2**：DeepSeek fixture 覆盖纯文本、reasoning、单工具、多工具、拒绝结果、取消、续接、异常 chunk 和 usage。
- **T-P2-3**：path guard 覆盖 `..`、绝对路径、UNC、symlink、junction、大小写和父目录替换。
- **T-P2-4**：两个并发 `startRun` 中第二个被拒；重复 `clientRequestId` 返回原结果。
- **T-P2-5**：中断发生在 LLM、工具执行和敏感数据确认等待时，run 均转为 cancelled。
- **T-P2-6**：四个只读工具在临时 workspace 内成功，越界和资源替换均失败。
- **T-P2-7**：截断后 assistant tool calls 与 tool results 一一配对，provider state 未被拆解或丢失。
- **T-P2-8**：使用唯一测试 Authorization secret 运行完整 trace，secret 不出现在任何事件；工作区自身内容不做错误脱敏。
- **T-P2-9**：`off/warn/confirm` 的路径和内容检查行为正确，confirm 未批准时内容不进入 Provider 请求。
- **T-P2-10**：恶意 Markdown、`javascript:` 链接和 HTML event handler 均不可执行。
- **T-P2-11**：关闭 session 后 active run 结束、listener 注销、trace flush，并发关闭幂等。

### 验收标准

1. 至少 9 类 DeepSeek fixture 全过，且不访问真实网络。
2. path guard 的越界/逃逸用例全部拒绝，合法 workspace 路径全部放行。
3. 使用确定性 mock Provider，在 10 文件 workspace 内用不超过 `maxStepsPerRun` 完成“读取 README 并总结”。
4. 多工具、拒绝、中断和超时场景中，每个 tool call 恰好对应一个 tool result。
5. 测试传输凭据在完整 trace 中出现次数为 0。
6. renderer DOM 中可执行的模型生成脚本节点数量为 0。
7. 会话关闭后 active run、pending ingress confirmation 和 session listener 数量均为 0。

---

## P3 · 完整权限管线与文件写入

> 目标：开放文件写入副作用，完成四档模式、审批模型、人工审批、记忆规则、TOCTOU 复核和 diff 预览。

### 功能清单

- [ ] **P3-1 完整权限管线**
  - 固定顺序：schema/registry -> ownership -> workspace/resource invariants -> mode -> deterministic policy -> Auto approver -> human approval -> final revalidation。
  - Yolo 只跳过风险黑名单、记忆规则、敏感数据阻断、模型和人工审批；不能跳过 schema、归属、workspace 和执行前复核。
  - `ApprovedToolCall` 绑定 session/run/call/tool/argsHash/preconditions/approvedBy，使用不可变对象和受限构造。
- [ ] **P3-2 文件写工具**
  - 注册 `write_file/edit_file/delete_file`，声明 effects、risk、abort、timeout 和输出上限。
  - 写入使用同目录临时文件、flush、原子 replace；失败时清理临时文件。
  - `edit_file` 的 old 文本必须唯一匹配；delete 绑定目标真实路径和内容 hash。
- [ ] **P3-3 Auto 审批模型**
  - 输入仅包含 tool metadata、完整业务 args、reason、workspacePath 和 policySignals。
  - 输出严格为 `{decision:'safe'|'dangerous', note}`。
  - 网络错误、超时、非 JSON、未知枚举和 schema 不合法全部转人工审批，不能自动放行。
- [ ] **P3-4 确定性策略与敏感数据接线**
  - 文件策略考虑操作类型、路径、文件数量和 diff 大小。
  - P2 的 ContextIngressFilter 接入完整模式语义；Yolo 跳过 warn/confirm 阻断。
  - Confirm 对所有副作用工具人工审批；ReadOnly 拒绝全部副作用。
- [ ] **P3-5 记忆规则**
  - 规则包含 effect/toolId/workspaceScope/argConstraints/expiresAt/createdFromCallId，并持久化到配置。
  - 规则不能保存密钥原文，不能改变 schema、ownership、workspace 或 final revalidation。
- [ ] **P3-6 审批与 Diff UI**
  - 展示 tool、args、reason、policySignals、diff、规则范围和 expiry。
  - 支持批准、拒绝、批准并记忆；同一 `(runId,callId)` 只接受第一次有效决定。
  - 首次启用 Yolo 必须显示其可执行任意主机命令的明确风险提示。
- [ ] **P3-7 `beforeToolCall` 接线**
  - 在调用有效性检查之后、最终审批决定之前调用。
  - hook 只能阻断或提高风险；不能修复无效调用、降低风险或直接构造 ApprovedToolCall。
- [ ] **P3-8 前端工作台与本地对话导航**
  - 按 [`frontend-spec.md`](./frontend-spec.md) 实现 frameless 顶栏、项目侧栏、对话区、对话输入区和只含 Files/Diff 的 Artifact 侧栏。
  - 一个项目映射一个 workspace；项目下持久化本地对话标题、消息历史、创建/更新时间、模型和权限模式，不引入 Task 概念。
  - 左侧只提供新对话、搜索和项目下二级对话列表；移除假对话、Share、Browser、Terminal tab 和其他无行为占位。
  - 对话搜索只索引标题、用户消息和 Agent 文本，不访问 Provider，不索引工作区文件、工具原始输出、reasoning 或 trace。
  - 首次发送消息自动创建 runtime Session；Settings 不把 Start/Close Session 作为主流程。
  - Files Explorer 通过独立受限 IPC 懒加载真实 workspace；Explorer、文件内容和 Diff 使用 tab 切换，不同时拥挤展示文件树。
  - 顶栏可恢复被折叠的项目侧栏和 Artifact 侧栏；960×640 下全部 P3 功能仍可访问。

### 测试点

- **T-P3-1**：四模式 × effects × 默认风险 × 黑名单 × 记忆规则的表驱动决策矩阵不少于 30 行。
- **T-P3-2**：审批后目标内容、symlink/junction、父目录或路径大小写发生变化时批准失效。
- **T-P3-3**：审批模型超时、网络错误、非 JSON、未知枚举和 schema 错误全部转人工审批。
- **T-P3-4**：ContextIngressFilter 在三档模式和 Yolo 下符合需求。
- **T-P3-5**：write/edit 在 abort、timeout、replace 失败和磁盘错误 mock 下不产生半写文件。
- **T-P3-6**：edit old 不存在或不唯一时返回结构化 error，目标文件逐字节不变。
- **T-P3-7**：重复、过期、跨 session 的审批决定均被拒。
- **T-P3-8**：ApprovalDialog 中的 prompt injection 文本只作为文本展示。
- **T-P3-9**：`beforeToolCall` 尝试放行无效调用或降低风险时被忽略并记录诊断。
- **T-P3-10**：正式 UI 的硬编码示例项目、示例对话、无行为按钮和未到阶段的 Browser/Terminal tab 数量为 0。
- **T-P3-11**：本地搜索可按标题和消息命中并打开对话；搜索期间 Provider、文件检索工具和 trace reader 调用次数均为 0。
- **T-P3-12**：新对话首次发送自动创建 Session；切换、删除和关闭对话后 active Run、pending approval 和 listener 均正确释放。
- **T-P3-13**：Explorer 独立加载 workspace，文件内容与 Diff tab 切换时文件树不同时展示；960×640 下侧栏均可通过顶栏恢复。

### 验收标准

1. 权限决策矩阵 100% 通过，Yolo 仍对所有执行不变量执行拒绝测试。
2. 至少 5 类 TOCTOU 变异均使原批准失效。
3. 审批模型 5 类失败无自动放行。
4. 4 类写入中断后目标文件与操作前逐字节相等，且无残留临时文件。
5. 至少 10 类凭据样本在 `confirm` 下均暂停进入 LLM 上下文。
6. Auto 模式端到端 edit 成功，trace 包含 policySignals、approver、diff hash 和 approvedBy。
7. 项目下对话列表、历史恢复和本地搜索端到端成功，搜索过程中外部请求数为 0。
8. P3 界面只展示可用能力；Files/Diff、审批和响应式布局逐项通过 [`frontend-spec.md`](./frontend-spec.md) §16。

---

## P4 · 进程执行与持久终端

> 目标：开放 `run_command` 与共享 PTY；完成进程树终止、秘密隔离、终端归属、取消和 Windows 打包验证。

### 功能清单

- [ ] **P4-1 `run_command`**
  - `mode:'process'` 使用 executable + args[]；`mode:'shell'` 使用 command 字符串并默认提高风险。
  - cwd 必须以 canonical workspace 为初始目录；UI 明确说明这不是主机 sandbox。
  - 使用白名单方式构造子进程 env，Provider key 和应用内部 secret 永不继承。
  - stdout/stderr 流式计数并有界保存；超限继续 drain，返回 `truncated/totalBytes/discardedHash`。
- [ ] **P4-2 进程树终止与命令信号**
  - Windows 实现可验证的进程树管理（优先 Job Object；不可用时使用受控 tree-kill fallback），记录采用的策略。
  - timeout/abort 先请求优雅退出，超过 grace period 强制终止。
  - shell、重定向、管道、命令替换、发布/部署、批量删除和凭据修改只作为风险信号，不宣称完整解析 shell。
- [ ] **P4-3 PTY 池与终端工具**
  - 接入 `node-pty`，实现 open/send/read/list/close/resize。
  - `terminal_open/send/close` 作为副作用工具经过完整权限管线；read/list/resize 经过校验和只读快速放行。
  - renderer 人类输入走 `terminal:input`，不经过 Agent 审批，但必须校验 sender、session 和 terminal ownership。
  - PTY 属于 session；中断 run 不关闭 PTY，会话关闭或应用退出必须关闭。
  - 原始 ANSI 输出进入 UI；有限 ByteRingBuffer 保存 scrollback；给 LLM 的 read 结果 strip ANSI。
- [ ] **P4-4 终端 UI**
  - 对话输入区位于对话区内部且只占中间对话工作列宽度；Terminal 位于完整对话区之后、对话输入区下方，只占对话工作列宽度，不出现在 Artifact 侧栏；顶栏和 `Ctrl+J` / `Ctrl+\`` 可切换。
  - xterm.js 多 tab、输入、resize、折叠/最大化和原始 ANSI 渲染。
  - terminal event 带 seq；丢片后请求有限快照并显示状态。
- [ ] **P4-5 Native Module 与打包**
  - 配置 `@electron/rebuild`、electron-builder `asarUnpack` 和 Windows x64 native module 打包。
  - 在打包产物中验证 node-pty、safeStorage、日志目录和进程终止。

### 测试点

- **T-P4-1**：至少 3 种嵌套 child process 在 abort 后无残留 PID。
- **T-P4-2**：长跑命令重复 5 次，均在 `timeout + grace` 内结束并返回 timeout。
- **T-P4-3**：产生 100MB stdout 时内存保持有界，`totalBytes` 和 `discardedHash` 正确。
- **T-P4-4**：唯一 Provider key sentinel 不出现在子进程环境中。
- **T-P4-5**：跨 session terminalId 操作被拒；中断 run 后 PTY 存活；关闭 session 后 PTY 退出。
- **T-P4-6**：open/send/close 在 ReadOnly/Auto/Confirm/Yolo 中符合权限矩阵。
- **T-P4-7**：scrollback 超限只丢最旧字节，`terminal_read` 无 ANSI 且受 lines/bytes 限制。
- **T-P4-8**：seq 丢片触发一次快照恢复，不重复渲染已有 chunk。
- **T-P4-9**：Windows 安装/解包产物可启动 PTY、运行并取消命令、完成 safeStorage round-trip。

### 验收标准

1. 3 类嵌套 spawn 的残留子进程数为 0。
2. 5 次 timeout 测试无 hang，结束时间不超过配置窗口。
3. 100MB 输出测试中 Agent 保存内容不超过配置上限，内存不随总输出线性增长。
4. 子进程 env 中 Provider key sentinel 出现次数为 0。
5. session 关闭和应用退出后所属 PTY/command PID 数量为 0。
6. Windows 打包产物中的 node-pty、safeStorage 和日志写入 smoke test 全过。

---

## P5 · Skills、回放入口与 MVP 收尾

> 目标：完成 Skills、终端体验收尾、离线回放/分叉引擎和 cache 统计。完整日志清理与回放可视化 GUI 不在 MVP。

### 功能清单

- [ ] **P5-1 SkillsManager**
  - 扫描 `userData/skills/*.md`，拒绝 symlink 和超大文件；使用安全 YAML schema，禁止自定义 tag。
  - 格式错误、缺字段和重复 name 跳过并记诊断，不中断启动。
  - 计算 sha256，与 `index.json` 的 source/enabled/trustedAt 合并；首次发现的手工文件记录为 `source:manual` 且默认 `enabled=false`，只索引已启用 skill。
  - 摘要按名称排序注入 system prompt，受总字符/token 上限约束。
- [ ] **P5-2 `read_skill`**
  - 仅按内存索引的精确 name 读取，不做路径拼接。
  - 不触发模型/人工审批，但仍经过 registry schema、索引归属、输出上限和只读 ApprovedToolCall 快速路径。
  - 返回正文时附 source 和 sha256，trace 可定位实际版本。
- [ ] **P5-3 安装与启用**
  - 支持直接放文件后 refresh、HTTPS URL 下载、主进程文件选择器上传。
  - URL 每次跳转都重新解析并限制 DNS/远端地址、重定向、超时和大小；拒绝 loopback、link-local、RFC1918、ULA、非 HTTPS 和 URL 内嵌凭据。
  - 下载流实际连接地址也必须通过私网检查，避免只做预解析产生 DNS rebinding 窗口。
  - 安装使用原子写，重复 name 不覆盖；默认 `enabled=false`。
  - 实现 list/install/choose/refresh/setEnabled IPC 及管理 UI。
- [ ] **P5-4 Trace Replay 与 Fork**
  - offline replay 从 trace reader + reducer 重建 UI 状态，支持 headless 测试和基础调试入口，不实现完整可视化管理 GUI。
  - fork 从任一 `llm.request` 恢复完整 providerRequest，用当前凭据重新发送，写入新 trace 和 `forkedFromEventId`。
  - 历史工具结果只作为已记录请求上下文使用，默认不重新执行任何历史工具；新响应提出的新工具调用仍按正常权限流程处理。
- [ ] **P5-5 Cache 与时延统计**
  - 汇总 Provider 原始 usage、cache hit/miss token、TTFT、总延迟、请求字节数和 `prefixFingerprints[]`。
  - cache 是否命中只采用 Provider usage，不根据本地 hash 推断。
  - 提供基础统计入口；完整分析可视化后移。
- [ ] **P5-6 终端与错误体验收尾**
  - 完成多 tab、重连快照、seq 丢片提示和资源关闭状态。
  - Provider、工具、日志、Skill 和 replay 错误均有用户可见且不泄密的结构化展示。
  - 提供受控的“打开日志目录”和“清理已关闭 trace”基础动作；完整日志管理 GUI 继续后移。

### 测试点

- **T-P5-1**：恶意 YAML、缺字段、重复 name、symlink、超大文件均被跳过或拒绝，应用正常启动。
- **T-P5-2**：HTTP、URL 凭据、环回、链路本地、RFC1918、ULA、重定向到私网和 DNS rebinding 模拟均被拒。
- **T-P5-3**：skill name 含 `..`、`/`、`\` 时返回 error，文件系统读取调用次数为 0。
- **T-P5-4**：摘要超限后总长度不超过上限，且每个启用 skill 至少保留 name。
- **T-P5-5**：三段不同复杂度 trace 的 offline replay 状态序列逐字段一致。
- **T-P5-6**：fork 新 trace 含 `forkedFromEventId`，历史写文件/命令/terminal side effect 的实际执行次数为 0。
- **T-P5-7**：DeepSeek reasoning continuation 和 usage fixture 无字段丢失；未来 Provider 的不透明字段契约保留为 TODO fixture。
- **T-P5-8**：cache 统计值与原始 usage 完全相等，缺失字段显示为“Provider 未提供”而不是本地推断值。

### 验收标准

1. 5 类 Skill 异常均不产生未捕获异常。
2. 至少 9 类 SSRF/下载负向用例全部拒绝。
3. name 路径注入测试中越界文件读取次数为 0。
4. 三段 trace 的 replay 状态与预期 100% 一致。
5. fork 对历史副作用的实际执行次数为 0。
6. DeepSeek 提供 cache hit/miss usage 时原样展示；Provider 未提供时明确标记缺失。

---

## 阶段门禁总览

| 阶段 | 新开放能力 | 进入下一阶段前必须通过 |
|---|---|---|
| P0 | 无 | 安全 preload、renderer sandbox、CSP、导航限制、Windows CI/build |
| P1 | 无 | 契约单一来源、secret 隔离、logger 有界、IPC 校验、replay reducer |
| P2 | workspace 只读与 Provider 数据外发 | 首次告知、DeepSeek 契约、path guard、上下文协议不变量、session 清理 |
| P3 | 文件写入 | 权限矩阵、TOCTOU、审批降级、写入原子性、敏感数据模式 |
| P4 | 进程与 PTY | 进程树终止、秘密隔离、PTY 归属/清理、Windows 打包 smoke |
| P5 | 用户主动安装/启用 Skills | SSRF、Skill 容错、回放保真、fork 不重执行副作用 |

---

## MVP 完成定义（DoD）

P0-P5 全部验收标准通过，并满足：

1. Windows 打包产物完成真实流程：首次外发告知与 Provider 配置 -> 选择 workspace -> 创建 Auto 会话 -> 读取代码 -> 经审批修改文件 -> 经审批运行测试 -> 在共享终端观察/输入 -> 关闭会话。
2. 上述流程关闭后无 active run、pending approval、command child process 或 PTY 残留。
3. 开启调试日志时，进入 Agent/LLM 的实际数据、Provider 请求/流/响应、审批和有界工具结果均可追踪；传输层凭据不进入 trace。
4. 同一 trace 可在不访问 Provider、不执行工具的条件下确定性重建消息、run、审批、工具和终端 UI 状态。
5. 路径逃逸、SSRF、renderer XSS、IPC 伪造、跨 session 资源访问和传输凭据泄漏的成功次数均为 0，相关负向测试全部通过。
6. Windows 安装产物中 safeStorage、node-pty、日志、文件工具和进程清理均通过 smoke test。

### 明确不在 MVP

- GLM、Anthropic、OpenAI 等额外 Provider。
- 代码库 embedding/RAG。
- MCP 客户端。
- 插件加载器和插件市场。
- 完整日志清理 GUI、完整 trace 回放/Cache 分析可视化 GUI。
- 云端对话同步、跨设备历史和团队共享项目。
- Agent Runtime 迁移到 `utilityProcess`。
- macOS/Linux 正式打包与发布门禁。

---

## 与需求/架构的可追溯映射

| 阶段 | 架构章节 | 需求章节 |
|---|---|---|
| P0 | §1.3、§7、§14、§15.3 | §3.7、§7 |
| P1 | §2、§7、§10、§11、§12 | §5、§6、§7 |
| P2 | §3、§4、§7、§9.3 | §2.1、§2.2.2、§2.3、§2.4、§3.6、§4.1 |
| P3 | §2.1、§9、§13 | §2.2.1、§3、§4.1.1、§4.3、§4.6 |
| P4 | §2.1、§8、§14.1 | §2.2.3、§2.2.4、§4.2、§7 |
| P5 | §5、§8、§11.4 | §2.5、§4.5、§5.3 |
