# 前端产品与验收规范 · Zch Coding Agent

> 状态：Backend Architecture v2.1 P0–P13 配套规范 · 最后更新 2026-08-02
> 配套：[`requirements.md`](./requirements.md)（产品能力）、[`architecture.md`](./architecture.md)（技术边界）、[`road-map.md`](./road-map.md)（实施方向）。
> 本文档是前端信息架构、交互行为、阶段展示和验收标准的权威依据；发生冲突时以本文档为准。
> v2.1 状态所有权和恢复行为已经实现；明确延后项见架构文档 §21。

---

## 1. 目标与原则

前端不是通用聊天网页，而是本地 Coding Agent 的工作台。它必须同时让用户完成对话、理解 Agent 行为、审查副作用，并访问工作区文件和终端。

固定原则：

1. **真实功能优先**：未实现的能力不显示可点击占位，不使用假对话、假文件或无行为按钮填充界面。
2. **对话是主流程**：消息、推理和工具调用集中在对话流；瞬时操作 warning/error 使用全局 NMessage，不插到历史队列。同一工具状态不在多个侧栏重复展示。
3. **审查与执行分区**：Files/Diff 位于右侧 Artifact 侧栏；Terminal 位于对话区下方的底部面板。
4. **内部状态最小暴露**：`sessionId/runId/callId` 不作为常驻产品信息展示；只有运行、等待审批、取消和错误等用户需处理的状态可见。
5. **阶段能力诚实**：Terminal 到 P4 才出现；Browser 属于 Post-MVP；当前阶段不展示对应 tab 或占位页。
6. **安全边界不下沉**：renderer 只展示和发起版本化 IPC；workspace、schema、资源归属和权限判断仍由主进程执行。
7. **后端提交驱动**：durable state 只在收到 command commit 回包或 backend commit event 后更新；两者进入同一个 revision reconciler，不做定时轮询。
8. **Codex 信息结构 + VS Code 工作区习惯**：整体结构参考 Codex；窗口布局控制、文件审查和底部终端参考 VS Code。
9. **Naive UI 组件优先**：已有 Naive UI 组件能够满足需求时，不重复用裸 DOM 和自定义 CSS 仿造同类控件。应用自有的滚动区域统一使用 `NScrollbar`，避免原生滚动条出现或消失时改变内容宽度；xterm.js、textarea/input、代码块、JSON 和 Diff 等局部滚动，以及 Naive UI 组件内部已经管理的滚动除外。

---

## 2. 产品术语

### 2.1 项目（Project）

- 一个项目对应一个 canonical workspace，即一个本地目录。
- UI 使用“项目”作为用户概念，不同时展示“项目”和“工作区”两个重复层级。
- Renderer 保存 backend `ProjectRecord` 的副本；项目列表、名称、路径和 revision 不从本地 UI 状态单独恢复或改写。
- 项目项显示目录名；完整路径只在 tooltip、项目设置和 Artifact header 中显示。
- 添加项目等价于通过主进程目录选择器选择 workspace。
- 移除项目只移除应用记录，不删除本地目录和文件。

### 2.2 对话（Conversation）

- “对话”是持久化 `Session` 在 UI 中的产品名称，不是另一种领域实体。
- 对话标题、项目、完整消息、模型、权限模式、Goal/Plan 和时间来自 backend-owned Session state。
- Renderer 使用 shared `MessageRecord` 原样保存 backend 副本，根据内部 `kind` 和有序 `parts` 决定展示；不能补造 Provider wire role、请求 DTO 或另一套消息类型。
- Draft 和 draft attachments 只属于 renderer 输入组件，不要求跨 Session 切换、renderer reload 或应用重启恢复。
- 点击“新对话”只创建 renderer-only composer draft；首次成功发送时才由一个 backend command 原子创建并持久化 Session、initial Messages 和 Active Run。不存在第二套 renderer-owned ConversationRecord，也不存在 `conversationId -> sessionId` 绑定。
- Renderer 可以分页缓存 Session 数据并派生 timeline，但不能保存或回写另一套 ConversationRecord。
- 不引入 Task 概念。

### 2.3 Session 与 Run

- Session 是持久化对话，但 UI 仍显示“对话”而不显示内部 ID；Run 不作为左侧导航层级。
- 同一 Session 同一时间最多一个 active Run。
- 全应用 `maxConcurrentRuns` 范围为 `1..32`，新安装默认最多 16 个 active Run，升级保留已有用户值；达到上限后新 Run 直接拒绝，不另设 provider call 上限。
- 同一 canonical workspace 最多一个非只读 writer Run；ReadOnly Run 可与 writer 和其他 ReadOnly Run 并行，不同 workspace 的 writer 可并行。
- Run 活动时同一 Session 再次发送普通消息默认拒绝；排队不在当前范围。

### 2.4 Artifact

- Artifact 是当前项目中由 Agent 产生、查看或依赖的上下文对象，包括文件内容、Diff、计划和项目级代码智能配置。
- Artifact 侧栏承载当前 workspace 的项目状态视图；全局应用设置仍放在 Settings 页面。
- Terminal 不是 Artifact；Browser 在 Post-MVP 重新设计。

---

## 3. 总体信息架构

应用采用单一 Workbench，不为 Chat、Files、Diff 分别创建全屏路由页面。

```text
┌────────────────────────────── 顶栏 ──────────────────────────────┐
│ 应用名称      当前项目         布局控制  设置  最小化/最大化/关闭 │
├──────────────┬──────────────────────────┬────────────────────────┤
│ 项目侧栏      │ 对话工作列                │ Artifact 侧栏          │
│              │ ┌────── 对话区 ─────────┐ │ Files / Diff / Plan /  │
│              │                         │ │ Project                │
│ + 新对话      │ │ 对话标题 + 活动状态   │ │                        │
│ 搜索对话      │ │ 消息 / 工具 / 审批    │ │ Explorer / File / Diff │
│              │ │                       │ │                        │
│ 项目          │ │ 对话输入区            │ │                        │
│ └─ 对话       │ └───────────────────────┘ │                        │
│              │ Terminal 底部面板（P4）  │                        │
└──────────────┴──────────────────────────┴────────────────────────┘
```

区域命名固定为：

- 左侧：**项目侧栏（Project Sidebar）**
- 中间：**对话工作列（Conversation Column）**
- 对话工作列上部：**对话区（Conversation Area）**，包含 Header、消息流和对话输入区
- 右侧：**Artifact 侧栏（Artifact Sidebar）**
- 对话工作列下部、完整对话区之后：**底部面板（Bottom Panel）**
- 对话区内部底部：**对话输入区（Message Input）**

文档和 UI 不使用含糊的“左栏/右 Inspector/Composer”作为产品名称。

---

## 4. 顶栏与窗口壳

### 4.1 Frameless Window

- Electron 使用 frameless window；前端顶栏是真实拖拽区。
- 可点击控件必须设置为 non-draggable。
- 应用内容铺满窗口，不在系统窗口内再绘制带 margin 和圆角的假窗口。
- 右上角提供符合 Windows 使用习惯的最小化、最大化/还原和关闭按钮。

### 4.2 顶栏内容

左侧：

- 应用图标。
- `Zch Coding Agent`。

中间：

- 当前项目目录名。
- 未选择项目时显示 `Choose workspace`。
- 点击打开项目选择或项目设置。

右侧按顺序显示：

1. 切换项目侧栏。
2. 切换 Artifact 侧栏。
3. P4 起显示：切换 Terminal 底部面板。
4. Settings。
5. 窗口控制按钮。

P3 不显示 Share、全局 Search 或其他无实现按钮。对话搜索入口固定在项目侧栏。

### 4.3 快捷键

- `Ctrl+B`：切换项目侧栏。
- `Ctrl+Shift+B`：切换 Artifact 侧栏。
- P4 起 `Ctrl+J`：切换底部面板。
- P4 起 `Ctrl+\``：直接切换 Terminal。

快捷键冲突时应允许在设置中重新绑定；自定义快捷键不属于首个 MVP 验收门禁。

---

## 5. 项目侧栏

### 5.1 固定结构

```text
+ 新对话
搜索对话

项目
└─ workspace-name
   ├─ 对话标题 A
   ├─ 对话标题 B
   └─ 对话标题 C
```

项目侧栏只包含项目和对话，不展示：

- Tool Activity。
- 模型或权限说明。
- session/run ID。
- Files、Diff、Terminal、Browser。
- API Key、Trace 或日志状态。

### 5.2 新对话

- 有当前项目时，在该项目下创建新对话并聚焦输入框。
- 没有项目时，先打开目录选择器，成功后创建项目和新对话。
- 当前 Run 活动时可以新建或切换对话，不中断后台 Run，也不显示“中断并切换”确认框。
- 点击新对话只创建当前 renderer 的临时 draft 和候选 `sessionId`，不调用 backend、不进入 Sidebar。
- 首次发送成功 commit 后才把候选 identity 安装为 durable Session；切换 Session、再次新建或 renderer reload 会直接丢弃未发送 draft。

### 5.3 对话标题

- 未发送 draft 可在主区显示 `New conversation`，但不占用 Sidebar；首次发送 commit 后才出现 durable 标题。
- 第一条用户消息发送成功后，使用本地截断标题或 Provider 标题生成结果更新。
- Provider 标题生成失败不影响对话执行。
- 支持重命名和删除。
- 删除对话必须二次确认；不删除项目文件。

### 5.4 对话搜索

- 搜索范围：对话标题，以及 `user_input/assistant_turn` records 中 `type = 'text'` 的 parts。
- 默认跨已添加项目搜索，结果按项目分组。
- 不搜索工作区文件内容、tool-call 参数、tool-result/JSON payload、reasoning、continuation、trace 或 API Key。
- 结果显示项目名、对话标题、匹配摘要和更新时间。
- 点击结果打开对应项目和对话。
- 搜索必须在本地完成，不把搜索内容发送给 Provider。

### 5.5 真实数据要求

- 禁止在正式 UI 中硬编码示例项目或示例对话。
- 空列表显示简短空状态，不用假数据撑满界面。
- 对话列表排序默认按 `updatedAt` 倒序。

### 5.6 并发状态与破坏性操作

- 对话项和搜索结果显示一个最高优先级运行状态：`Awaiting approval` → `Writer` → `Read-only locked` → `Cancelling` → `Running` → `Failed` → `Completed`。
- 后台 approval 只在其所属对话显示 badge；点击后 ApprovalCard 使用显式 `sessionId/runId/callId` 提交，不得复用先前 active Session 的标识。
- running、start pending 或 awaiting approval 的 conversation 禁用 delete、fork 和 revert，并通过 tooltip 说明原因；项目内任一 conversation busy 时禁止 remove project。
- 对话切换不得让 timeline、error、pending approval 或 runtime event 串到错误 Session。产品不验收未发送 draft/context attachments 的跨 Session 恢复。

---

## 6. 对话区

对话区是对话工作列上部的完整交互容器，依次包含 Header、消息流和对话输入区。对话输入区不得越过对话工作列边界，也不得跨到项目侧栏或 Artifact 侧栏下方。

### 6.1 Header

- 显示当前对话标题。
- 空闲时不显示 `NO SESSION`、`IDLE` 等内部状态 badge。
- 仅在以下情况显示短状态：`Running`、`Writer`、`Read-only locked`、`Waiting for approval`、`Cancelling`、`Failed`。
- 状态不得挤压对话标题；窄宽度下优先保留标题和 Stop 操作。

### 6.2 消息流

支持以下内容：

- 用户消息。
- Agent 流式 Markdown。
- `normalizedReasoningText` reasoning 折叠区，默认折叠；没有可读投影时不显示空 reasoning 容器。
- 工具调用卡。
- 审批卡。
- 结构化错误和重试提示。

消息流要求：

- 只有 `kind = 'user_input'` 的 Message 显示为用户气泡；orchestrator、runtime context、harness 或 compact summary 不能伪装成用户亲自输入。
- Renderer 按 part 的原始顺序渲染：`text` 进入 Markdown，assistant `tool_call` 与对应 `tool_result` 组成稳定工具卡；受支持的 JSON result 只进入有界、可展开的结构化视图。它不能把 parts 重新编译成 Provider DTO。
- `kind = 'assistant_turn'` / `'tool_result'` 的完整 records 用于重建稳定消息和工具卡；Active Run 的 delta/runtime events 只负责未完成状态，不能由 renderer 自行提交为 Message。
- Renderer 只能展示 `normalizedReasoningText`，必须把 `providerContinuation` 当作 opaque canonical data，不解析、不修改，也不展示其中的原始 CoT、signature、encrypted/redacted block、response id 或 output item。
- Renderer 根据按 `kind` 校验的 typed metadata 展示 attachment provenance、usage、tool/approval/compact 摘要；不能把未知 metadata 字段转成 Provider request 内容。
- 自动跟随流式输出；用户主动向上滚动后停止强制跟随，并显示“回到底部”。
- 长代码和长路径不撑破布局。
- Markdown 禁止 raw HTML；外链协议白名单化并通过受控主进程动作打开。
- 模型、工具和审批中的 prompt injection 文本只作为文本显示。

### 6.3 工具调用卡

默认摘要显示：

- 工具名。
- reason 摘要。
- `Proposed / Waiting / Running / Completed / Denied / Failed` 状态。
- 结果摘要。

展开后显示：

- 完整业务参数。
- 有界工具结果。
- 错误 code 和 message。

约束：

- 工具活动只在对话流展示一次。
- Files/Diff 可展示工具产生的 Artifact，但不重复绘制完整 Tool Activity 列表。
- 文件写工具进入审批时，工具卡与 Diff 侧栏共享同一个 `(sessionId, runId, callId)` 状态。

### 6.4 文件与 Context 审批卡

文件副作用审批必须显示：

- tool。
- 完整业务 args。
- reason。
- policySignals。
- bounded diff。
- workspace scope。
- 规则 expiry。
- `Approve`、`Deny`、`Approve & remember`。

Context Ingress 审批必须显示：

- 来源工具和路径。
- 命中的规则。
- 即将发送给 Provider 的有界摘要。
- `Allow context` 和 `Withhold context`。
- 不提供记忆文件副作用规则的按钮。

共同要求：

- 同一 call 只接受第一次有效决定。
- 决定提交后所有重复按钮立即 disabled。
- 审批过期、Run 中断或对话关闭后显示失效状态。
- 文件状态在审批后变化时显示 `RESOURCE_CHANGED`，不得继续使用旧 Diff 执行。

---

## 7. 对话输入区

对话输入区属于对话区，固定在消息流下方，并与消息流保持相同的对话列宽。它不是 Workbench 的全宽底栏。

### 7.1 内容

对话输入区固定包含：

- 多行消息输入框。
- 当前 Provider/模型选择。
- 当前权限模式选择。
- Send；Run 活动时替换为 Stop。

不包含：

- Terminal 快捷入口。
- workspace 路径。
- session 状态面板。
- Tool Activity。

### 7.2 发送行为

- `Enter` 发送。
- `Shift+Enter` 换行。
- IME composition 期间按 Enter 不发送。
- 空消息不可发送。
- active Run、start pending、pending approval 或 readonly mode 同步失败时不可再次发送；显示明确原因。
- Stop 触发 run interrupt，不关闭 P4 PTY。

### 7.3 模型与模式

- 模型按钮显示实际模型名，不只显示 Provider 名。
- 点击模型按钮使用可搜索的下拉框，只列出对应 Provider 的 `enabledModelIds`。历史 Session 若仍引用已停用模型，可以显示原值，但必须先改选启用模型才能发送。管理启用池、Base URL/API Key 进入 Settings。
- 权限模式为 ReadOnly、Auto、Confirm、Yolo。
- 首次启用 Yolo 必须显示 host-level side effects 风险并记录告知版本。
- 模型和模式控件使用紧凑下拉，不使用侧栏大卡片。
- 模型和模式修改必须发送 Session command；控件只在收到后端确认的 entity/state revision 后进入 committed 状态，失败时回到后端值并显示错误。
- 同 workspace 其他 writer 活跃时，后端发布 `Read-only locked` 运行约束；当前 Session 保存的权限模式不因用户切换对话而被 renderer 偷改为 ReadOnly。
- `Read-only locked` 期间仍可按 Session 当前模式展示选择值，但非只读 Run 的发送入口禁用并指明 writer Session；用户可以明确将 Session 模式改为 ReadOnly 后启动只读分析。
- writer 结束后解除运行约束，不自动改变 Session 已保存的模式。

### 7.4 布局验收

- Send/Stop 按钮距输入区右侧和底部的视觉距离一致。
- 图标与文字垂直居中。
- 控件不足一行时允许模型/模式收缩，不允许 Send 按钮错位。

---

## 8. Artifact 侧栏

### 8.1 阶段可见性

当前 Artifact 侧栏可显示：

- Files
- Diff
- Plan
- Project

不显示：

- Terminal
- Browser

Browser 明确属于 Post-MVP，不在 P0-P5 保留空 tab 或 Coming Soon 占位。

### 8.2 Files

Files 内部使用二级 tab：

- Explorer
- 一个或多个已打开文件

交互规则：

- Explorer 与文件内容不同时展示。
- 点击文件后切换到文件 tab，文件树隐藏。
- 点击 Explorer tab 返回文件树。
- 文件 tab 支持关闭；关闭当前文件后回到最近 tab 或 Explorer。
- Artifact header 始终显示当前项目目录名；完整路径可复制并有 tooltip。
- Explorer 使用树形视图，通过独立、受限 IPC 懒加载，不依赖 Agent 最近是否调用 `list_dir`。目录首次展开时加载并缓存子节点，后续收缩与展开不重复请求；切换项目时清空树缓存并加载新根节点。
- 点击文件通过主进程 PathGuard 读取有界内容。
- viewer 只读，支持行号、语法高亮、截断提示和加载错误。
- symlink、junction、路径大小写和越界检查沿用主进程安全不变量。

### 8.3 Diff

- pending 文件审批出现时，Artifact 侧栏自动切到 Diff，但不得抢走输入焦点。
- 显示目标路径、操作类型、diff hash、截断状态和统一 diff。
- Diff 活动时不同时展示 Explorer。
- 审批按钮可同时出现在对话卡和 Diff footer，但共享同一 store 状态。
- 审批完成后从后端加载当前 Session 的持久化文件变更历史；切换对话或项目时必须按 `sessionId` 重新查询，不能复用上一对话的列表。
- Renderer 只缓存后端返回的 `FileChangeSummary`；它不包含 `beforeContent` 恢复快照。变更历史不得从 Message/tool card 反向解析或在 Pinia 中自行合成。
- 变更列表显示路径、操作、时间、diff hash 和回退状态；选择记录后显示对应统一 diff。
- “回退此变更”必须先显示明确确认，运行期间禁用。主进程返回 `CONFLICT` 时在当前视口显示错误，不能假装回退成功。
- 大 Diff 必须有明确截断提示，不能让 UI 假装展示了完整变化。

### 8.4 Project

ProjectModel/Serena/code intelligence 暂停期间不显示 Project artifact tab，也不在 Renderer 中加载或编辑 ProjectModel。文件浏览仍由 Files tab 提供；普通 prompt harness 的 module marker 探测只存在于本次 runtime context，不形成 UI 状态或 workspace 文件。Swarm 完成后的 SQLite 迁移与 Project UI 重建见 roadmap。

---

## 9. Terminal 底部面板（P4）

Terminal 不属于 P3 UI，P4 完成 PTY 后才显示。

### 9.1 位置与入口

- Terminal 在完整对话区下方打开；垂直顺序固定为“对话 Header / 消息流 / 对话输入区 / Terminal”。
- Terminal 只占对话工作列宽度，不延伸到项目侧栏或 Artifact 侧栏下方，也不出现在 Artifact 侧栏。
- 顶栏右侧布局按钮负责切换底部面板。
- `Ctrl+J` 切换底部面板；`Ctrl+\`` 直接切换 Terminal。
- 对话输入区不放 Terminal pill 或快捷按钮。

### 9.2 面板行为

- 支持拖拽调整高度。
- 支持折叠和最大化到对话工作列可用高度。
- 最小高度 160px；默认高度约为对话工作列的 35%。
- 多 terminal tab，支持新建、切换、关闭。
- tab 显示名称、运行状态和关闭按钮。
- 原始 ANSI 流由 xterm.js 渲染。
- 人类输入直接进入当前 PTY，但仍校验 sender、session 和 terminal ownership。

### 9.3 生命周期

- Terminal 归属于持久化 Session 对应的 backend `LiveSessionContext`。
- 切换对话时切换到该对话所属 terminal 集合。
- Interrupt Run 不关闭 PTY。
- 归档/删除 Session、移除项目或退出应用时关闭所属 PTY。

---

## 10. Settings

Settings 使用一个 modal，内部按 tab 分组，不使用占满主界面的独立路由。

### 10.0 General

- 界面语言支持简体中文和英文，切换后立即更新 UI，并同步主进程 `assistant.language`。
- 展示可编辑的中英文 assistant preferences，支持保存和恢复默认值；base harness instructions 不在设置页中编辑。
- 保存后的偏好从已有对话的下一轮模型调用开始生效；不得把 API Key 等凭据写入偏好。

### 10.1 Project

- 当前项目路径。
- Choose workspace / Add project。
- 从应用记录移除项目。
- 不展示内部 session ID。

### 10.2 Provider

- Base URL。
- 主模型：新 Provider 不预填虚构模型名。用户填写 API Key 后，表单在 600ms 静默期后自动保存并立即刷新 `/models`；已有凭据时进入页面或切换 Provider 卡片也会用已保存 route 静默刷新。显式刷新按钮先排空自动保存再刷新，失败时保留上次成功缓存。
- 模型启用池与能力：可筛选穿梭框左侧显示完整目录，右侧显示 `enabledModelIds`；只有右侧模型能进入主模型、Composer、自动审批和未来 Swarm 的下拉候选。右侧模型在下方显示 Provider 返回/内置/保守默认来源；上下文长度和最大输出允许用户按模型覆盖，且解释它们分别用于本地上下文预算、自动压缩和单次生成预留。仅采用目录协议明确返回的容量字段，未知模型显示保守默认值提示。
- Token 估算：默认保守估算，可切换为自定义 `bytesPerToken`；说明该值只影响预算估算，不能关闭字节/行数硬限制。
- Reasoning 开关。
- API Key 配置状态、更新和清除。
- Provider 名称、类型、地址、主模型、Reasoning、Token 估算和模型覆盖均自动保存；不显示手动“保存 Provider”按钮。切换卡片或退出页面前排空当前保存，失败时留在当前草稿并显示错误。
- renderer 不读取或回显已保存 API Key。

### 10.3 Auto approval

- Auto approval 是全局路由配置，不属于任一 Provider 卡片草稿，使用独立保存动作。
- Auto approval 显示在 Permissions 页面，不占用独立设置导航项。
- 配置引用一个已存在的 Provider 实例以复用 `providerType/baseURL/credential`，并独立选择审批模型。
- 审批模型候选只来自所选 Provider 的 `enabledModelIds`，不得错误复用当前正在编辑的 Provider 模型列表。
- Provider 保存不能修改 Auto approval；删除正被审批路由引用的 Provider 时回退到明确的可用 Provider。

### 10.4 Permissions

- 默认权限模式。
- 全局 Auto approval Provider 与模型。
- Sensitive Data：off/warn/confirm。
- Path globs。
- Content patterns。
- Remembered rules 列表。
- 每条规则显示 tool、workspace scope、arg constraints、expiry 和来源 call。
- 支持删除规则，不支持编辑为更宽松的任意 JSON。

### 10.5 Agents

- 提供默认关闭的只读 Subagent 开关，以及 1–1,440 分钟的 worker timeout；默认 30 分钟。
- 使用与运行限制一致的自动保存交互，并保留页首立即保存按钮和保存状态。
- 明确提示额外 Provider 请求/费用，并显示当前全局并发值；并发为 1 时说明嵌套 Agent 会被拒绝。
- 设置变更从下一次主 Run 生效；不展示隐藏 child Session、详细 transcript、模型池或自定义 child 工具列表。

### 10.6 Skills

- 展示 name、description、source、sha256 短摘要和启用状态。
- 支持 HTTPS URL、主进程文件选择器安装和手工目录 refresh。
- 新安装和首次扫描的手工 skill 默认禁用；必须由用户显式启用。
- 格式错误、重复名称、符号链接和超限文件显示诊断，不中断设置页。

### 10.7 Logging

- Trace 开关和独立风险告知。
- retention days。
- max total bytes。
- P5 提供受控的打开日志目录和清理已关闭 trace 入口。
- 提供 trace 列表、离线 replay 摘要和 Prompt Inspector；不提供 trace fork 或使用当前凭据重放 Provider 请求的入口。
- 展示 Provider 原始 usage 派生的 token/cache 指标与 TTFT/总时延；字段缺失时明确显示 `Provider not provided`。
- 完整事件时间轴、搜索、导出和批量管理属于 Post-MVP。

### 10.8 Session 生命周期

- Settings 不展示 `Start session` / `Close session` 作为主流程按钮。
- Settings 提供“已归档对话”菜单项：分页列出 archived Session，支持恢复；永久删除使用 Naive UI 确认框，并在存在 fork 子 Session 时由 backend 拒绝。
- 新建对话只产生 renderer draft；首次发送用一个 backend command 创建 durable Session/initial Messages 并启动 Active Run。
- 切换对话不关闭后台 `LiveSessionContext` 或 `ActiveRunExecution`；归档/删除 Session、移除项目和退出应用才清理对应 runtime 资源。退出时统一取消 active runs、释放 workspace writer 并关闭 PTY。
- 未发送 draft 与 context attachments 不进入 backend，不保证 A → B → A、renderer reload 或应用重启后恢复。
- 应用重启后从 backend Session snapshot 恢复完整 messages、Goal/Plan、模型和模式；partial assistant output、pending approval 和 Active Run 可以丢失，不显示伪造的 interrupted message。

---

## 11. 状态与错误

前端必须覆盖以下显式状态：

| 状态             | 对话区           | 输入区                   | Artifact                    |
| ---------------- | ---------------- | ------------------------ | --------------------------- |
| 未选择项目       | 引导选择目录     | Send disabled            | 空状态                      |
| Provider 未配置  | 配置提示         | Send disabled            | 可浏览本地文件              |
| Idle             | 不显示内部 badge | 可输入                   | 保留当前 tab                |
| Calling LLM      | 流式占位/文本    | Stop                     | 保留当前 tab                |
| Running tool     | 工具卡状态更新   | Stop                     | 文件工具可打开相关 Artifact |
| Waiting approval | 审批卡           | 禁止发送，可 Stop        | 自动显示 Diff 或相关文件    |
| Workspace writer | Writer badge     | 当前 Run 的普通控制      | 保留内容                    |
| Read-only locked | Read-only locked | 允许启动只读分析         | 保留内容并提示状态可能过期  |
| Cancelling       | 短状态           | Stop disabled            | 保留内容                    |
| Failed           | NMessage error   | 恢复输入，可重试用户消息 | 保留审查上下文              |
| Session archived | 历史只读         | Unarchive 后可发送       | 恢复持久化 Artifact 元数据  |

要求：

- 错误消息对用户可见但不泄露 API Key、Authorization header 或主进程堆栈。
- ConversationTimeline 只投影 durable messages、live overlay、工具和审批，不渲染全局 warning/error。NMessage 位于 46px frameless 顶栏下方：warning 10 秒自动消失且可提前关闭，error 不自动消失；最多显示 5 条，其余排队，不挤掉未关闭 error。
- 相同 code、Session 和 message 在活动/排队期间去重。后台 Session 的通知显示对话标题但不切换当前对话；日志 capture 持续状态显示在 Header/设置，Provider 隐私 notice 保留在 composer 附近。
- 创建、重命名、归档、切换模型/模式和发送消息期间只设置 pending/error UI，不先改 durable replica；commit 失败时继续显示后端原值。
- 恢复使用 `session.changed` commit；永久删除使用 `session.removed` commit。删除只清理本地 Session/Message/FileChange durable 数据，不修改 workspace 文件，也不代替日志设置中的 Trace 管理。
- Command 回包和 durable push event 使用同一个 reconciler；相同 event cursor 只应用一次，不依赖两者的到达顺序。
- Event 已先应用时，重复的成功回包仍结束当前控件的 pending，只是不重复改写副本。
- Preload 在 bootstrap query 前开始 buffer durable events；安装带 cursor 的 bootstrap snapshot 后重放更新事件，再进入 live apply，不能采用“先 query、后 subscribe”。
- Event cursor 缺口或 backend instance 变化时重新 bootstrap；Session `revision` 重复时不重复应用，revision 缺口请求 Session snapshot 并重建 message cache。
- Project、Session、Message、Goal/Plan 和 FileChange 不定时轮询；query 只用于 bootstrap、切换/分页/搜索/按需加载和缺口恢复。
- `run:stream` sequence 缺口只影响瞬时展示，可单次读取 ActiveRun snapshot，但不能轮询补 token；backend 没有可恢复 buffer 时允许丢失 partial output。
- 切换对话、卸载组件和关闭窗口时注销 renderer listener。

---

## 12. 视觉规范

### 12.1 主题范围

- P3 只验收亮色主题。
- 暗色主题单独设计和验收，不要求通过简单反色生成。
- 当前亮色风格参考 VS Code Light，内部控件采用克制圆角。

### 12.2 亮色 Tokens

| Token            | 值        | 用途                  |
| ---------------- | --------- | --------------------- |
| `background`     | `#FFFFFF` | 对话、viewer 主背景   |
| `surface`        | `#F6F8FA` | 顶栏、侧栏、次级面板  |
| `canvas`         | `#F3F3F3` | 应用底色              |
| `border`         | `#D0D7DE` | 分割线和控件边框      |
| `text-primary`   | `#24292F` | 主文本                |
| `text-secondary` | `#57606A` | 次级文本              |
| `text-muted`     | `#6E7781` | 提示和 metadata       |
| `accent`         | `#0969DA` | 主操作和活动状态      |
| `success`        | `#1A7F37` | 成功                  |
| `warning`        | `#9A6700` | 警告                  |
| `danger`         | `#CF222E` | 拒绝、失败、Yolo 风险 |

### 12.3 字体与图标

- UI：`Inter, system-ui, Segoe UI, sans-serif`。
- 代码：`Cascadia Code, Consolas, monospace`。
- 图标统一使用一个 SVG/icon font 方案，默认 16px。
- 不使用 `□`、`▢`、`＋` 等字符模拟正式图标。
- 图标与文字 gap 为 6-8px，必须共享 flex center 对齐。

### 12.4 圆角与间距

- 小控件：8px。
- 按钮、tab、工具卡：10-12px。
- 对话输入区和大卡片：14-16px。
- 应用最外层无假圆角和外 margin。
- 基础间距使用 4px 倍数；常用值为 8/12/16/24px。

---

## 13. 尺寸与响应式

目标尺寸：

- 默认：1120×760。
- 标准验收：1280×800、1440×900。
- 建议最小窗口：960×640。

宽度行为：

- 宽屏：项目侧栏、对话区、Artifact 侧栏同时显示。
- 空间不足时优先折叠 Artifact 侧栏，但顶栏保留重新打开入口。
- 更窄时允许折叠项目侧栏，但新对话和搜索仍可通过入口访问。
- 禁止使用 `display:none` 永久隐藏功能且不给恢复入口。

默认尺寸建议：

- 项目侧栏：240px，可在 220-300px 范围调整。
- Artifact 侧栏：460px，可在 380-600px 范围调整。
- 对话工作列最小宽度：480px。
- 对话输入区只占对话工作列宽度，不参与三栏的跨栏布局。
- P4 Terminal 默认高度：对话工作列 35%，并始终排列在完整对话区之后。

---

## 14. 可访问性与安全验收

- 所有 icon-only 按钮有稳定的 `aria-label` 和 tooltip。
- 键盘可访问顶栏、侧栏、消息、tab、审批和设置。
- focus ring 清晰可见，不只依赖颜色变化。
- 文本和背景满足 WCAG AA 常规文本对比度。
- 状态不能只通过红/绿颜色表达，必须同时有文本或图标。
- modal 打开时焦点被约束；关闭后返回触发按钮。
- 危险操作默认焦点不得落在确认按钮。
- Approval args/reason/diff 使用文本绑定，不通过 raw `v-html`。
- Markdown renderer 禁止 raw HTML 和 `javascript:` 等危险协议。
- renderer 不 import Electron/Node，不直接读取 workspace 或密钥。

---

## 15. 阶段可见性

| 能力                  |   P2 |         P3 |         P4 |   P5 |        Post-MVP |
| --------------------- | ---: | ---------: | ---------: | ---: | --------------: |
| 项目选择与项目侧栏    | 必须 |       必须 |       必须 | 必须 |            必须 |
| 对话列表与搜索        | 基础 | 完整本地版 |       保持 | 保持 |      可扩展同步 |
| Chat/Markdown/流式    | 必须 |       必须 |       必须 | 必须 |            必须 |
| Files Explorer/Viewer | 基础 |       必须 |       必须 | 必须 |            必须 |
| 文件审批与 Diff       |    - |       必须 |       必须 | 必须 |            必须 |
| Terminal 底部面板     |    - |     不显示 |       必须 | 必须 |            必须 |
| Skills 管理           |    - |          - |          - | 必须 |            必须 |
| Trace/Replay 基础入口 |    - | Trace 设置 | Trace 设置 | 必须 | 完整 GUI 可后移 |
| Browser               |    - |          - |          - |    - |        单独设计 |

阶段未到时使用“完全不显示”，而不是可点击占位 tab。

---

## 16. P3 前端验收清单

### 16.1 窗口与布局

- [ ] Frameless 顶栏是唯一窗口壳，无窗口套窗口。
- [ ] 拖拽区、按钮区和 Windows 窗口控制行为正确。
- [ ] 顶栏可切换项目侧栏和 Artifact 侧栏。
- [ ] 960×640 下 Files 和 Diff 仍有可恢复入口。
- [ ] UI 不出现 Browser 和 Terminal tab。

### 16.2 项目与对话

- [ ] 一个项目明确对应一个 workspace。
- [ ] 项目列表由 backend `ProjectRecord` 驱动；移除项目会清理其应用内对话数据，但不删除 workspace 文件。
- [ ] 左侧只展示新对话、搜索、项目和二级对话。
- [ ] 无硬编码示例项目或示例对话。
- [ ] 新对话在当前项目下创建；无项目时先选择目录。
- [ ] 对话标题可生成、重命名和删除。
- [ ] 搜索只在本地检索标题和消息，并能打开结果。
- [ ] 新建对话不调用 backend、不进入 Sidebar；首次发送原子创建 backend-owned Session/initial Messages 并启动内存 Active Run。
- [ ] A 运行时切到 B 不打断 A，A/B timeline、approval 和 error 不串线；draft 跨切换恢复不属于验收要求。
- [ ] Sidebar 与搜索结果按规定优先级显示 writer/running/readonly locked/approval/failed/completed 状态。
- [ ] running/start pending/approval conversation 的 delete、fork、revert 和 remove project 被禁用并说明原因。

### 16.3 对话与输入

- [ ] 流式文本、折叠 reasoning、工具卡和结构化错误正常。
- [ ] 操作 warning/error 通过 NMessage 展示，不进入 Timeline；10 秒 warning、持久 error、5 条排队、去重和后台 Session 标题符合规范。
- [ ] Reasoning 折叠区只展示 `normalizedReasoningText`；缺失时不显示，opaque `providerContinuation` 永不进入 UI。
- [ ] `kind = 'user_input'` 才渲染为用户气泡；orchestrator/runtime context/harness 不伪装成用户输入。
- [ ] `text/tool_call/tool_result` parts 按原始顺序渲染，工具卡可由完整 MessageRecords 稳定重建；Renderer 不生成 Provider DTO。
- [ ] active Run 和 pending approval 时禁止重复发送。
- [ ] Enter、Shift+Enter 和 IME 行为符合规范。
- [ ] 模型和权限模式只使用紧凑控件，不放入侧栏大卡片。
- [ ] 同 workspace writer 活跃时，其他 Session 显示 Read-only locked；renderer 不修改其持久化 mode，writer 结束后解除约束。
- [ ] Limits 只提供最大并发任务数；UI 明确 writer=1 是不可配置安全规则。
- [ ] 对话输入区没有 Terminal 入口。
- [ ] Send/Stop 按钮与底部、右侧距离一致。

### 16.4 Files 与 Diff

- [ ] Explorer 独立加载真实 workspace，不依赖 Agent 工具历史。
- [ ] 文件树和文件内容通过二级 tab 切换，不同时拥挤展示。
- [ ] 文件 viewer 只读、有界、有行号和语法高亮。
- [ ] pending 文件审批自动打开 Diff。
- [ ] Diff 与对话审批卡共享同一个决定状态。
- [ ] 大文件和大 Diff 显示截断提示。
- [ ] 应用重启后仍可按 Session 查看未被 retention 清理的文件变更，并可在 after hash 仍匹配时回退。
- [ ] Renderer 只接收 `FileChangeSummary`，恢复用 `beforeContent` 不进入 renderer state 或 DOM。

### 16.5 权限审批

- [ ] ReadOnly 写操作显示明确拒绝。
- [ ] Confirm 展示 tool、args、reason、signals、diff、scope 和 expiry。
- [ ] Deny 后文件逐字节不变。
- [ ] Approve 后落盘内容与 Diff 一致。
- [ ] Approve & remember 后显示持久化规则。
- [ ] 重复、过期、跨 Session 的决定不可再次生效。
- [ ] 文件在审批后变化时返回 `RESOURCE_CHANGED`。
- [ ] Yolo 首次启用显示 host-level side effects 告知。
- [ ] HTML、脚本和 prompt injection 只显示为文本。

### 16.6 Settings 与生命周期

- [ ] Project/Provider/Agents/Permissions/Logging 分组清晰；Agents 自动保存开关与 timeout，并显示费用和并发提示。
- [ ] API Key 不回显、不进入 renderer state 和 DOM。
- [ ] 模型目录刷新、缓存回退、可输入下拉框、未知模型能力提示和手工上下文覆盖可用。
- [ ] Sensitive Data 和 remembered rules 可配置、查看和删除。
- [ ] Settings 不把 Start/Close Session 作为主流程。
- [ ] 新对话、切换项目、删除对话和退出应用正确清理 runtime 资源。

### 16.7 自动化与人工验证

- [ ] Vue 测试覆盖空状态、审批 injection、按钮幂等和 tab 切换。
- [ ] E2E 覆盖 frameless 启动、侧栏恢复、设置和窗口关闭。
- [ ] 使用确定性 Provider fixture 验证 ReadOnly/Confirm/Auto/Yolo。
- [ ] 使用临时 Git workspace 完成一次真实 DeepSeek 冒烟测试。
- [ ] 测试结束后无 active Run、pending approval、listener 或未关闭 Session。

---

## 17. P4 Terminal 验收清单

- [ ] 顶栏出现 Terminal 底部面板开关。
- [ ] `Ctrl+J` 和 `Ctrl+\`` 行为符合规范。
- [ ] 对话输入区位于对话区内部，不跨项目侧栏或 Artifact 侧栏。
- [ ] Terminal 排列在完整对话区之后，即位于对话输入区下方，且不出现在输入区或 Artifact 侧栏。
- [ ] 面板可调整高度、折叠和最大化。
- [ ] 多 terminal tab 可新建、切换和关闭。
- [ ] 原始 ANSI 正确渲染，输入可用。
- [ ] Interrupt Run 后 PTY 保持运行。
- [ ] 切换对话时 terminal 集合正确切换。
- [ ] 关闭 Session、删除对话和退出应用后无残留 PTY。

---

## 18. 明确不做

MVP 不做：

- Browser 或网页预览面板。
- 云端对话同步和跨设备历史。
- 团队共享项目与对话。
- 多窗口工作台。
- 拖拽改变任意区域停靠位置。
- 完整 IDE 编辑器；文件 viewer 保持只读。
- 完整 trace 分析和日志管理 GUI。

Browser 在 Post-MVP 单独定义进程隔离、导航策略、预览 URL、Agent 控制权限和安全验收后再进入界面。
