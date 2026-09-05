# 早期前端阶段与验收记录

状态：历史记录。P2–P5 是旧实施阶段；下列未勾选清单不代表当前缺失能力。当前要求见[前端规范](../frontend-spec.md)，未完成方向见[路线图](../road-map.md)。

## 15. 阶段可见性

| 能力                  |   P2 |         P3 |         P4 |   P5 |        Post-MVP |
| --------------------- | ---: | ---------: | ---------: | ---: | --------------: |
| 项目选择与项目侧栏    | 必须 |       必须 |       必须 | 必须 |            必须 |
| 对话列表与搜索        | 基础 | 完整本地版 |       保持 | 保持 |      可扩展同步 |
| Chat/Markdown/流式    | 必须 |       必须 |       必须 | 必须 |            必须 |
| Files Explorer/Viewer | 基础 |       必须 |       必须 | 必须 |            必须 |
| 文件审批与 Git Review |    - |       必须 |       必须 | 必须 |            必须 |
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
- [ ] Sidebar 与搜索结果不显示 workspace writer 状态；Run/approval/failed/completed 反馈只在对应对话的统一状态区展示。
- [ ] running/start pending/approval conversation 的 delete、fork 和 remove project 被禁用并说明原因。

### 16.3 对话与输入

- [ ] 流式文本、折叠 reasoning、工具卡和结构化错误正常。
- [ ] 操作 warning/error 通过 NMessage 展示，不进入 Timeline；10 秒 warning、持久 error、5 条排队、去重和后台 Session 标题符合规范。
- [ ] Reasoning 折叠区只展示 `normalizedReasoningText`；缺失时不显示，opaque `providerContinuation` 永不进入 UI。
- [ ] `kind = 'user_input'` 才渲染为用户气泡；orchestrator/runtime context/harness 不伪装成用户输入。
- [ ] `text/tool_call/tool_result` parts 按原始顺序渲染，工具卡可由完整 MessageRecords 稳定重建；Renderer 不生成 Provider DTO。
- [ ] active Run 和 pending approval 时禁止重复发送。
- [ ] Enter、Shift+Enter 和 IME 行为符合规范。
- [ ] 模型和权限模式只使用紧凑控件，不放入侧栏大卡片。
- [ ] Todo 不生成时间线大卡片；输入框上方只显示单行当前项，悬停后在有界滚动浮层中展开完整清单。
- [ ] 不同 Session 可在同一 workspace 并发运行和写入；renderer 不强制只读、不禁用权限选择，也不显示 workspace 并发警告。
- [ ] Limits 提供运行/工具硬限制与已发现的 command shell；Shell fallback 有可见警告，不提供全局 Run 或 workspace writer 配置。
- [ ] 对话输入区没有 Terminal 入口。
- [ ] Send/Stop 按钮与底部、右侧距离一致。

### 16.4 Files 与 Diff

- [ ] Explorer 独立加载真实 workspace，不依赖 Agent 工具历史。
- [ ] 文件树和文件内容通过二级 tab 切换，不同时拥挤展示。
- [ ] 文件 viewer 只读、有界、有行号和语法高亮。
- [ ] Diff 只展示当前 Project 实时 Git 状态，不因 pending 文件审批自动打开，也不按 Session/Run/Agent 归因。
- [ ] HEAD、unstaged、staged 和 merge-base 四种模式可切换；merge-base 显示实际 OID。
- [ ] tracked/untracked、rename/copy、binary、clean、detached/unborn 和非 Git 状态诚实展示。
- [ ] status/Diff 截断和查询错误有明确提示；二进制不展示 binary patch payload。
- [ ] Renderer/SQLite 不保存 `FileChangeSummary`、before/after、Diff history 或恢复 payload，界面没有文件 revert 按钮。

### 16.5 权限审批

- [ ] ReadOnly 写操作显示明确拒绝。
- [ ] Confirm 展示 tool、args、reason、signals 和 expiry，不生成审批 Diff。
- [ ] Deny 后文件逐字节不变。
- [ ] Approve 后只执行已批准 args；完成态显示操作摘要，不合成调用级 actual Diff。
- [ ] Approve & remember 后显示持久化规则。
- [ ] 重复、过期、跨 Session 的决定不可再次生效。
- [ ] 文件在审批后变化不自动使批准失效；参数/path/scope 变化仍失效，目标变成 symlink/junction/目录/越界路径仍拒绝。
- [ ] `apply_patch` 对最新内容只做精确唯一匹配，缺失或歧义时零写入并显示可行动错误。
- [ ] Yolo 首次启用显示 host-level side effects 告知。
- [ ] HTML、脚本和 prompt injection 只显示为文本。

### 16.6 Settings 与生命周期

- [ ] Project/Provider/Agents/Permissions/Limits/Logging 分组清晰；Agents 自动保存开关与 timeout，并显示费用和并发提示；Limits 可重新扫描、选择并持久化 command shell。
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
