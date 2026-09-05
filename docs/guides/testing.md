# 验证与回归定位

日常修改先格式化，再运行 `npm run check`；合并或发布前运行 `npm run verify`。完整命令和分支规则见[开发指南](./development.md)与[AGENTS.md](../../AGENTS.md)。下列清单保留跨领域的回归要求；每篇 [Code map](../code-map/README.md) 提供相关测试入口。

## 测试与不变量

必须覆盖：

- Project/Session/Message codec round-trip，canonical project path 去重，以及 Project path 重新关联不改写 Session `projectId`。
- `kind + parts` discriminated union round-trip；单条记录的非法组合（例如 assistant 携带 tool-result part）在 shared/repository boundary 被拒绝，跨记录的缺失/重复 call 在 MessageHistoryCompiler 被拒绝。
- MessageHistoryCompiler 只执行 active-history policy 并生成 `CompiledCanonicalHistory`，不生成 wire `role` 或 Provider DTO。
- 相同 active MessageRecords、route 和 Provider config 生成确定性的 Provider DTO；不同 Provider 的 golden tests 覆盖 Chat Completions messages、Responses items 和 Anthropic content blocks。
- Chat Completions 将 assistant tool-call parts 编译为 `tool_calls[]`、将每个 tool-result record 编译为 `role = 'tool'`；Responses 编译为 `function_call/function_call_output` items；Anthropic 把相邻 results 合并为 `user` message 中排在前面的 `tool_result` blocks。
- Tool Result 默认/自定义投影、projector fallback、JSON-safe normalization、UTF-8 head byte/line bound、paged/passthrough 豁免和错误文本均有 exact tests；Provider golden 断言 wire 不含内部 envelope 或 part 标签。
- `read_file` 覆盖大文件、行号分页、append/EOF 字符位置、tail、UTF-8、超长单行、调用中替换和 artifact expiry；`grep/glob/list_dir`、terminal/process/Git、fetch/search/skill、MCP 与 Subagent 的模型可见格式使用 exact golden。
- 新结果持久化 projection marker；active legacy result 在 Provider factory/stream 和 usage 前失败，inactive old epoch 不阻断新 history。
- Provider 可以将一条 canonical record 展开为多个 wire items，或把多条相邻 canonical records 合并为一条 wire message；不依赖一对一映射。
- `normalizedReasoningText` 只包含允许展示的非加密文本；缺失投影时 UI 不显示 reasoning，且不能从它重建 continuation。
- `ProviderContinuationEnvelope` 外层 schema 校验、`data` 原样 round-trip、数组顺序不变；签名、密文和 opaque item 不被 Core 改写。
- Provider type、route 或 format 不兼容时忽略 continuation 并重放 canonical history；损坏状态不得由 normalized reasoning 伪造。
- 删除或改变 metadata 不改变相同 route/adapter 下编译出的 Provider request；协议关键字段藏入 metadata 的 fixture 必须被拒绝。
- SQLite migration 顺序、checksum 不可变、单步 rollback、高版本拒绝、foreign key cascade 和 seq uniqueness。
- 移除 Project 会 cascade 删除其 Sessions/Messages/Subagent executions，但不删除 workspace 目录或任何项目文件。
- Application service 的 Session/Message 多表事务回滚时，Repository 不得留下独立 commit。
- Durable mutation 的 invoke result 与 push event 携带同一个 envelope；event-first、response-first 和重复 delivery 都只更新一次 renderer replica。
- Bootstrap 在订阅后读取 snapshot/cursor；握手期间发生 commit 不丢失，cursor gap、backend instance change 或 buffer overflow 会重同步而不是轮询。
- User send 和 `run:retry` 不重复插入原始 user message；Assistant target 被拒绝。
- Assistant text、`normalizedReasoningText` 和 `providerContinuation` 只有 completed 后才落盘。
- 每个持久化 assistant tool-call message 后都有完整 tool result messages。
- Tool batch transaction 失败时不留下协议半截。
- parallel Tool body 确实重叠，serial Tool 形成前后屏障；审批和 Tool Result 始终按原 call 顺序，失败/拒绝/取消仍为每个 call 生成终态结果。
- `subagent_run` 的 Unicode/保留键/控制字符/长度 schema，普通 `user_input` history、无父历史、冻结 route 继承、配置热变更和最终 assistant text 提取。
- child Provider catalog 与 executor 双重拒绝越权 write/process/terminal/network/MCP/code intelligence、递归 Agent Tool 和全部 background Tool；四个 Git read Tool 在非 Git workspace 返回普通错误。
- live workspace 覆盖 dirty/staged/untracked Git、child 启动后的文件变化、旧 snapshot 目录清理以及不创建新 Git refs。
- hidden Session 不进入公开 get/bootstrap/list/search/export 或 Renderer events；父/Project 删除级联、归档保留、启动 interrupted、并发/终态幂等 handle 与参数冲突均有持久化回归。
- 并发 start 的 Session leaf 容量预留必须原子；Swarm 容量不足不创建部分 root/child，设置调低不取消存量，终态释放名额。
- 父 Run 完成/取消/Provider failure 后后台 Agent 继续；30 分钟默认/自定义 timeout、显式 cancel、archive/delete/quit 会取消并收敛，usage 不回写已结束父 Run。
- `background_wait` 覆盖 any/all、混合 target、0/60 秒/5 分钟、Terminal 输出不唤醒、PTY exit 提前唤醒、固定 50 行 tail、关闭后 tail 和统一字节限制；list 覆盖 filter-bound cursor 与小 byte budget；cancel 覆盖 waitMs、Swarm root/child 和 Terminal。
- Session temp/PathGuard 覆盖双根绝对路径、`ZCH_SESSION_*_DIR:/...` alias、symlink/junction、scratch 免审批、Readonly、环境变量/cwd、24 小时清理、Session/Project 删除和 capture failure。
- Terminal 覆盖默认 1 秒增量/tail、完整日志、跨 chunk ANSI、spawn/artifact failure，并断言 Provider catalog 不含 `terminal_read/list/close`。
- Compact 只在完整 turn boundary 修改 `inHistory`，active history 可直接按 seq 重建。
- Rewind/edit 跨 compact 或 Provider-transition transcript epoch 重建保留前缀；重复 rewind 被拒绝；rewind 后 fork 只复制非 superseded 当前分支并重映射引用与 epoch boundary。
- Renderer revision gap 触发 Session snapshot。
- Draft、partial output 和 active Run 不进入 SQLite。
- Renderer reload 且 main 存活时可读取 ActiveRunPublicSnapshot。
- App crash/restart 后 partial output 丢失，但完整 messages 可以继续请求模型。
- `write_file` 覆盖/创建与 mode 保留、`apply_patch` latest-content 精确唯一匹配、`delete_file` 100 MB binary 与幂等删除，以及审批后文件变化的 last-writer-wins 语义。
- 标准 SQLite v11 删除 FileChange 表和 retention trigger，v12 兼容历史 v11 分叉并完成收敛；AppConfig v26 删除 Diff/history limits 与旧 `create_file` remembered rule；Headless result v2 不含 patch path/status。
- Git Review 覆盖非 Git、tracked/untracked、staged/unstaged、binary、rename、unborn/detached HEAD、Project 子目录 scope 与 merge-base，并验证输出有界且无 binary patch payload。

核心重启回归：

1. 用户发送 A。
2. Provider 产生 assistant tool call、tool results 和最终 assistant message。
3. 完整退出主进程。
4. 使用相同 `userData` 重启。
5. 发送 B。
6. 断言 `messages WHERE in_history = 1 ORDER BY seq` 能构造协议完整的 A/tool/final/B provider request。

## 已知验证缺口

完整 Desktop/Headless trajectory 对比仍是架构要求。当前可定位的 [Agent Runtime 测试](../../electron/runtime/agent-runtime.test.ts)验证无 Electron 对象的运行与取消，[Headless 测试](../../electron/headless/headless.test.ts)覆盖配置、CLI、工具、Plan 和输出，[Durable Backend 测试](../../electron/application/durable-backend-runtime.test.ts)覆盖提交与恢复；尚未找到把两宿主的 Provider messages、Prompt、Tool、compact、Plan 和 MCP 轨迹逐字段对比的独立测试。旧文档中的“完整 parity 已完成”不能作为当前覆盖证据。补齐方向见[路线图](../road-map.md)。
