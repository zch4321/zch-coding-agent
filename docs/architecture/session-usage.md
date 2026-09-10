# Session 用量与当前上下文

返回[架构总览](../architecture.md)。交互见[工作台](../frontend/workbench.md)，入口见[状态地图](../code-map/state-and-ipc.md)与[Provider 地图](../code-map/providers-and-context.md)。

## 所有权与存储

`SessionUsageService` 通过协调器拥有独立统计事务。SQLite migration 0014 新增两张表：

| 表                          | 内容与生命周期                                                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_usage_calls`       | 每个实际 Provider 请求收到的用量；按 source Session/call ID 去重，保存公共 Session、启动它的 root Run、scope/purpose、模型、子代理 execution/name 和六项可空 token 指标 |
| `session_context_snapshots` | 每 Session 一行，保存最近启动的公共 Run、当前上下文快照、history revision 和不含凭据的重算参数                                                                          |

不预注册 pending attempt，不从 Message/Trace 回填历史用量。只收到部分指标时保留已报告字段；明确的零值与未报告字段分别保存为 `0` 和 `NULL`。调用次数是收到用量的实际请求数。原始 usage JSON、请求正文、凭据均不进入统计表或前端缓存。

统计写入不修改 `sessions.revision` 或 `updated_at`。父 Session/Project 删除级联删除统计；归档保留。子代理源 Session 或 execution 的清理不删除已经归属父 Session 的消耗。分叉只复制消息，没有父会话的用量记录；回退不撤销已经发生的调用消耗。

migration 0015 清空旧的 token 估算上下文快照和重算参数，下次有效捕获按 bytes 重新生成；最近公共 Run 的选择、调用用量和消息历史均保留。旧估算值不能还原准确字节数，不做换算或回填。迁移验证见[缓存迁移测试](../../electron/persistence/context-usage-bytes-migration.test.ts)。

## 采集与归属

`usage-observer` 在 Provider completion 到达时先记录，再交给业务验证。审批模型返回无效决策、标题未被采用、压缩验证失败时，已收到的用量仍保留。带 usage 的 completion error 复用各 Provider 的标准化逻辑；Chat/Anthropic 传输中断也保留中断前已收到的指标，同时保持原始错误和重试分类。每次实际重试使用新的 call ID，无用量的失败请求不产生记录。

主对话、审批、压缩和标题生成按实际用途入表。隐藏子代理通过 `subagent_sessions → subagent_executions` 解析公共父 Session 与启动 Run，所有子调用统一归入 `subagent`，同时保留实际 purpose。父事件转发、子任务最终汇总不重复入账。子代理后台继续运行时，数据仍写入原来的父 Run，不随当前选中会话或新 Run 改变。

聚合分为整个 Session 与当前/最近 root Run。公共 Run 在预先压缩前更新选择身份，压缩失败不会让最近运行退回上一轮。辅助调用完成时间不能改变该选择。每类提供精确总和，以及至多 100 个模型和最近 100 个子任务的展开摘要。

## 当前上下文

有效历史经过 `MessageHistoryCompiler` 筛选与配对检查，排除 `inHistory = false` 和 superseded 记录。复用各 Provider 的纯输入投影，按来源归类：

| 类别     | 内容                                                        |
| -------- | ----------------------------------------------------------- |
| 系统提示 | 基础指令、助手偏好、项目指令                                |
| 用户输入 | 用户消息、实时补充、已进入历史的文件与选中上下文            |
| 编排消息 | 运行环境、编排续跑消息、压缩摘要、会话记录锚点              |
| 助手回复 | 当前有效回复及实际重放到 Provider 的 reasoning/continuation |
| 工具定义 | 已编译请求中的工具说明与 schema                             |
| 工具调用 | 助手输入中的 function call / tool use                       |
| 工具结果 | 进入模型上下文的有界结果投影                                |

对各来源的 Provider 输入投影执行 JSON 序列化，以 UTF-8 字节数记录 `bytes`，类别之和为 `totalBytes`，分类占比以此为分母。工具定义直接计量已编译的 schema。统计包含各来源的协议内容包装，不包括 model、max_tokens、stream 等控制参数；它描述内容构成，不等同于整个 HTTP 请求体大小。上下文分类不使用 token 估算器或模型窗口容量；调用用量与页头继续使用 Provider token 指标。

首次输入持久化、Provider 请求编译、工具批次完成和压缩提交后更新快照。未完成工具批次不发布半条上下文。查询在持久历史 revision 改变时重算，复用已经记录的工具大小和来源，不重新读取工作区文件。每类保留至多 100 条来源/消息序号/大小，不复制正文。回退导致冻结 Provider route 与历史不兼容时清空该上下文快照，仍返回用量汇总，后续有效捕获重新建立上下文。

## IPC 与前端缓存

`session:usage` / `getSessionUsage` 只接受公共 Session ID，返回 context、all、currentRun 与 header；payload/result 均在既有 IPC 边界校验。写入成功后发布 `session.usage.changed`，其 change 仅含公共 sessionId，并使用原有 durable commit cursor。Renderer replica 接收游标；独立 `session-usage` Store 负责查询和整份替换数据。

同一 Session 只允许一个查询在途，期间收到失效事件会在完成后再查。切换会话、重新加载、侧栏打开和事件缺口恢复都刷新。删除时失效旧请求，迟到响应不能复活缓存。查询失败保留上次显示。

localStorage 的 `session-usage` 键只缓存最近 20 个会话的数字摘要、上下文分类合计和页头指标，总大小不超过 1 MB；模型/任务展开列表及上下文来源列表不缓存。不做旧缓存格式适配，解析或 schema 校验失败就忽略缓存。前端缓存不参与后端累计或运行判断。

## 页头与侧栏

页头保持原布局、文案与计算方式：最近一次主调用的输入/窗口，当前或最近 Run 的缓存命中、未命中和输出之和。标题生成计入侧栏整个会话/运行明细，不进入原页头累计。页头从持久统计恢复，活动事件可在查询更新前保持显示。

右侧“用量”页签分为“当前上下文”和“用量明细”。前者以 bytes 展示总大小、分类大小和来源大小，提供分段条、分类占比与来源展开，不显示最大上下文长度；后者保留 token 指标，切换整个会话或当前/最近运行，按主对话、子代理、工具审批、上下文压缩、标题生成分组，展开模型或子任务。字段缺失显示破折号，不添加历史覆盖或准确性提示文案。

输入草稿存储不属于本次统计功能。
