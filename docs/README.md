# 开发者文档

这里是仓库文档的总入口。产品安装从[项目 README](../README.md)开始；开发约束以 [AGENTS.md](../AGENTS.md) 为准。

## 推荐阅读顺序

1. [开发指南](./guides/development.md)：把应用跑起来，了解日常和完整验证门禁。
2. [架构总览](./architecture.md)：理解进程、状态和安全边界。
3. [Code map](./code-map/README.md)：按修改任务选择代码和测试入口。
4. 涉及行为变化时，阅读[产品要求](./requirements.md)或[前端规范](./frontend-spec.md)；涉及架构取舍时查[决策索引](./decision-log.md)。

## 文档分工

| 文档                                   | 回答的问题                 | 维护内容                             |
| -------------------------------------- | -------------------------- | ------------------------------------ |
| [产品要求](./requirements.md)          | 产品提供什么，限制是什么？ | 当前能力、可用条件、可观察行为       |
| [架构规范](./architecture.md)          | 实现必须遵守什么？         | 所有权、依赖方向、不变量和专题规则   |
| [前端规范](./frontend-spec.md)         | 用户如何操作，怎样验收？   | 交互、显式状态、视觉和可访问性       |
| [Code map](./code-map/README.md)       | 去哪里改，怎样验证？       | 当前入口、调用链、契约和测试定位     |
| [操作指南](./guides/development.md)    | 一件事怎样完成？           | 开发、配置、Headless、排障和验证步骤 |
| [决策](./decision-log.md)              | 为什么这么做？             | 背景、决定、代价和替代关系           |
| [路线图](./road-map.md)                | 后面做什么？               | 未完成事项、依赖和验收目标           |
| [开放问题](./open-design-questions.md) | 还有什么没决定？           | 可观察现状、待回答问题和实现线索     |
| [发布记录](./releases/README.md)       | 某个版本发生了什么？       | 发布流程、升级影响和版本事实         |
| [档案](./archive/README.md)            | 以前如何迁移？             | 完成的计划和阶段记录，明确冻结状态   |

## 操作指南

- [开发环境、命令与分支](./guides/development.md)
- [配置、权限、MCP 与 Skills](./guides/configuration.md)
- [Headless CLI](./guides/headless.md)
- [排障、备份与恢复](./guides/troubleshooting.md)
- [验证与回归定位](./guides/testing.md)
- [文档写作与维护](./guides/documentation.md)

## 维护原则

每个事实只在所属文档完整描述，其他页面链接引用。Code map 描述当前代码；架构和前端文档保留已采纳约束。发现两者不一致时，先核对源码与测试，明确记录偏差，再更新规范或实现，不能用文档整理默默改变产品要求。

所有源文件入口使用仓库相对 Markdown 链接。文件移动时同时更新地图和入链；状态改变时更新产品范围与相关规范。无需为局部修复刷新所有页面的日期。校验范围和命令见[文档维护指南](./guides/documentation.md)。
