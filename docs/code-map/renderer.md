# Renderer、组件与设置

返回[总地图](./README.md)。交互要求见[前端规范](../frontend-spec.md)，状态规则见[架构](../architecture.md)。

## 职责与边界

Vue Renderer 通过冻结 `agentApi` 发命令、查数据、订阅事件。Pinia 区分 durable replica、瞬时运行 overlay、配置草稿和纯 UI；组件不直接访问 Electron/Node、工作区或凭据。

## 关键入口

| 文件 / 符号                                                                                                                                            | 责任                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| [main.ts](../../src/main.ts)、[App.vue](../../src/App.vue)                                                                                             | Vue、Pinia、Provider 和工作台装配                    |
| [agent.ts](../../src/stores/agent.ts)、[agent-shell.ts](../../src/stores/agent-shell.ts)                                                               | 公共 Store facade、界面选择与订阅生命周期            |
| [agent-runtime.ts](../../src/stores/agent-runtime.ts)                                                                                                  | 发送/重试/继续、配置 fan-out、Runtime 动作           |
| [agent-replica.ts](../../src/stores/agent-replica.ts)                                                                                                  | 已提交领域副本与消息分页                             |
| [agent-runtime-events.ts](../../src/stores/agent-runtime-events.ts)、[agent-runtime-subscriptions.ts](../../src/stores/agent-runtime-subscriptions.ts) | 事件转 overlay 与 durable reconciliation             |
| [conversation-timeline.ts](../../src/stores/conversation-timeline.ts)、[ConversationTimeline.vue](../../src/components/chat/ConversationTimeline.vue)  | Canonical records 和活动的有序展示                   |
| [MessageComposer.vue](../../src/components/chat/MessageComposer.vue)、[ApprovalCard.vue](../../src/components/chat/ApprovalCard.vue)                   | 输入/IME/模型模式和审批交互                          |
| [ArtifactPanel.vue](../../src/components/artifacts/ArtifactPanel.vue)、[TerminalPanel.vue](../../src/components/TerminalPanel.vue)                     | 右侧文件/Git/Plan/Background 与底部 PTY              |
| [settings-tabs.ts](../../src/components/settings/settings-tabs.ts) / `SETTINGS_PAGES`                                                                  | 配置领域、导航、组件与 ConfigSection 的唯一 registry |
| [AppMessageBridge.vue](../../src/components/layout/AppMessageBridge.vue)、[notifications.ts](../../src/stores/notifications.ts)                        | 操作通知去重和 NMessage 展示                         |
| [naive-theme.ts](../../src/theme/naive-theme.ts)、[style.css](../../src/style.css)、[i18n.ts](../../src/i18n.ts)                                       | Naive 主题、领域样式入口和本地化                     |

## 主要调用链

[background-tasks.ts](../../src/stores/background-tasks.ts) 拥有后台列表、活动总数和停止请求；[BackgroundTab.vue](../../src/components/artifacts/BackgroundTab.vue) 复用 Agent/Swarm 内容并组合终端卡片；[BackgroundTerminalTail.vue](../../src/components/artifacts/BackgroundTerminalTail.vue) 只在可见并跟随时读取日志，与底部 xterm 独立。

```text
用户动作 → Component → owning Store → agentApi → Backend
  → command result / push event → replica 或 Runtime overlay
  → timeline / view model → Vue
```

配置快照只通过 `agent-runtime.applyConfig` 分发给实际配置所有者。保存属于领域 Store，不能为了页面排版合并不同领域的隐式事务；命令与事件顺序问题见[状态地图](./state-and-ipc.md)。

## 状态与契约

Settings 的八个一级配置领域与 shared/config 一致；project/archived 是管理页，不声明 ConfigSection。Models 由角色和模型池 Store 分担，Providers 管连接与模型目录。纯 UI draft 不持久化；Git Review 是 Project 临时结果；Todo 从已加载 Message 尽力派生。

## 修改指引

- 新增设置项：shared 所属领域 schema → ConfigStore/迁移 → 领域 Store → 页面区域；需要新导航时只改 `SETTINGS_PAGES`，同时查语言资源和失败/重试状态。
- 新增消息展示：先定位 canonical kind/parts、timeline 投影与组件；不要把 harness、hidden Session 或 continuation 当作普通聊天展示。
- 修改通知：从统一 bridge 和 Store 改去重/队列；运行 retry 槽、持续 trace 状态与瞬时 error 不应混用。
- 改视觉先查 [Naive UI 文档](https://www.naiveui.com/zh-CN/os-theme/docs/introduction)和现有主题；领域 CSS 位于 [styles](../../src/styles/)，交互验收见[前端专题](../frontend-spec.md#专题规范)。

## 验证入口

[BackgroundTab tests](../../src/components/artifacts/BackgroundTab.test.ts) 验证手动展开、停止与既有 Agent 展示；[Terminal tail tests](../../src/components/artifacts/BackgroundTerminalTail.test.ts) 验证轮询、暂停、迟到响应和纯文本渲染。

| 测试                                                                                                                                                                               | 验证内容                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| [agent-runtime.test.ts](../../src/stores/agent-runtime.test.ts)、[agent-replica.test.ts](../../src/stores/agent-replica.test.ts)                                                   | 动作、事件和状态所有权           |
| [settings-tabs.test.ts](../../src/components/settings/settings-tabs.test.ts)                                                                                                       | registry 与领域映射              |
| [conversation-timeline.test.ts](../../src/stores/conversation-timeline.test.ts)                                                                                                    | 可见性与消息/工具顺序            |
| [AppMessageBridge.test.ts](../../src/components/layout/AppMessageBridge.test.ts)                                                                                                   | NMessage 通知行为                |
| [DiffTab.test.ts](../../src/components/artifacts/DiffTab.test.ts)                                                                                                                  | Git Review 状态、选择与异步结果  |
| [settings.spec.ts](../../e2e/settings.spec.ts)、[features.chat-tools.spec.ts](../../e2e/features.chat-tools.spec.ts)、[artifact-layout.spec.ts](../../e2e/artifact-layout.spec.ts) | 构建后的设置、聊天工具和布局路径 |
