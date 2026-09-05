# 前端产品与验收规范

本文规定当前工作台的信息架构与交互验收。产品能力见[需求文档](./requirements.md)，技术约束见[架构总览](./architecture.md)，组件与 Store 入口见 [Renderer 地图](./code-map/renderer.md)。未实现方向进入[路线图](./road-map.md)，不使用旧阶段编号判断当前功能是否应显示。

## 产品原则

- 对话是主流程；消息、reasoning、工具和审批在对应位置展示，瞬时操作反馈进入全局 NMessage。
- 只展示真实可用的能力；暂停或未实现功能不保留可点击占位。
- Renderer 收集输入并展示 Backend 的已提交状态与实时 overlay，不拥有独立的持久化对话。
- 用户无需理解内部 identity；常驻 UI 不暴露 hidden Session、Provider continuation、原始凭据或主进程堆栈。
- 用已有 Naive UI 组件和主题保持一致的键盘、焦点、禁用、加载和错误状态；新增交互前查阅组件的支持方式。

## 信息架构与术语

```text
顶栏：当前项目、布局入口、设置、窗口控制
├─ 项目侧栏：项目、对话、新对话、搜索
├─ 对话工作列
│  ├─ Header、消息流、对话输入区
│  └─ Terminal 底部面板
└─ Artifact 侧栏：Files / Diff / Plan / Agents
```

Project 是持久化工作区身份；Session 是该 Project 下的一段对话；Run 是一次执行。切换 Session 不取消它的运行。Files 和 Diff 查询当前 Project；Plan 和 Agents 跟随所选 Session。Terminal 位于对话工作列底部，不属于 Artifact。

ProjectModel/Serena 暂停期间不显示 Project artifact tab；Browser 尚未实现。全局设置位于独立 Settings 页面，不与 workspace 文件或 Agent 运行详情混合。

## 专题规范

| 文档                                       | 内容                                                       |
| ------------------------------------------ | ---------------------------------------------------------- |
| [工作台交互](./frontend/workbench.md)      | 窗口、项目导航、消息、审批、输入、Artifact 和 Terminal     |
| [设置交互](./frontend/settings.md)         | 配置领域、自动保存、Provider、权限、Agents、日志与归档管理 |
| [视觉与可访问性](./frontend/appearance.md) | 主题、字体、尺寸、响应式、焦点和安全渲染                   |

## 显式状态

| 状态                       | 对话和输入                                | 其他区域                          |
| -------------------------- | ----------------------------------------- | --------------------------------- |
| 未选项目或 Provider 未配置 | 显示相应引导，禁止发送                    | 已有 Project 可浏览本地文件       |
| Idle                       | 正常输入，不显示内部 IDLE badge           | 保留用户选择                      |
| Calling LLM / Running tool | 显示真实活动，Send 替换为 Stop            | 不自动抢占 Artifact tab           |
| Retrying LLM               | 在时间线运行槽显示 attempt 进度           | Agents 同步同一进度；不弹瞬时错误 |
| Waiting approval           | 显示所属调用的审批，禁止普通发送，可 Stop | 保留审查上下文                    |
| Cancelling                 | 显示取消中，禁用重复 Stop                 | 保留内容直到终态                  |
| Failed                     | NMessage 展示错误，恢复合法输入/重试入口  | 保留审查上下文                    |
| Archived                   | 历史只读，恢复后可发送                    | Files/Git 仍按 Project 查询       |

warning/error 不写入 Message 或 Timeline。NMessage 位于顶栏下方，warning 可自动关闭，error 保留到用户处理；去重与有界排队由统一通知桥负责。日志 capture 的持续状态保留在 Header/设置。

## 当前验收场景

1. 首次发送成功前不生成 Sidebar 空 Session；提交失败保留明确错误。
2. IME composition 的 Enter 不发送；开始、等待审批和取消中的按钮不能重复触发操作。
3. 切换 Session 后，各自的消息、运行 overlay、审批、Agents 和 Terminal 不互相污染。
4. 工具参数、reason、Diff 与 Markdown 中的不可信文本不能执行 HTML 或危险链接。
5. 首次 Yolo、Full Trace 启用及 Transcript 导出显示各自必要告知，不能彼此代替。
6. retry/edit/rewind/fork 清楚提示只影响对话；Git Review 不显示应用级文件恢复按钮。
7. Renderer reload 从 Backend snapshot/commit 恢复已提交状态；partial stream 不伪装成 durable Message。
8. Agents root/child 手动展开，流式更新不自动打开新 tab，不泄露 hidden identity。
9. 设置的旧保存响应不覆盖新草稿；失败可重试，跨领域写入由实际配置所有者完成。
10. 窄窗口、长路径、长代码和键盘导航仍能访问主要功能，折叠区域有恢复入口。

自动回归入口见 [Renderer 地图](./code-map/renderer.md)和[验证指南](./guides/testing.md)。旧阶段清单保留为[历史档案](./archive/frontend-phases.md)，不再作为待完成任务列表。
