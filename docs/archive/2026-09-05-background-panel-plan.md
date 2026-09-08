# Background 侧栏与后台任务控制

本计划实现当前对话的统一后台任务视图。现行规则见 [Workbench](../frontend/workbench.md#background)、[Agent execution](../architecture/agent-execution.md#background-ui-与取消收尾) 和 [Terminal](../architecture/integrations.md#terminal-关闭与日志预览)。

## 交互与边界

- Agents 更名为 Background；Subagent 与 Swarm 保留原有输出和两级手动展开，增加独立停止按钮。
- 第一层同时展示当前对话的手动、主 Agent 与 hidden child 终端。活动项优先，每页 50 条，后台独立统计顶层活动总数。
- 停止 Subagent 关闭其终端；停止 Swarm 覆盖全部 child 终端，包括已完成 child 遗留资源；停止单个 child 不影响 sibling。
- 主 Run Stop 和正常 Agent 完成不关闭独立终端。右侧 tail 不创建、不打开底部 xterm，既有交互终端保留。

## 实现

- shared 类型与 IPC 提供列表、停止和 Terminal tail；只接受公开 owner 与任务身份，终端请求绑定 backend 实例。
- 主进程根据登记路径读取普通文件的尾部：32 KiB 分块，最多扫描 256 KiB，返回最近 200 行、最多 64 KiB；处理 UTF-8、缺失与捕获失败。
- 可见、展开、正在跟随时每秒更新，单请求在途；滚动暂停跟随，支持恢复与复制；退出后读取最终内容并停止轮询。
- Swarm 保留现有状态机，补齐预留窗口取消与失败补偿；子 Agent 和 PTY 真实收尾后再终结，Terminal 使用 closing 过渡状态。
- 实例内 runtime 水位与 execution sequence 用于摘要合并和流式快照恢复；请求与目标绑定，丢弃迟到或旧实例响应。

## 验收入口

- 确定性回归覆盖 owner/实例隔离、混合分页、活动计数、启动取消、延迟退出、不可立即中断的操作、日志界限、旧快照和事件回放。
- 组件测试覆盖手动展开、停止不展开、日志纯文本、可见性轮询与暂停跟随。
- `npm run check`、原生 PTY smoke 和构建后的相关 Playwright 验证；合并前完整 `npm run verify`。

## 提交边界

从既有 sidebar 分支创建 `feat/background-panel`，先独立提交用户已有样式，再提交本功能及文档；不包含其余 code-review 修复，也不自动合并。
