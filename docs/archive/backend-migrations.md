# Backend 迁移记录

状态：历史记录，冻结于 2026-09-05 文档整理。下文保留旧阶段名称和迁移顺序，不作为当前开发要求；当前边界见[架构总览](../architecture.md)，可执行迁移见 [SQLite migration registry](../../electron/persistence/migrations/index.ts) 与 [Config migrations](../../electron/config/migrations.ts)。

## 19. 迁移方案

### 19.1 新数据库启用

切流版本首次启用 v2 persistence 时，创建 `agent.db` 并执行 SQLite schema migrations。旧 `workbench.json`、renderer localStorage 和 `change-history.json` 不参与新数据库初始化或状态恢复；新架构从 SQLite 中已有的 records 开始，没有 records 时显示空 Project/Session 状态。

切流不读取、改写、重命名或删除这些旧文件。`schema_migrations` 只负责 `agent.db` 自身的 schema version，不承担旧 Conversation/Message 数据转换。标准 SQLite v11 删除数据库内已经失去产品消费者的 FileChange 表，v12 为历史 v11 分叉执行兼容收敛。

### 19.2 切换顺序

1. 引入 shared Session/Message/MessagePart schemas、Project/Session/Message repositories 和完整 tool batch transaction。
2. Runtime 改为从 messages 查询 active history，Renderer 改为 Project/Session/Message replica。
3. 删除 `workbench:save`、frontend conversation persistence、legacy change-history JSON 和 memory-only canonical history。
4. 文件基础设施统一迁入 `electron/common/filesystem`，`create_file` 切换为 `write_file` 并采用 latest-content/last-writer-wins 语义。
5. 删除 FileChange service/repository/codec/IPC/renderer state、审批 Diff、恢复流程和 Headless patch artifact；SQLite v12 保证所有受支持的 v11 路径都删除遗留表。
6. 新增 Project 级 `git-review:get-status/get-diff`，只实时读取 Git，不写入应用状态。

迁移不长期双写。

---

## 21. 当前迁移状态

P0–P13 已完成。Desktop、Headless、IPC、preload 和 renderer 默认路径均使用唯一 `createBackendRuntime` 与 SQLite Durable Backend。Desktop 数据库为 `userData/agent.db`；数据库打开或 migration 失败时显示阻塞恢复对话框，不回退 Workbench。Headless 使用任务独立临时数据库并在退出时关闭、删除。

2026-09-02 已完成 `electron/common/filesystem`、`write_file`、latest-content `apply_patch`、幂等 binary-safe `delete_file` 和 Project 级 Git Review。应用不再维护审批 Diff、Run/Session FileChange、patch history、恢复 payload 或回退命令；用户直接通过 Git 管理恢复。切流、schema migration、兼容边界和已知限制见 [`file-tools-filesystem-refactor-plan.md`](./file-tools-filesystem-refactor-plan.md)。

P11 Provider Runtime Foundation 与 P12 Generic Responses/Anthropic 已完成。Main 与 auto approver 使用扁平 `ModelProvider.compile/stream`，compact 使用同一实现上的 `compileCompact/compact`；生产实现为互不继承的 `deepseek.chat-completions`、`mimo.chat-completions`、`generic.chat-completions`、`generic.responses` 与 `generic.anthropic`。MiMo 专用实现发送官方 `max_completion_tokens + thinking.enabled/disabled` 字段，并通过 MiMo continuation 完整回传带工具调用轮次的 `reasoning_content`；其所有非关闭 reasoning 档位按供应商能力统一为启用思考。配置、route、continuation 和 compact envelope 统一使用 `providerType`；Google 和其他具体厂商实现继续按实际使用需求独立增加。

P13 Subagent Runtime 的 S1–S4 已完成，并扩展为异步 background execution。默认关闭的 `subagent_run({ name, task, toolAccess })` 和 Desktop `swarm_run` 在 durable reservation/artifact 初始化后立即返回 handle；隐藏 Session 继续复用唯一 Run/Provider loop并读取 live workspace 与共享 Session temp。`background_wait/list/cancel` 统一管理 standalone Subagent、Swarm root/child 和 Terminal；父 Run 结束不再取消后台任务，Session/Project 生命周期与 app dispose 负责收敛。Session 级 `maxSubagents` 原子限制 active leaf。`/swarm` 只保留为显式编排快捷命令，Headless Runtime Identity 明确声明不支持 Swarm，但支持异步 Subagent/background tools。递归委派、自定义 child 工具 ID 列表、取消 UI 和可继续聊天的 child 页仍未实现。

Tool Result projection 已统一进入生产主链：完整内部 `ToolResult` 只供安全、trace 和插件使用，模型历史与 `tool.completed` 使用 `model-content.v1` canonical parts。冻结的 256 KiB 统一字节保险作用于 `bounded` projection；500 行配置由工具自行消费，当前 `read_file/background_list` 精确分页，`read_skill` 在 256 KiB 源文件边界内 passthrough。Terminal/Command/Agent/Fetch/Search/MCP 的完整输出按策略写入 Session artifact。旧 active Tool Result 不迁移并明确拒绝续聊。

Renderer 只维护 Project/Session replicas、分页 Message cache、每 Session runtime overlay 和 UI-only draft/selection。Git Review 是按需重取的临时 Project read model。首次发送前不创建空 Session；所有 durable command response 与 `domain-state:event` 经同一 reconciler 处理 cursor/revision、重复 delivery、缺口和 backend instance 变化。

后台异步故障经版本化 `app:notification` 交付；preload 在 renderer 挂载前做 64 条有界缓存。Renderer 以 `NMessage` 展示瞬时操作反馈：warning 10 秒、error 手动关闭、最多 5 条并排队，且按 code/Session/message 去重。通知不进入 durable replica 或 Timeline；日志 capture 的持续状态留在 Header/设置。

`MessageRecord` 使用 `visibility + inHistory + turnId` 分离展示、模型历史和轮次归属。Compact 只更新 `inHistory`；rewind 将移除分支标为 `superseded`，清除 Goal/Plan 并重建 active history。只有可见原始用户消息能 retry/edit；Assistant 不能作为 `run:retry` 目标。

SQLite transaction callback 通过 authorizer 拒绝事务控制 SQL；commit listener 逐项隔离；backend dispose 使用共享 promise 排空 live runtime/coordinator 后关闭数据库。SQLite v12 已保证删除 FileChange 表、retention state 和 triggers，并精确兼容已知的历史 v11 migration alternative。Legacy Workbench、Conversation durable records、renderer snapshot persistence、JSON ChangeHistory、旧 FileChange IPC 和 identity bridge 已删除。旧 `workbench.json`、`change-history.json` 与 localStorage 数据不迁移、不读取、不删除、不改写。普通 Session 已支持受警告保护的 `zch-conversation-markdown` 单向导出；Markdown 导入仍未实现，Trace transcript 查看/导出保持独立。

AppConfig v14 会把合法 v9 Provider 配置迁移为 `providerType`，把合法 v9/v10 配置中仍等于旧默认值的单次工具 token 与工具/read 字节限制提升到 64K/128KiB，为合法 v9/v10/v11 Provider 补充默认包含主模型的 `modelConfigurationIds`，为合法 v12 增加默认关闭、30 分钟 timeout 的 Subagent 配置，并从所有合法 v9–v13 配置删除退役的 `maxToolTokensPerRun`。AppConfig v15 再把合法 v14 `modelConfigurationIds` 原样迁移为 `enabledModelIds`，并让新安装的默认 Provider 从空模型池开始；已有主模型、API-key reference、模型目录、模型覆盖、revision、其余自定义限制和 `maxConcurrentRuns` 保持不变。

AppConfig v16 是 model-pool foundation 的冻结边界：Provider reasoning 与 pool entry reasoning 仅允许当时的 `off|high|max`，per-model annotation 尚不存在。AppConfig v17 集成六档 reasoning、annotation 和 approval route 的必填 `reasoning`，仍在每个 pool entry 保存 capability。AppConfig v18 删除重复 capability，调度时只读取 Provider `modelOverrides[model].capability`；AppConfig v19 再删除从未执行的 pool entry `maxParallel`，并在 `subagents` 增加默认 10、范围 1–32 的 `maxAgentsPerSwarm`。AppConfig v20 新增默认 `auto` 的 `executionEnvironment.commandShell`；合法 v9–v19 配置都保留各自可迁移字段并补入该默认值。AppConfig v21 把模型角色统合进 `models` 段：`activeProviderId` 与其 Provider 默认模型成为 `defaultModelProvider/defaultModel`，旧 `approval` 段成为 `auxiliaryModelProvider/auxiliaryModel`，`providers` 与 `modelPool` 平移入 `models`。AppConfig v22 再增加 `defaultModelReasoning/auxiliaryModelReasoning`，并从每个 Provider 删除 `reasoning`：v21→v22 分别把主/辅助角色所引用 Provider 的旧默认档位写入对应角色，从而保持实际请求等级；v9–v20 直接迁移采用相同结果。v9–v20 的旧独立 approval reasoning 已在 v21 决策中丢弃，直接升级到 v22 仍按当时所选 Provider 档位保持 v21 行为。不可用辅助 route 在 reload 修复阶段改写为当前主 route；Provider 不再持有可被角色隐式继承的 reasoning。当时的 Headless 临时内部 AppConfig 使用 v22 结构，外部配置仍为 v4 单 Provider，并把其可选 reasoning 映射到主角色。合法 v9–v15 仍迁移到默认空 pool；合法 v16/v17 保留并规范化 pool route、剥离旧 capability 与 `maxParallel` 后迁移；合法 v18 剥离 `maxParallel` 后迁移，合法 v19/v20/v21 原样保留现有 pool 与 Swarm 上限。旧配置中仍 enabled 但对应 Provider 模型没有 capability annotation 的 entry 会在 ConfigStore reload 修复阶段被禁用；disabled entry 原样保留供后续修复。v16–v18 pool entry ID 在 trim/NFC 后必须唯一且拒绝控制/格式字符；不符合各自冻结 schema、损坏或更早版本仍执行 reset-only。Runtime Identity v5 记录 `swarmsEnabled = false`，并从 Headless tool 名称/hash 排除 `swarm_run`。SQLite v5 增加 hidden Subagent execution/session ownership，并保留 v4 对历史 route/continuation identity 的原位迁移。SQLite v6 通过表重建把 `sessions.reasoning` 的 CHECK 扩展为六档（`off|low|medium|high|xhigh|max`）；SQLite v7 再重建 `messages`，加入 `conversation_transcript` 与带 `model_route_json` 的 Provider-native `compact_summary`。SQLite v8 重建 `subagent_executions` 为 schema v2，增加 `kind/name/parent_execution_id/child_ordinal`、queued/partial 状态及 root/child 唯一索引，并把旧记录迁为根级 `subagent`。表重建由 runner 暂停外键约束、换表并重建索引，提交前以 `PRAGMA foreign_key_check` 兜底完整性；旧版本应用打开更新数据库会以 `DATABASE_VERSION_TOO_NEW` 明确拒绝。旧 JSONL trace 只在读取时投影而不改写文件。

AppConfig v23 把 v22 的三字段 `logging` 冻结为 legacy boundary，并迁移为 `logging.operational + logging.trace`。旧 `enabled/retentionDays/maxTotalBytes` 完整进入 Trace；Operational 使用 `info/14 天/50 MB` 新默认。AppConfig v24 删除 `limits.maxConcurrentRuns` 和 `subagents.maxAgentsPerSwarm`。AppConfig v25 删除 `maxToolResultTokens/readFileOutputBytes`，增加 `maxToolOutputLines = 500` 和 `maxSubagents`；旧 byte limit 恰为 128 KiB 默认时升至 256 KiB，自定义值保留，v19–v23 的 `maxAgentsPerSwarm` 直接迁为新 Session 容量，v24 使用 32。AppConfig v26 删除 `limits.diffChars/fileChangeHistoryBytes`，并移除旧 `create_file` remembered rules；其他权限、Provider 和运行限制保持不变。Headless 外部 config v5 迁移 v1–v4，内部 AppConfig 使用 v26；Runtime Identity v6 移除 token result budget 并增加 bytes/lines/worker timeout/`maxSubagents`。SQLite v10 只增加 active leaf capacity 查询索引，标准 v11 删除 FileChange storage，v12 精确兼容历史 v11 alternative 并完成收敛；现有 conversation/execution records 不重写。

P3 review 建议、N-3/N-4 和 201+ 数据量的额外 Electron E2E 明确延后，不属于 P10 发布门禁；现有单元/集成测试继续覆盖 201+ Session 和 Message 分页。产品路径不再保留双轨、兼容开关或 legacy fallback。
