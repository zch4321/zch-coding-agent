# 工作台交互规范

当前规范；返回[前端总览](../frontend-spec.md)。代码入口见 [Renderer 地图](../code-map/renderer.md)。

## 顶栏与窗口壳

### Frameless Window

- Electron 使用 frameless window；前端顶栏是真实拖拽区。
- 可点击控件必须设置为 non-draggable。
- 应用内容铺满窗口，不在系统窗口内再绘制带 margin 和圆角的假窗口。
- 右上角提供符合 Windows 使用习惯的最小化、最大化/还原和关闭按钮。

### 顶栏内容

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
3. 切换 Terminal 底部面板。
4. Settings。
5. 窗口控制按钮。

不显示 Share、全局 Search 或其他无实现按钮。对话搜索入口固定在项目侧栏。

### 快捷键

- `Ctrl+B`：切换项目侧栏。
- `Ctrl+Shift+B`：切换 Artifact 侧栏。
- `Ctrl+J`：切换底部面板。
- `Ctrl+\``：直接切换 Terminal。

快捷键冲突时应允许在设置中重新绑定；自定义快捷键尚未实现。

## 项目侧栏

### 固定结构

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

### 新对话

- 有当前项目时，在该项目下创建新对话并聚焦输入框。
- 没有项目时，先打开目录选择器，成功后创建项目和新对话。
- 当前 Run 活动时可以新建或切换对话，不中断后台 Run，也不显示“中断并切换”确认框。
- 点击新对话只创建当前 renderer 的临时 draft 和候选 `sessionId`，不调用 backend、不进入 Sidebar。
- 首次发送成功 commit 后才把候选 identity 安装为 durable Session；切换 Session、再次新建或 renderer reload 会直接丢弃未发送 draft。

### 对话标题

- 未发送 draft 可在主区显示 `New conversation`，但不占用 Sidebar；首次发送 commit 后才出现 durable 标题。
- 第一条用户消息发送成功后，先以本地截断标题提交；第一个 Run 完成时，若标题仍是派生值（用户未改名、非 Fork、非存量会话），由后端使用辅助模型（未配置时为该 Run 的主模型）生成短标题并写回，侧栏与头部经普通 commit 事件自动刷新。
- Provider 标题生成失败不影响对话执行，保留派生标题；每个会话在进程内最多尝试一次。
- 支持重命名、删除和导出 Markdown。导出前使用 Naive UI 确认框警告源代码、路径、工具参数/结果、内部编排和明文 reasoning 可能进入文件；保存对话框取消时不写文件。
- 删除对话必须二次确认；不删除项目文件。

### 对话搜索

- 搜索范围：对话标题，以及 `user_input/assistant_turn` records 中 `type = 'text'` 的 parts。
- 默认跨已添加项目搜索，结果按项目分组。
- 不搜索工作区文件内容、tool-call 参数、tool-result/JSON payload、reasoning、continuation、trace 或 API Key。
- 结果显示项目名、对话标题、匹配摘要和更新时间。
- 点击结果打开对应项目和对话。
- 搜索必须在本地完成，不把搜索内容发送给 Provider。

### 真实数据要求

- 禁止在正式 UI 中硬编码示例项目或示例对话。
- 空列表显示简短空状态，不用假数据撑满界面。
- 对话列表排序默认按 `updatedAt` 倒序。

### 并发状态与破坏性操作

- 对话项和搜索结果不叠加运行状态文字或 workspace 并发 badge；切换到对应对话后，从统一 Run 活动区和审批卡查看当前状态。
- 后台 approval 仍只属于其 Session/Agent execution；点击后使用显式 owner identity 提交，不得复用先前 active Session 的标识。
- running、start pending 或 awaiting approval 的 conversation 禁用 delete 和 fork，并通过 tooltip 说明原因；项目内任一 conversation busy 时禁止 remove project。
- 对话切换不得让 timeline、error、pending approval 或 runtime event 串到错误 Session。产品不验收未发送 draft/context attachments 的跨 Session 恢复。

## 对话区

对话区是对话工作列上部的完整交互容器，依次包含 Header、消息流和对话输入区。对话输入区不得越过对话工作列边界，也不得跨到项目侧栏或 Artifact 侧栏下方。

### Header

- 显示当前对话标题。
- Header 不重复显示工作区名（顶部栏与项目侧栏已展示）。
- 有 usage 数据时，标题下方依次是两行紧凑用量区：第一行为上下文进度条（样式不变）加同行紧凑数字（如 `128k/256k · 50%`），精确 Token 数与容量来源只出现在 tooltip/aria；第二行为缓存明细 `命中/未命中/输出`，Provider 报告过可缓存输入时追加整数百分比命中率（命中 ÷ (命中+未命中)，与明细同一累计范围）。该命中率只是 UI 展示口径，不改变 trace 或自动压缩的 token 语义。
- 空闲时不显示 `NO SESSION`、`IDLE` 等内部状态 badge。
- Header 不重复显示 Run 状态；运行反馈固定显示在时间线“思考过程”标题右侧，窄宽度下不挤压对话标题。

### 消息流

支持以下内容：

- 用户消息。
- Agent 流式 Markdown。
- `normalizedReasoningText` reasoning 折叠区，默认折叠；没有可读投影时不显示空 reasoning 容器。
- 工具调用卡。
- 审批卡。
- 结构化错误和重试提示。

消息流要求：

- 只有 `visibility = visible` 且 `kind = 'user_input'` 的 Message 显示为用户气泡；orchestrator、runtime context、harness、compact summary 或 hidden `conversation_transcript` 不能伪装成用户亲自输入。`/swarm` 原始用户消息正常展示，其内部 `slash:/swarm` orchestrator Prompt 不进入时间线；Renderer 也必须抑制旧版本已经持久化为 visible 的同源 Prompt。
- Renderer 按 part 的原始顺序渲染：`text` 进入 Markdown，assistant `tool_call` 与对应 `tool_result` 组成稳定工具卡；受支持的 JSON result 只进入有界、可展开的结构化视图。它不能把 parts 重新编译成 Provider DTO。
- `kind = 'assistant_turn'` / `'tool_result'` 的完整 records 用于重建稳定消息和工具卡；Active Run 的 delta/runtime events 只负责未完成状态，不能由 renderer 自行提交为 Message。
- Renderer 只能展示 `normalizedReasoningText`，必须把 `providerContinuation` 当作 opaque canonical data，不解析、不修改，也不展示其中的原始 CoT、signature、encrypted/redacted block、response id 或 output item。
- Renderer 根据按 `kind` 校验的 typed metadata 展示 attachment provenance、usage、tool/approval/compact 摘要；不能把未知 metadata 字段转成 Provider request 内容。
- 自动跟随流式输出；用户主动向上滚动后停止强制跟随，并显示“回到底部”。
- 长代码和长路径不撑破布局。
- Markdown 禁止 raw HTML；外链协议白名单化并通过受控主进程动作打开。
- 模型、工具和审批中的 prompt injection 文本只作为文本显示。

### 工具调用卡

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
- Files 可展示工具涉及的文件，但不重复绘制完整 Tool Activity 列表。Diff 只展示当前 Project 的 Git 状态，不绑定工具调用。

### 文件与 Context 审批卡

文件副作用审批必须显示：

- tool。
- 完整业务 args。
- reason。
- policySignals。
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
- 文件状态在审批后变化不会自动使批准失效。完整 args（含 path/content/patch）在批准后不可替换；执行期仍重新校验 path/scope/普通文件边界。`apply_patch` 无法在最新内容中精确唯一匹配时显示缺失或歧义错误并提示 Agent 重读。

## 对话输入区

对话输入区属于对话区，固定在消息流下方，并与消息流保持相同的对话列宽。它不是 Workbench 的全宽底栏。

### 内容

对话输入区固定包含：

- 多行消息输入框。
- 当前 Provider/模型选择。
- 当前权限模式选择。
- Send；Run 活动时替换为 Stop。

当前已加载历史能尽力派生 Todo 时，输入框上方可额外显示一个比输入框窄的单行悬浮预览：优先预览 `in_progress` item，否则预览第一个 `pending` item。预览与输入框在同一纵向布局中参与正常文档流，不使用绝对定位覆盖输入框。悬停后使用 Naive UI Popover 展开完整只读清单，长内容使用 `NScrollbar` 在浮层内滚动。Todo 全部完成或当前无可操作 item 时隐藏。

不包含：

- Terminal 快捷入口。
- workspace 路径。
- session 状态面板。
- Tool Activity。

### 发送行为

- `Enter` 发送。
- `Shift+Enter` 换行。
- IME composition 期间按 Enter 不发送。
- 空消息不可发送。
- active Run、start pending、pending approval 或 readonly mode 同步失败时不可再次发送；显示明确原因。
- Stop 触发 run interrupt，不关闭 PTY。

### 模型与模式

- 模型按钮显示实际模型名，不只显示 Provider 名。
- 点击模型按钮使用可搜索的下拉框，只列出对应 Provider 的 `enabledModelIds`。历史 Session 若仍引用已停用模型，可以显示原值，但必须先改选启用模型才能发送。管理启用池、Base URL/API Key 进入 Settings。
- 权限模式为 ReadOnly、Auto、Confirm、Yolo。
- 首次启用 Yolo 必须显示 host-level side effects 风险并记录告知版本。
- 模型和模式控件使用紧凑下拉，不使用侧栏大卡片。
- 模型和模式修改必须发送 Session command；控件只在收到后端确认的 entity/state revision 后进入 committed 状态，失败时回到后端值并显示错误。
- 其他 Session 是否在同一 workspace 运行或写入，不改变当前 Session 保存的权限模式，不禁用模式控件或发送入口，也不显示额外警告。

### 布局验收

- Send/Stop 按钮距输入区右侧和底部的视觉距离一致。
- 图标与文字垂直居中。
- 控件不足一行时允许模型/模式收缩，不允许 Send 按钮错位。

## Artifact 侧栏

### 能力可见性

当前 Artifact 侧栏可显示：

- Files
- Diff
- Plan
- Background（后台）

不显示：

- Project
- Terminal
- Browser

Browser 尚未实现，不保留空 tab 或 Coming Soon 占位。

### Files

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

### Diff

- Diff 是 Project 级实时 Git Review，不随当前 Session 变化，也不按 Session、Run、Agent 或工具调用归因。文件审批不会自动打开该 tab；审批和 Diff 没有共享决定状态或 footer。
- Header 显示当前 branch；detached HEAD 显示短 OID，unborn repository 显示明确提示。右上角刷新按钮必须有 aria-label 和 loading 状态。
- 左侧状态区使用 `NTree` 列出 Git porcelain entries，并同时显示 index/worktree 两列短状态。rename/copy 可在摘要中显示原路径；没有变化时显示 clean working tree。
- 比较模式使用 `NTabs`：`HEAD`、unstaged、staged 和 merge base。merge-base 模式使用可筛选 `NSelect` 选择本地/远端 ref，优先 upstream，其次 `origin/main`、`origin/master`、`main`、`master`；摘要显示实际解析的短 merge-base OID。
- 切换项目、内置工具完成或用户点击刷新时重新查询 status；选择路径、比较模式或 base ref 时懒加载 Diff。旧异步请求的结果不得覆盖新选择。
- 未跟踪文件显示“加入 Git 后才能查看 Diff”；binary 只显示标记，不展示 binary patch；当前比较下无正文时显示明确空状态。
- status、refs 或 Diff 达到 Main process 上限时显示截断提示；错误在当前视口显示，不伪造空结果。
- 非 Git Project 显示空状态和“Git 管理恢复与变更查看”的提示。应用不展示 FileChange history、变更 hash、revert capability 或恢复按钮。

### Background

- Tab 不因新任务自动打开或切换。范围为当前公开对话，包含 hidden child 和用户手动创建的终端。徽标由后端独立统计活动顶层任务：独立 Subagent、Swarm root 和每个 Terminal 各计一次，嵌套 child 不重复计数。
- 第一层 `NCollapse` 列出 Subagent、Swarm root 与 Terminal，活动项置顶，各组按创建时间倒序，每页 50 条；默认折叠，实时事件和状态变化不得自动展开。
- 展开 Swarm root 后显示第二层 child Agent，按 durable `childOrdinal` 排列。第二层同样只手动单项展开；展开 child 才按需读取详情，不能让一个 child 的流式状态污染兄弟项。
- root/child header 显示名称、状态、耗时或当前阶段；详情只显示运行时间、工具调用次数、状态、模型、usage、Swarm Agent 计数和可见 Assistant 消息。Swarm root 不伪造聚合消息。
- 不展示 reasoning、完整工具调用时间线、hidden Session ID、prompt harness、route、Provider continuation 或加密 reasoning。长内容在 440px 侧栏内收敛，纵向滚动使用 `NScrollbar`。
- execution 终态后仍可历史回看，应用刷新从 durable root/child 投影恢复；hidden Session 继续不进入左侧对话列表。
- root/child 标题操作区提供停止按钮，点击不触发展开。请求期间显示请求中，后端接受后显示停止中；只有实际收尾完成才显示终态，错误可见并允许重试。
- 停止 Subagent 关闭其自身终端；停止 Swarm 覆盖所有 child 及其终端，包括已经完成 child 留下的终端。停止单个 child 不影响 sibling，关闭单个 Terminal 不停止 Agent。Agent 正常完成和主 Run Stop 均不关闭独立终端。
- Terminal 卡片显示编号、Shell、状态和退出码，展开后直接 tail 已登记的 artifact 日志：最近 200 行、最多 64 KiB。只读纯文本，不嵌入 xterm，不打开或创建底部终端。
- 日志仅在侧栏、Background 页签、卡片和文档均可见且正在跟随时每秒读取，单卡片最多一个请求在途。向上滚动暂停跟随，恢复时读取最新尾部；允许复制当前预览。终端关闭后再读一次最终内容，然后停止轮询。
- 缺失或捕获失败显示原因并保留已读文本，不改变任务状态。切换目标后丢弃迟到响应。终端列表仅保留当前进程记录与有界关闭缓存，重启不从日志重建历史。

### Project

ProjectModel/Serena/code intelligence 暂停期间不显示 Project artifact tab，也不在 Renderer 中加载或编辑 ProjectModel。文件浏览仍由 Files tab 提供；普通 prompt harness 的 module marker 探测只存在于本次 runtime context，不形成 UI 状态或 workspace 文件。Swarm hardening 完成后的 SQLite 迁移与 Project UI 重建见[路线图](../road-map.md)。

## Terminal 底部面板

Terminal 是当前已实现的底部面板，只在对话工作列内显示。

### 位置与入口

- Terminal 在完整对话区下方打开；垂直顺序固定为“对话 Header / 消息流 / 对话输入区 / Terminal”。
- 交互 Terminal 只占对话工作列宽度，不延伸到项目侧栏或 Artifact 侧栏下方；右侧 Background 只提供独立的只读日志预览。
- 顶栏右侧布局按钮负责切换底部面板。
- `Ctrl+J` 切换底部面板；`Ctrl+\`` 直接切换 Terminal。
- 对话输入区不放 Terminal pill 或快捷按钮。

### 面板行为

- 支持拖拽调整高度。
- 支持折叠和最大化到对话工作列可用高度。
- 最小高度 160px；默认高度约为对话工作列的 35%。
- 多 terminal tab，支持新建、切换、关闭。
- tab 显示名称、运行状态和关闭按钮。
- 原始 ANSI 流由 xterm.js 渲染。
- 人类输入直接进入当前 PTY，但仍校验 sender、session 和 terminal ownership。

### 生命周期

- Terminal 归属于持久化 Session 对应的 backend `LiveSessionContext`。
- 切换对话时切换到该对话所属 terminal 集合。
- Interrupt Run 不关闭 PTY。
- 归档/删除 Session、移除项目或退出应用时关闭所属 PTY。
