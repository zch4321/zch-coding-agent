# 前端产品与验收规范 · My Coding Agent

> 状态：MVP 实现同步版 v0.2 · 最后更新 2026-06-20
> 配套：[`requirements.md`](./requirements.md)（产品能力）、[`architecture.md`](./architecture.md)（技术边界）、[`implementation-plan.md`](./implementation-plan.md)（实施阶段）。  
> 本文档是前端信息架构、交互行为、阶段展示和验收标准的权威依据。历史视觉探索见 [`frontend-design.md`](./frontend-design.md)，发生冲突时以本文档为准。

---

## 1. 目标与原则

前端不是通用聊天网页，而是本地 Coding Agent 的工作台。它必须同时让用户完成对话、理解 Agent 行为、审查副作用，并访问工作区文件和终端。

固定原则：

1. **真实功能优先**：未实现的能力不显示可点击占位，不使用假对话、假文件或无行为按钮填充界面。
2. **对话是主流程**：消息、推理、工具调用和错误集中在对话流；同一工具状态不在多个侧栏重复展示。
3. **审查与执行分区**：Files/Diff 位于右侧 Artifact 侧栏；Terminal 位于对话区下方的底部面板。
4. **内部状态最小暴露**：`sessionId/runId/callId` 不作为常驻产品信息展示；只有运行、等待审批、取消和错误等用户需处理的状态可见。
5. **阶段能力诚实**：Terminal 到 P4 才出现；Browser 属于 Post-MVP；当前阶段不展示对应 tab 或占位页。
6. **安全边界不下沉**：renderer 只展示和发起版本化 IPC；workspace、schema、资源归属和权限判断仍由主进程执行。
7. **Codex 信息结构 + VS Code 工作区习惯**：整体结构参考 Codex；窗口布局控制、文件审查和底部终端参考 VS Code。

---

## 2. 产品术语

### 2.1 项目（Project）

- 一个项目对应一个 canonical workspace，即一个本地目录。
- UI 使用“项目”作为用户概念，不同时展示“项目”和“工作区”两个重复层级。
- 项目项显示目录名；完整路径只在 tooltip、项目设置和 Artifact header 中显示。
- 添加项目等价于通过主进程目录选择器选择 workspace。
- 移除项目只移除应用记录，不删除本地目录和文件。

### 2.2 对话（Conversation）

- 对话是项目下可持续打开、搜索和恢复的用户界面实体。
- 对话保存标题、所属项目、消息历史、创建时间、更新时间、模型和权限模式等 UI 元数据。
- 对话不是新的执行权限边界；实际 Agent 运行仍使用 `Session` 和 `Run`。
- 一个打开的对话在需要执行 Agent 时绑定一个 runtime Session；一次用户提交形成一个 Run。
- runtime Session 关闭后，对话记录仍可保留；重新打开时由运行时恢复所需上下文或创建新的 Session。
- 不引入 Task 概念。

### 2.3 Session 与 Run

- Session、Run 是运行时概念，不作为左侧导航层级。
- 同一对话同一时间最多一个 active Run。
- Run 活动时再次发送消息默认拒绝；排队不在 MVP 范围。

### 2.4 Artifact

- Artifact 是 Agent 工作中产生或查看的文件内容、Diff 等可审查对象。
- P3 的 Artifact 类型只有 Files 和 Diff。
- Terminal 不是 Artifact；Browser 在 Post-MVP 重新设计。

---

## 3. 总体信息架构

应用采用单一 Workbench，不为 Chat、Files、Diff 分别创建全屏路由页面。

```text
┌────────────────────────────── 顶栏 ──────────────────────────────┐
│ 应用名称      当前项目         布局控制  设置  最小化/最大化/关闭 │
├──────────────┬──────────────────────────┬────────────────────────┤
│ 项目侧栏      │ 对话工作列                │ Artifact 侧栏          │
│              │ ┌────── 对话区 ─────────┐ │ Files / Diff           │
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
- `My Coding Agent`。

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
- 当前 Run 活动时触发新对话，必须先确认是否中断；未经确认不丢失当前状态。
- 创建对话本身不需要立即访问 Provider；首次发送消息时再创建 runtime Session。

### 5.3 对话标题

- 初始显示 `New conversation`。
- 第一条用户消息发送成功后，使用本地截断标题或 Provider 标题生成结果更新。
- Provider 标题生成失败不影响对话执行。
- 支持重命名和删除。
- 删除对话必须二次确认；不删除项目文件。

### 5.4 对话搜索

- 搜索范围：对话标题、用户消息和 Agent 文本消息。
- 默认跨已添加项目搜索，结果按项目分组。
- 不搜索工作区文件内容、工具原始输出、reasoning、trace 或 API Key。
- 结果显示项目名、对话标题、匹配摘要和更新时间。
- 点击结果打开对应项目和对话。
- 搜索必须在本地完成，不把搜索内容发送给 Provider。

### 5.5 真实数据要求

- 禁止在正式 UI 中硬编码示例项目或示例对话。
- 空列表显示简短空状态，不用假数据撑满界面。
- 对话列表排序默认按 `updatedAt` 倒序。

---

## 6. 对话区

对话区是对话工作列上部的完整交互容器，依次包含 Header、消息流和对话输入区。对话输入区不得越过对话工作列边界，也不得跨到项目侧栏或 Artifact 侧栏下方。

### 6.1 Header

- 显示当前对话标题。
- 空闲时不显示 `NO SESSION`、`IDLE` 等内部状态 badge。
- 仅在以下情况显示短状态：`Running`、`Waiting for approval`、`Cancelling`、`Failed`。
- 状态不得挤压对话标题；窄宽度下优先保留标题和 Stop 操作。

### 6.2 消息流

支持以下内容：

- 用户消息。
- Agent 流式 Markdown。
- reasoning 折叠区，默认折叠。
- 工具调用卡。
- 审批卡。
- 结构化错误和重试提示。

消息流要求：

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
- active Run 或 pending approval 时不可再次发送；显示明确原因。
- Stop 触发 run interrupt，不关闭 P4 PTY。

### 7.3 模型与模式

- 模型按钮显示实际模型名，不只显示 Provider 名。
- 点击模型按钮使用可搜索、可直接输入的 combobox；Provider 目录外的值标记为“自定义”，不得阻止保存或发送。管理 Base URL/API Key 进入 Settings。
- 权限模式为 ReadOnly、Auto、Confirm、Yolo。
- 首次启用 Yolo 必须显示 host-level side effects 风险并记录告知版本。
- 模型和模式控件使用紧凑下拉，不使用侧栏大卡片。

### 7.4 布局验收

- Send/Stop 按钮距输入区右侧和底部的视觉距离一致。
- 图标与文字垂直居中。
- 控件不足一行时允许模型/模式收缩，不允许 Send 按钮错位。

---

## 8. Artifact 侧栏

### 8.1 阶段可见性

P3 仅显示：

- Files
- Diff

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
- 审批完成后从主进程加载当前 conversation 的持久化文件变更历史；切换对话或项目时必须按 conversationId + workspace 重新查询，不能复用上一对话的列表。
- 变更列表显示路径、操作、时间、diff hash 和回退状态；选择记录后显示对应统一 diff。
- “回退此变更”必须先显示明确确认，运行期间禁用。主进程返回 `CONFLICT` 时在当前视口显示错误，不能假装回退成功。
- 大 Diff 必须有明确截断提示，不能让 UI 假装展示了完整变化。

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

- Terminal 归属于当前对话绑定的 runtime Session。
- 切换对话时切换到该对话所属 terminal 集合。
- Interrupt Run 不关闭 PTY。
- 关闭对话 runtime Session、删除对话或退出应用时关闭所属 PTY。

---

## 10. Settings

Settings 使用一个 modal，内部按 tab 分组，不使用占满主界面的独立路由。

### 10.0 General

- 界面语言支持简体中文和英文，切换后立即更新 UI，并同步主进程 `assistant.language`。
- 展示可编辑的中英文 system prompt，支持保存和恢复内置默认值；两个版本均不能为空。
- 保存后的提示词从已有对话的下一轮模型调用开始生效；不得把 API Key 等凭据写入提示词。

### 10.1 Project

- 当前项目路径。
- Choose workspace / Add project。
- 从应用记录移除项目。
- 不展示内部 session ID。

### 10.2 Provider

- Base URL。
- 主模型：鉴权调用 `/models` 刷新可用模型，使用可搜索且可输入的下拉框；失败时保留缓存与手工值。
- 模型能力：显示目录/内置/自定义来源；上下文长度和最大输出允许用户覆盖，未知模型显示保守默认值提示。
- Token 估算：默认保守估算，可切换为自定义 `bytesPerToken`；说明该值只影响预算估算，不能关闭字节/行数硬限制。
- Reasoning 开关。
- API Key 配置状态、更新和清除。
- Auto approver Provider/模型。
- renderer 不读取或回显已保存 API Key。

### 10.3 Permissions

- 默认权限模式。
- Sensitive Data：off/warn/confirm。
- Path globs。
- Content patterns。
- Remembered rules 列表。
- 每条规则显示 tool、workspace scope、arg constraints、expiry 和来源 call。
- 支持删除规则，不支持编辑为更宽松的任意 JSON。

### 10.4 Skills

- 展示 name、description、source、sha256 短摘要和启用状态。
- 支持 HTTPS URL、主进程文件选择器安装和手工目录 refresh。
- 新安装和首次扫描的手工 skill 默认禁用；必须由用户显式启用。
- 格式错误、重复名称、符号链接和超限文件显示诊断，不中断设置页。

### 10.5 Logging

- Trace 开关和独立风险告知。
- retention days。
- max total bytes。
- P5 提供受控的打开日志目录和清理已关闭 trace 入口。
- 提供 trace 列表、离线 replay 摘要、`llm.request` fork 点和当前 Provider 凭据分叉动作。
- 展示 Provider 原始 usage 派生的 token/cache 指标与 TTFT/总时延；字段缺失时明确显示 `Provider not provided`。
- 完整事件时间轴、搜索、导出和批量管理属于 Post-MVP。

### 10.6 Session 生命周期

- Settings 不展示 `Start session` / `Close session` 作为主流程按钮。
- 首次发送消息时自动创建 runtime Session。
- 新对话、切换项目、删除对话和退出应用负责触发生命周期处理。

---

## 11. 状态与错误

前端必须覆盖以下显式状态：

| 状态                | 对话区             | 输入区                   | Artifact                    |
| ------------------- | ------------------ | ------------------------ | --------------------------- |
| 未选择项目          | 引导选择目录       | Send disabled            | 空状态                      |
| Provider 未配置     | 配置提示           | Send disabled            | 可浏览本地文件              |
| Idle                | 不显示内部 badge   | 可输入                   | 保留当前 tab                |
| Calling LLM         | 流式占位/文本      | Stop                     | 保留当前 tab                |
| Running tool        | 工具卡状态更新     | Stop                     | 文件工具可打开相关 Artifact |
| Waiting approval    | 审批卡             | 禁止发送，可 Stop        | 自动显示 Diff 或相关文件    |
| Cancelling          | 短状态             | Stop disabled            | 保留内容                    |
| Failed              | 结构化错误、可重试 | 恢复输入                 | 保留审查上下文              |
| Conversation closed | 历史只读           | 新消息时重新绑定 Session | 恢复持久化 Artifact 元数据  |

要求：

- 错误消息对用户可见但不泄露 API Key、Authorization header 或主进程堆栈。
- event seq 重复时不重复渲染；检测丢片后显示状态并请求允许的有限快照。
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
- [ ] 左侧只展示新对话、搜索、项目和二级对话。
- [ ] 无硬编码示例项目或示例对话。
- [ ] 新对话在当前项目下创建；无项目时先选择目录。
- [ ] 对话标题可生成、重命名和删除。
- [ ] 搜索只在本地检索标题和消息，并能打开结果。
- [ ] 首次发送消息自动创建 runtime Session。

### 16.3 对话与输入

- [ ] 流式文本、折叠 reasoning、工具卡和结构化错误正常。
- [ ] active Run 和 pending approval 时禁止重复发送。
- [ ] Enter、Shift+Enter 和 IME 行为符合规范。
- [ ] 模型和权限模式只使用紧凑控件，不放入侧栏大卡片。
- [ ] 对话输入区没有 Terminal 入口。
- [ ] Send/Stop 按钮与底部、右侧距离一致。

### 16.4 Files 与 Diff

- [ ] Explorer 独立加载真实 workspace，不依赖 Agent 工具历史。
- [ ] 文件树和文件内容通过二级 tab 切换，不同时拥挤展示。
- [ ] 文件 viewer 只读、有界、有行号和语法高亮。
- [ ] pending 文件审批自动打开 Diff。
- [ ] Diff 与对话审批卡共享同一个决定状态。
- [ ] 大文件和大 Diff 显示截断提示。

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

- [ ] Project/Provider/Permissions/Logging 分组清晰。
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
