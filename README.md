# Zch Coding Agent

基于 Electron + Vue 3 的本地桌面编程助手。Agent 在指定工作区内读取代码、修改文件、运行命令，并通过工具结果继续完成任务。当前桌面发布目标为 Windows x64。

![Workbench](docs/images/readme/workbench.png)

## 安装与使用

从 [GitHub Releases](https://github.com/zch4321/zch-coding-agent/releases) 下载 `Zch Coding Agent-Windows-*-Setup.exe` 并安装。启动后选择工作区，在设置中配置 Provider、模型和 API Key，然后发送任务。

权限模式支持 ReadOnly、Auto、Confirm 和 Yolo。文件工具校验工作区路径和执行参数；命令与终端运行在主机上。权限选择、MCP 配置和 Skills 安装见[配置指南](docs/guides/configuration.md)。

## 主要能力

- Project 与 Session 管理、持久化消息、对话搜索、重试、继续和分支。
- 多轮工具调用、上下文压缩、Goal/Plan、运行中插话。
- 文件读取、检索、创建、覆盖、精确补丁与删除；短命令和持久 PTY。
- Project 级实时 Git Review；文件恢复由用户通过 Git 管理。
- DeepSeek、MiMo、Generic Chat Completions、Responses 与 Anthropic 协议接入。
- 本地 Skills、Generic MCP stdio gateway，以及可启用的异步 Subagent 和 Desktop Swarm。
- 运行日志、可选完整 Trace、只读 Transcript 和复用同一 Runtime 的 Headless CLI。

各能力的可用条件、暂停状态和限制统一维护在[产品范围](docs/requirements.md#当前能力与范围)。ProjectModel、Serena 与代码智能当前暂停，恢复工作见[路线图](docs/road-map.md)。

## 开发

需要 Node.js 24 和 npm，在仓库根目录运行：

```powershell
npm ci
npm run dev
```

日常修改先格式化，再运行 `npm run check`；合并或发布前运行 `npm run verify`。开发环境、原生依赖和命令说明见[开发指南](docs/guides/development.md)。

## 文档入口

| 目标               | 从这里开始                                                                     |
| ------------------ | ------------------------------------------------------------------------------ |
| 第一次了解项目     | [文档导航与阅读顺序](docs/README.md)                                           |
| 找到代码和测试     | [Code map 与修改任务索引](docs/code-map/README.md)                             |
| 理解状态和安全边界 | [架构总览](docs/architecture.md)                                               |
| 修改交互           | [前端规范](docs/frontend-spec.md)                                              |
| 自动化调用         | [Headless 指南](docs/guides/headless.md)                                       |
| 排查问题、备份数据 | [排障与恢复](docs/guides/troubleshooting.md)                                   |
| 贡献代码           | [仓库规则](AGENTS.md)、[开发指南](docs/guides/development.md)                  |
| 查看版本变更       | [未发布变更](docs/releases/unreleased.md)、[发布流程](docs/releases/README.md) |
