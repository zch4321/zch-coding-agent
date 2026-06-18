# 前端设计规划 · My Coding Agent

> **历史草案**：本文档保留早期 Pencil 视觉探索，不再作为实现与验收依据。当前权威规范见 [`frontend-spec.md`](./frontend-spec.md)。其中 Terminal 已改为 P4 对话区底部面板，Browser 已改为 Post-MVP，右侧 Artifact 在 P3 仅包含 Files/Diff。

> 状态：草案 v0.1 · 最后更新 2026-06-17
> 配套：[`requirements.md`](./requirements.md)、[`architecture.md`](./architecture.md)、[`implementation-plan.md`](./implementation-plan.md)

本文档定义前端「长什么样、有哪些页面、拆哪些组件、按什么顺序落地」。功能边界以需求和实施计划为准；前端不绕过主进程的权限、IPC、路径和会话约束。

---

## 1. 设计目标

### 1.1 产品定位

My Coding Agent 是本地桌面端 AI 编程助手。前端的核心职责不是做一个泛聊天窗口，而是把 Agent 的关键状态、工具行为、权限审批和执行结果清楚展示给用户。

### 1.2 体验原则

- **可控**：用户必须知道 Agent 正在做什么、为什么做、是否需要审批。
- **可审**：工具调用、diff、命令、终端输入和敏感数据提示必须可读、可复核。
- **低干扰**：常规只读任务保持流畅；高风险动作才打断用户。
- **工程感**：界面像一个轻量工作台，不像营销页，也不做重 IDE。
- **阶段可落地**：P2 先完成只读 Chat 闭环；P3 加审批和 diff；P4 加终端；P5 加 Skills 和 trace 入口。

---

## 2. 信息架构

MVP 不做完整多会话管理页，但左侧保留轻量线程/项目导航。工作区路径、文件结构、浏览器、终端和 diff 不常驻在左侧，而是进入右侧上下文面板；模型和权限模式属于当前输入动作的参数，放在输入框附近。

```
AppShell
├── 首次配置 / 会话启动
│   ├── Provider 设置
│   ├── 外发数据告知
│   ├── Trace 日志告知
│   └── 工作区选择与权限模式
├── 主工作台
│   ├── 顶栏：应用标题、当前项目短名、分享/设置
│   ├── 左侧：线程/项目导航
│   ├── 中间：Chat Timeline
│   ├── 右侧：Artifact Panel（Files / Browser / Terminal / Diff）
│   └── 底部：输入框、模型选择、权限模式、终端入口、发送/中断
├── 设置
│   ├── Provider 与密钥状态
│   ├── 权限与敏感数据策略
│   ├── Trace 日志设置
│   └── Skills 设置
└── 调试与回放入口
    ├── Trace 列表基础入口
    ├── Replay 只读视图
    └── Cache/延迟统计摘要
```

---

## 3. 页面规划

### 3.1 首次配置页

用于 P2。用户还没有可用会话时展示。

内容：
- 应用定位说明：本地桌面 Agent，会读取工作区内容并发送必要上下文给配置的 Provider。
- DeepSeek 配置：base URL、model、reasoning 开关、API Key 配置状态。
- 数据外发告知：未确认前禁止创建会话。
- Trace 日志告知：默认关闭，开启前说明日志可能包含源码、工具输出和工作区凭据。
- 选择工作区。
- 选择权限模式：ReadOnly / Auto / Confirm / Yolo。P2 默认 ReadOnly 或 Auto，但只开放只读工具。

主要组件：
- `OnboardingView`
- `ProviderConfigForm`
- `DataEgressNotice`
- `TraceLoggingNotice`
- `WorkspacePicker`
- `PermissionModeSelector`

### 3.2 主工作台页

MVP 的核心页面。

布局建议：
- 顶栏高度 40-48px，只展示应用级操作和项目短名，不放大块状态卡。
- 左侧栏宽 220-260px，只做线程/项目导航，不展示工具活动、权限说明或模型设置。
- 中间 Chat 区域为主区域。工具调用以内联卡片出现在对话流里，可展开查看参数和结果。
- 右侧 Artifact Panel 宽 480-540px，按 tab 切换 Files / Browser / Terminal / Diff。工作区路径只在 Files 面板顶部展示。
- 输入区固定在 Chat 底部，模型选择、权限模式和 Terminal 入口放在输入区底部的小 pill 中。
- 运行中发送按钮切换为中断按钮。

主要组件：
- `WorkbenchView`
- `AppTopBar`
- `ThreadSidebar`
- `RunStatusBadge`
- `ChatTimeline`
- `MessageItem`
- `ReasoningBlock`
- `ToolCallCard`
- `ArtifactPanel`
- `PromptComposer`
- `InterruptButton`

### 3.3 审批与 Diff 页面/面板

不建议做独立全屏页。Chat 中展示审批摘要；右侧 Artifact Panel 切到 Diff 模式后展示完整变更审查。

内容：
- 工具名、参数、`reason`。
- 风险信号 `policySignals`。
- 对文件写入展示 diff。
- 对命令和终端写入展示 cwd、命令/输入、权限提示。
- 操作：批准、拒绝、批准并记忆。
- 记忆规则必须展示匹配范围、工作区作用域和有效期。

主要组件：
- `ApprovalPanel`
- `PolicySignalList`
- `ToolArgsViewer`
- `DiffViewer`
- `RememberRuleEditor`
- `ApprovalActions`

### 3.4 终端面板

P4 引入。推荐作为底部抽屉，不抢占 Chat 主区。

内容：
- 多终端 tab。
- xterm.js ANSI 渲染。
- 终端状态：opening/running/closed/failed。
- 丢片提示和快照恢复状态。
- 明确提示：人类输入不经过 Agent 审批；Agent 写入终端仍走权限管线。

主要组件：
- `TerminalDrawer`
- `TerminalTabs`
- `TerminalView`
- `TerminalStatusBar`

### 3.5 Skills 管理页

P5 引入。放在设置内或左侧二级入口，不作为 MVP 主路径。

内容：
- Skills 列表：name、description、trigger、source、enabled。
- 安装入口：URL 下载、本地文件选择、refresh。
- 启用/禁用。
- 安全状态：来源、hash、是否信任。

主要组件：
- `SkillsView`
- `SkillList`
- `SkillCard`
- `SkillInstallDialog`
- `SkillTrustBadge`

### 3.6 Trace / Replay 基础入口

P5 引入基础入口，不做完整分析 GUI。

内容：
- 当前 trace 状态：关闭/开启、路径、大小、保留策略。
- 打开日志目录。
- 清理已关闭 trace。
- Replay 只读入口。
- Cache/延迟统计摘要。

主要组件：
- `TraceSettingsView`
- `TraceStatusCard`
- `ReplayEntryList`
- `CacheStatsSummary`

---

## 4. 组件体系

### 4.1 应用骨架

- `AppShell`：负责全局布局、主题、错误边界、事件订阅生命周期。
- `RouteHost`：MVP 可不引入复杂 router，但应保留视图切换边界。
- `GlobalErrorBanner`：展示 Provider、IPC、日志、Skill 等结构化错误。
- `SettingsDrawer`：设置入口统一承载，不把配置散落在主界面。

### 4.2 会话与运行状态

- `ThreadSidebar`：当前线程、最近线程、项目入口。
- `RunStatusBadge`：idle/calling/running/awaiting/cancelling/completed/failed。
- `EventSeqIndicator`：检测 agent/terminal event seq 丢失或重复。
- `ModeSelectorPill`：位于输入区，解释 ReadOnly/Auto/Confirm/Yolo 的实际含义。
- `ModelSelectorPill`：位于输入区，展示和切换当前模型。

### 4.3 Chat

- `ChatTimeline`：消息列表、滚动锁定、流式追加。
- `UserMessage`：用户输入。
- `AssistantMessage`：Markdown 渲染，禁用 raw HTML。
- `ReasoningBlock`：折叠展示 reasoning delta。
- `ToolCallCard`：工具名、参数摘要、reason、状态、耗时、结果摘要。
- `ToolResultViewer`：ok/error/denied/cancelled/timeout/truncated。
- `PromptComposer`：输入、发送、运行中禁用/中断。

### 4.4 审批与安全提示

- `ApprovalPanel`：人工审批主容器。
- `DataEgressNotice`：首次外发告知。
- `TraceLoggingNotice`：日志风险告知。
- `SensitiveDataConfirmPanel`：Context Ingress confirm。
- `YoloWarningDialog`：首次启用 Yolo 的强提示。
- `PolicySignalList`：风险信号列表。

### 4.5 Artifact 与 Diff

- `ArtifactPanel`：右侧上下文面板。
- `FilesPanel`：Explorer 与打开文件采用 tab 关系；查看文件内容时不同时展示文件树。
- `BrowserPanel`：内置浏览器预览。
- `TerminalPanel`：Agent 调用的终端。
- `DiffArtifactPanel`：变更审查。
- `ToolArgsViewer`：JSON 参数树，长文本折叠。
- `DiffViewer`：文件变更预览。
- `FileChangeSummary`：路径、hash、变更大小。
- `CommandPreview`：命令、cwd、shell/process 模式。

### 4.6 终端

- `TerminalDrawer`
- `TerminalTabs`
- `TerminalView`
- `TerminalStatusBar`
- `TerminalReconnectNotice`

### 4.7 设置与管理

- `ProviderConfigForm`
- `PermissionSettings`
- `LoggingSettings`
- `SkillsView`
- `TraceSettingsView`

---

## 5. 状态管理

采用 Pinia。建议拆成这些 store：

- `configStore`：PublicConfig、credentialConfigured、settings 保存状态。
- `sessionStore`：sessionId、workspace、permission mode、provider、生命周期。
- `runStore`：active run、run status、pending approvals、interrupt 状态。
- `chatStore`：messages、streaming assistant、reasoning、tool call timeline。
- `terminalStore`：terminal list、active terminal、terminal events、seq。
- `skillsStore`：Skill summaries、安装/启用状态。
- `traceStore`：logging 状态、replay/cache 入口数据。

renderer 只消费 `window.agentApi` 和 `agent:event` / `terminal:event`，不直接 import Electron 或 Node。

---

## 6. 视觉风格

### 6.1 风格方向

关键词：极简、冷静、工程化、VS Code-like、亮色优先、圆角克制、高对比、低装饰。

当前 `src/style.css` 的深色科技感不作为后续方向。后续建议收敛成 VS Code Light+ / Dark+ 两套设计 token，先实现亮色。

### 6.2 色彩

亮色基础色：
- Window：`#F3F3F3`
- Editor：`#FFFFFF`
- Sidebar：`#F6F8FA`
- Panel：`#FAFBFC`
- Border：`#D0D7DE`
- Text：`#24292F`
- Muted：`#6E7781`

语义色：
- 主操作 / 流式运行：blue `#0969DA`
- 成功：green `#1A7F37`
- 警告：amber `#9A6700`
- 危险 / 拒绝：red `#CF222E`
- 审批等待：violet `#8250DF`
- 截断 / 信息：slate `#6E7781`

### 6.3 字体

- UI 字体：Inter、system-ui、Segoe UI。
- 代码/工具参数/终端：Cascadia Code、SFMono-Regular、Consolas、monospace。
- 中文界面文本保持简洁，避免大段解释占据主工作台。

### 6.4 组件形态

- 圆角：主卡片 14-18px，小组件 8-12px。
- 阴影：只用于浮层、Inspector、modal，不要全页面重阴影。
- 密度：桌面工具优先，信息密度应高于普通 SaaS。
- 动效：只用于流式状态、展开折叠和审批出现；不做强动画。

暗色配套 token：
- Window / Editor：`#1E1E1E`
- Sidebar：`#252526`
- Panel：`#2D2D30`
- Border：`#3C3C3C`
- Text：`#CCCCCC`
- Muted：`#8B949E`
- Accent：`#007ACC`

### 6.5 明暗主题

MVP 先做亮色主题。暗色主题使用同构 token，等主流程稳定后再补。

---

## 7. 技术选型

按需求文档固定：

- UI：Naive UI
- 状态：Pinia
- Markdown：markdown-it，禁用 raw HTML
- 代码高亮：Shiki
- Diff：优先 CodeMirror 或轻量 diff 组件；P3 前再定
- 终端：xterm.js

实现注意：
- Naive UI 主题变量应和本文件的色彩 token 对齐。
- Markdown 链接必须协议白名单化，外链通过主进程受控打开。
- 工具参数、模型输出和审批内容都按不可信文本处理。

---

## 8. 分阶段落地

### P2：只读 Chat 闭环

必须完成：
- 首次配置页。
- 工作区选择、权限模式选择。
- 主工作台基础布局。
- ChatTimeline、PromptComposer、RunStatusBadge。
- ReasoningBlock、ToolCallCard、ToolResultViewer。
- Context Ingress confirm 最小面板。
- Markdown 安全渲染。
- 输入区模型选择、模式选择和终端入口。

不做：
- 文件写入 diff。
- 终端完整实现。
- Skills 管理。
- 完整 trace 分析 GUI。

### P3：审批与 Diff

必须完成：
- ApprovalPanel。
- PolicySignalList。
- DiffViewer。
- RememberRuleEditor。
- YoloWarningDialog。
- 文件写入/删除/编辑的清晰风险展示。

### P4：终端

必须完成：
- TerminalDrawer。
- TerminalTabs。
- TerminalView。
- TerminalStatusBar。
- 终端事件 seq 丢片提示。

### P5：Skills 与 Trace 入口

必须完成：
- SkillsView。
- SkillInstallDialog。
- TraceSettingsView。
- ReplayEntryList 基础入口。
- CacheStatsSummary。

---

## 9. 推荐首屏结构

P2 主工作台建议先做成这个结构：

```
┌─────────────────────────────────────────────────────────────┐
│ TopBar: app title | project crumb | share | settings        │
├────────────┬───────────────────────────────┬────────────────┤
│ Threads    │ Chat Timeline                 │ Artifact Panel │
│ Project    │ - user message                │ Files          │
│ Navigation │ - assistant stream            │ Browser        │
│            │ - inline tool cards           │ Terminal       │
│            │ - approval summaries          │ Diff           │
├────────────┴───────────────────────────────┴────────────────┤
│ Prompt Composer: model | mode | terminal | send/interrupt   │
└─────────────────────────────────────────────────────────────┘
```

核心交互：
- 用户输入消息后，输入框进入运行态，显示中断按钮。
- Assistant 流式输出直接进入 timeline。
- reasoning 默认折叠，运行中显示增量提示。
- 工具调用以内联 card 形式插在 assistant 消息之后，并可在原地展开 args/result。
- 点击文件、浏览器、终端或 diff 相关事件时，右侧 Artifact Panel 切到对应 tab。
- 需要审批时，对话流出现审批摘要，右侧自动切到 Diff 模式审查完整变更。
- 工作区路径只在 Files 面板顶部展示，不占用左侧导航空间。
- 文件内容或 Diff 激活时占满右侧面板，文件树收起到 Explorer tab，避免拥挤。

---

## 10. 开发顺序建议

1. 建立设计 token 和 Naive UI 主题接入。
2. 重构 `App.vue` 为 `AppShell + OnboardingView + WorkbenchView`。
3. 建 Pinia stores 和 `api/agentApi.ts` typed wrapper。
4. 用 mock AgentEvent 先做 ChatTimeline 和 ToolCallCard 静态/fixture 测试。
5. 接真实 `agent:event` 后再处理流式滚动、seq、清理 listener。
6. P3 前实现 ArtifactPanel，避免审批、文件预览、终端和 diff 没有稳定承载位置。

---

## 11. 非目标

- MVP 不做完整 IDE 文件树和编辑器。
- MVP 不做多会话管理 UI。
- MVP 不做插件市场。
- MVP 不做完整 trace 可视化分析台。
- MVP 不做浅色主题。
