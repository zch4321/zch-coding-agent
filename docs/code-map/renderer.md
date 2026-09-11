# Renderer、组件与设置

返回[总地图](./README.md)。交互要求见[前端规范](../frontend-spec.md)，状态规则见[架构](../architecture.md)。

## 职责与边界

Vue Renderer 通过冻结 `agentApi` 发命令、查数据、订阅事件。Pinia 区分 durable replica、瞬时运行 overlay、配置草稿和纯 UI；组件不直接访问 Electron/Node、工作区或凭据。

## 关键入口

| 文件 / 符号                                                                                                                                            | 责任                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [main.ts](../../src/main.ts)、[App.vue](../../src/App.vue)                                                                                             | Vue、Pinia、Provider 和工作台装配                        |
| [agent.ts](../../src/stores/agent.ts)、[agent-shell.ts](../../src/stores/agent-shell.ts)                                                               | 公共 Store facade、界面选择与订阅生命周期                |
| [agent-runtime.ts](../../src/stores/agent-runtime.ts)、[agent-composer-actions.ts](../../src/stores/agent-composer-actions.ts)                         | Runtime 动作与配置 fan-out；草稿发送/插话/编辑和异步归属 |
| [agent-replica.ts](../../src/stores/agent-replica.ts)                                                                                                  | 已提交领域副本与消息分页                                 |
| [composer-drafts.ts](../../src/stores/composer-drafts.ts)、[composer-draft-view.ts](../../src/stores/composer-draft-view.ts)                           | 独立草稿、localStorage 保存、输入页恢复与导航 flush      |
| [agent-runtime-events.ts](../../src/stores/agent-runtime-events.ts)、[agent-runtime-subscriptions.ts](../../src/stores/agent-runtime-subscriptions.ts) | 事件转 overlay 与 durable reconciliation                 |
| [conversation-timeline.ts](../../src/stores/conversation-timeline.ts)、[ConversationTimeline.vue](../../src/components/chat/ConversationTimeline.vue)  | Canonical records 和活动的有序展示                       |
| [MessageComposer.vue](../../src/components/chat/MessageComposer.vue)、[ApprovalCard.vue](../../src/components/chat/ApprovalCard.vue)                   | 输入/IME/模型模式和审批交互                              |
| [ArtifactPanel.vue](../../src/components/artifacts/ArtifactPanel.vue)、[TerminalPanel.vue](../../src/components/TerminalPanel.vue)                     | 右侧文件/Git/Plan/Background 与底部 PTY                  |
| [settings-tabs.ts](../../src/components/settings/settings-tabs.ts) / `SETTINGS_PAGES`                                                                  | 配置领域、导航、组件与 ConfigSection 的唯一 registry     |
| [AppMessageBridge.vue](../../src/components/layout/AppMessageBridge.vue)、[notifications.ts](../../src/stores/notifications.ts)                        | 操作通知去重和 NMessage 展示                             |
| [naive-theme.ts](../../src/theme/naive-theme.ts)、[style.css](../../src/style.css)、[i18n.ts](../../src/i18n.ts)                                       | Naive 主题、领域样式入口和本地化                         |

## 主要调用链

[background-tasks.ts](../../src/stores/background-tasks.ts) 拥有后台列表、活动总数和停止请求；[BackgroundTab.vue](../../src/components/artifacts/BackgroundTab.vue) 复用 Agent/Swarm 内容并组合终端卡片；[BackgroundTerminalTail.vue](../../src/components/artifacts/BackgroundTerminalTail.vue) 只在可见并跟随时读取日志，与底部 xterm 独立。

```text
用户动作 → Component → owning Store → agentApi → Backend
  → command result / push event → replica 或 Runtime overlay
  → timeline / view model → Vue
```

配置快照只通过 `agent-runtime.applyConfig` 分发给实际配置所有者。保存属于领域 Store，不能为了页面排版合并不同领域的隐式事务；命令与事件顺序问题见[状态地图](./state-and-ipc.md)。

时间线的 [conversation-timeline](../../src/stores/conversation-timeline.ts) 分离 durable history 与 live overlay 投影；[conversation-timeline-view](../../src/stores/conversation-timeline-view.ts) 缓存历史，复用条目与列表引用，让消息和 [ReasoningText](../../src/components/chat/ReasoningText.vue) 各自读取实时文本。[use-stream-text](../../src/composables/use-stream-text.ts) 合并展示更新，[use-scroll-follow](../../src/composables/use-scroll-follow.ts) 统一外层和思考区的尺寸观察、每帧调度与用户意图取消。工具卡只读取 Runtime Store，审批用量由该 Store 按调用 ID 索引。

[MarkdownBlock](../../src/components/MarkdownBlock.vue) 使用 [Markdown 解析器](../../src/markdown.ts) 输出可复用的顶层块，由 [MarkdownSection](../../src/components/MarkdownSection.vue) 独立更新 DOM。[markdown-code](../../src/markdown-code.ts) 管理高亮结果缓存及任务去重，通过 [Worker 协议](../../src/markdown-highlight-protocol.ts) 调用 [markdown-highlight-worker](../../src/markdown-highlight-worker.ts)。文件代码预览复用同一高亮服务；Worker 只处理代码文本，不访问应用 IPC 或凭据。

## 状态与契约

Files/Diff 使用 [workspace-files Store](../../src/stores/workspace-files.ts) 的项目级失效 revision；事件先按 Session 记录解析项目归属，迟到的归属记录暂缓处理，不回退到当前选择。[use-active-workspace-refresh](../../src/composables/use-active-workspace-refresh.ts) 合并、串行调度可见面板的自动读取，并处理项目切换与销毁。回归见 [ownership](../../src/stores/workspace-files.test.ts)、[scheduler](../../src/composables/use-active-workspace-refresh.test.ts) 和 [实际面板](../../src/components/artifacts/WorkspaceRefresh.test.ts)。

设置表单的快照确认、重复保存合并及自动保存排空由 [settings-draft-save.ts](../../src/stores/settings-draft-save.ts) 统一；领域 Store 保留 payload、凭据分步保存和错误映射。竞态回归见 [settings-save-races.test.ts](../../src/stores/settings-save-races.test.ts)，Naive UI 密钥输入绑定见 [WebSearchSettingsPanel.test.ts](../../src/components/settings/WebSearchSettingsPanel.test.ts)。

Settings 的八个一级配置领域与 shared/config 一致；project/archived 是管理页，不声明 ConfigSection。Models 由角色和模型池 Store 分担，Providers 管连接与模型目录。Composer draft 由独立前端 Store 按项目/会话写入 localStorage，Facade 的 `input/contextAttachments` 绑定当前草稿；运行水合和消息分页不拥有它。Git Review 是 Project 临时结果；Todo 从已加载 Message 尽力派生。

发送/插话/编辑先捕获草稿 owner 与 revision，回包只消费未变的原草稿。`agent-replica` 的本地 `navigationRevision` 保护异步选中和新会话创建后的导航；bootstrap 恢复最后输入页，切换与关闭刷新浏览器存储。归档保留草稿，明确删除与完整项目列表负责清理，详见[Draft 规范](../architecture/sessions.md#draft)。

## 修改指引

- 新增设置项：shared 所属领域 schema → ConfigStore/迁移 → 领域 Store → 页面区域；需要新导航时只改 `SETTINGS_PAGES`，同时查语言资源和失败/重试状态。
- 新增消息展示：先定位 canonical kind/parts、timeline 投影与组件；不要把 harness、hidden Session 或 continuation 当作普通聊天展示。
- 修改通知：从统一 bridge 和 Store 改去重/队列；运行 retry 槽、持续 trace 状态与瞬时 error 不应混用。
- 改视觉先查 [Naive UI 文档](https://www.naiveui.com/zh-CN/os-theme/docs/introduction)和现有主题；领域 CSS 位于 [styles](../../src/styles/)，交互验收见[前端专题](../frontend-spec.md#专题规范)。

## 验证入口

草稿回归包括[独立存储与写入失败](../../src/stores/composer-drafts.test.ts)、[异步动作归属和导航](../../src/stores/agent-runtime-drafts.test.ts)及[Electron 重载与重启](../../e2e/features.drafts.spec.ts)。

[BackgroundTab tests](../../src/components/artifacts/BackgroundTab.test.ts) 验证手动展开、停止与既有 Agent 展示；[Terminal tail tests](../../src/components/artifacts/BackgroundTerminalTail.test.ts) 验证轮询、暂停、迟到响应和纯文本渲染。

流式渲染回归包括[投影引用稳定性](../../src/stores/conversation-timeline-view.test.ts)、[工具卡更新隔离](../../src/components/chat/ConversationTimeline.test.ts)、[滚动竞态](../../src/composables/use-scroll-follow.test.ts)、[展示合并](../../src/composables/use-stream-text.test.ts)、[Markdown 语义](../../src/markdown.test.ts)、[DOM 保留](../../src/components/MarkdownBlock.test.ts)、[高亮缓存](../../src/markdown-code.test.ts)及[构建后流式交互](../../e2e/features.streaming-rendering.spec.ts)。

| 测试                                                                                                                                                                               | 验证内容                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| [agent-runtime.test.ts](../../src/stores/agent-runtime.test.ts)、[agent-replica.test.ts](../../src/stores/agent-replica.test.ts)                                                   | 动作、事件和状态所有权           |
| [settings-tabs.test.ts](../../src/components/settings/settings-tabs.test.ts)                                                                                                       | registry 与领域映射              |
| [conversation-timeline.test.ts](../../src/stores/conversation-timeline.test.ts)                                                                                                    | 可见性与消息/工具顺序            |
| [AppMessageBridge.test.ts](../../src/components/layout/AppMessageBridge.test.ts)                                                                                                   | NMessage 通知行为                |
| [DiffTab.test.ts](../../src/components/artifacts/DiffTab.test.ts)                                                                                                                  | Git Review 状态、选择与异步结果  |
| [settings.spec.ts](../../e2e/settings.spec.ts)、[features.chat-tools.spec.ts](../../e2e/features.chat-tools.spec.ts)、[artifact-layout.spec.ts](../../e2e/artifact-layout.spec.ts) | 构建后的设置、聊天工具和布局路径 |

## 用量显示与缓存

[UsageTab](../../src/components/artifacts/UsageTab.vue) 展示当前上下文的 bytes 大小、分类占比和调用用量，[UsageMetrics](../../src/components/artifacts/UsageMetrics.vue) 复用 token 指标展示。[session-usage Store](../../src/stores/session-usage.ts) 独立持有有界 localStorage 数字缓存、查询合并和删除失效。页头保留现有模板，从统计快照恢复数据。验证见[Store 测试](../../src/stores/session-usage.test.ts)与[Electron 用量流程](../../e2e/features.usage.spec.ts)。
