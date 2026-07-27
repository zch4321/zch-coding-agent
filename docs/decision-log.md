# 决策日志

本文件记录有意接受、暂缓或取舍的技术决策。Code review 记录发现本身；本日志记录项目对发现采取的处理方式，避免后续将已知限制误认为遗漏。

## 2026-07-25 — FC-1：FileChange revert 的 workspace TOCTOU

- 状态：P8 切流时已重新评估；接受风险，不修复。
- 决定：本轮不引入基于目录句柄的 no-follow 原子文件操作。
- 背景：`FileChange` 回滚会在完成路径与内容校验后，以字符串路径调用最终的 `rename` 或 `unlink`。外部本地进程若在极窄窗口内替换文件或中间目录，可能覆盖竞争方的新内容；若以符号链接或等效机制替换中间目录，理论上还可能越过 workspace 边界。详见 [FC-1 code review](backend-refactor-p0-p5-code-review.md#fc-1-revert-的最终-renameunlink-在最后一次校验之后使用词法路径toctou-可越过-workspace-边界p1-1)。
- 理由：完整修复需要跨平台目录句柄绑定和 no-follow 原子操作，实施复杂度高；当前产品假定本地 workspace 和同机进程可信，接受极窄外部竞争窗口。Durable Backend 切流不改变这一取舍。
- 当前语义：回滚仍会执行 workspace 路径、普通文件和内容 hash 校验；但在存在外部文件系统竞争时，workspace 边界仅是 best-effort，不是强安全隔离保证。
- 重新评估条件：支持不可信插件/同机竞争方、更高权限运行环境，产品承诺升级为强文件系统隔离，或具备可用的跨平台句柄式文件操作实现。

## 2026-07-25 — APP-6：极端并发下 run:start 请求缓存逐出

- 状态：接受，不修复。
- 决定：继续使用当前有界请求缓存，不为 in-flight 与 settled 项拆分缓存或增加 ownerToken 引用计数。
- 背景：需要超过 1,000 个并发在途 new-session 请求挤掉仍在执行的同 key 条目，再以相同 key 重入，才可能共享 ownerToken 并让失败方影响成功方 context。
- 理由：Desktop/Headless 的全局并发上限为 32，正常产品入口无法达到该前提，现实可达性近乎为零；为不可达路径增加复杂生命周期机制收益不足。
- 重新评估条件：提高或绕过全局并发上限、开放多客户端共享 backend，或把请求缓存复用于高并发服务端部署。

## 2026-07-25 — REQ-1：请求幂等指纹暂不包含完整提交语义

- 状态：搁置。
- 决定：`run:start` 的 requestHash 暂时仍以消息正文为主，不在本次切流中纳入附件、候选 Session model/mode/Goal/Plan 等完整语义。
- 已知代价：调用方错误复用同一 `clientRequestId` 且正文相同、其他输入不同时，backend 可能把请求视为重复。正式 renderer 每次提交生成新 ID，因此正常 UI 不会触发。
- 重新评估条件：提供离线队列、跨进程 command replay、公开自动化 API，或需要对网络级重放作强幂等保证。

## 2026-07-25 — FC-3：FileChange beforeHash 不交叉校验

- 状态：接受，不修复。
- 决定：Revert 继续信任同一 SQLite record 中的 `beforeContent`，不在读取时重新计算并强制匹配 `beforeHash`。
- 理由：记录由单一 backend transaction 写入，正常路径不存在两者分叉；触发需要数据库损坏或外部篡改。异常仍进入现有 codec/SQLite/revert 诊断日志，暂不增加 hash 交叉校验与恢复拒绝分支。
- 重新评估条件：支持外部导入 FileChange、数据库修复工具、跨设备同步，或出现真实损坏案例。

## 2026-07-26 — FileChange Assistant Message ID 保持软关联

- 状态：接受，不增加外键或额外索引。
- 决定：`file_changes.assistant_message_id` 继续作为工具批次的关联标识，不要求对应 `messages` 行已经或最终成功提交。
- 理由：文件副作用完成后，FileChange 审计会先于整个 Assistant/tool batch 的 Session commit 独立写入。若后续 Session commit 失败，审计仍必须保留；外键会使审计写入失败或迫使运行时错误地提前提交 Assistant 消息。现有 `UNIQUE (session_id, assistant_message_id, call_id, path)` 已提供以 Session 和 Assistant Message ID 为前缀的复合索引。
- 重新评估条件：FileChange 与 Session message 改为同一事务提交，或产品要求按 Assistant Message ID 跨 Session 独立查询。

## 2026-07-26 — PersistenceReader 采用明确的 no-write 契约

- 状态：接受约束，不增加 query authorizer。
- 决定：`DatabaseService.read()` 回调和 `PersistenceReader` 只允许执行查询；所有 durable 写入必须进入 `withTransaction()` 并使用 `PersistenceTransaction`。代码注释明确说明 SQLite 本身不会强制该限制，不把 facade 描述成技术上只读。
- 理由：当前所有 reader 调用点均为受控 repository 查询，额外为每次 query 切换 SQLite authorizer 会增加全局连接状态和嵌套调用复杂度。项目更看重清晰的 repository 契约和 review 门禁，而不是对内部受信代码做运行时 SQL 分类。
- 已知代价：未来代码若违反契约，可通过 `reader.prepare()` 执行写 SQL，从而绕过事务队列、cursor 和 commit 发布。这属于代码审查可发现的内部误用，不是面向不可信输入的安全边界。
- 重新评估条件：开放第三方 repository/plugin、出现实际误写，或 SQLite 连接拆分为独立 read/write handles。

## 2026-07-26 — 归档 Session 在设置中管理

- 状态：已采纳。
- 决定：侧栏删除操作继续表示归档；设置页提供分页的“已归档对话”列表，可恢复为 active。永久删除只允许 archived、idle 且没有 fork 子 Session 的记录，并通过 `session.removed` durable commit 清理 renderer replica。
- 删除边界：永久删除由 SQLite 级联清理该 Session 的 Message 与 FileChange 审计，但不读取、修改或删除 workspace 文件。Trace capture 是独立诊断数据，仍由“日志”设置管理，不随 Session 删除。
- 理由：归档应是可逆的日常操作；永久删除则必须显式确认并保护分叉拓扑，避免 parent trigger 静默丢失子 Session 的来源信息。

## 2026-07-26 — 草稿状态继续采用 sendFirst

- 状态：接受当前交互，不增加空 Session 或终端专用建会话入口。
- 决定：首次用户消息发送成功前，renderer 只保存未发送草稿，不创建 Durable Session；终端面板继续提示先发送消息，并禁用新建终端。首次发送创建 Session 后，终端才可使用。
- 理由：终端、运行记录和副作用审计都需要明确的 Durable Session owner。为发送前终端单独创建空 Session 会重新引入无消息会话、草稿与 durable 状态同步、取消后的清理及侧栏展示语义；当前收益不足以承担这套生命周期。
- 已知代价：用户不能把终端探索作为一段对话的第一个动作，需要先发出一条用户消息。
- 重新评估条件：产品正式支持显式创建空 Session，或终端被提升为无需对话归属的 Project 级资源。

## 2026-07-26 — M-6：未发布 AppConfig v8→v9 不做保字段迁移

- 状态：P10 再次确认接受；不为 v8、v9 开发期中间形态增加保字段迁移。
- 决定：首个正式 v9 版本发布前，AppConfig 仍是可重建的开发期配置 epoch。同一 `schemaVersion` 内新增必填字段或调整结构后，旧文件若不再通过完整 schema 校验，ConfigStore 删除该文件并写入当前默认配置；v8、未知版本以及无法解析的损坏 JSON 同样沿用当前 reset-only 路径，不备份、不迁移、不清理孤儿 secret。
- 背景：目前没有产品用户，也没有已发布配置需要兼容。为分支内 v8→v9 或多个 v9 中间结构维护一次性迁移，只会形成没有用户价值的临时兼容代码。
- 已知代价：分支开发机可能丢失 providers、MCP servers、permission rules 等本地配置；重置前不创建备份，旧 secret 引用也不会在该路径自动清理。开发者应把这些文件视为可丢弃状态。
- 重新评估条件：首个包含 v9 的正式版本实际发布。此后新增不兼容字段必须升版本并重新决策保字段迁移、未知更高版本、备份与 secret orphan 策略，不能默认继承本条开发期取舍。

## 2026-07-25 — M-1：FileChange 预写失败时禁止文件副作用

- 状态：已采纳 fail-closed 行为。
- 决定：文件变更工具必须先完成 `prepareMutation`；包括 SQLite 错误在内的任何准备失败都会跳过文件写入并让当前 Run 失败，前端向用户显示错误并允许重试请求。
- 理由：如果审计记录尚未可靠准备就继续修改文件，会产生无法证明、无法安全回退的副作用。相较于把数据库短暂故障降级为 warning，请求失败更符合 Durable Backend 对变更可追溯性的承诺。
- 边界：文件写入已经成功后，`commitMutation` 失败仍保留现有 warning 语义，因为此时再把 Run 标为失败并不能撤销已发生的文件副作用；工具结果必须明确 `mutationSucceeded: true` 和回退不可用。

## 2026-07-25 — 日志热切换采用分段 capture，不补录历史

- 状态：已采纳。
- 决定：一次日志启用或 Durable Session 恢复对应一个独立 capture；`traceId` 不再等同于 `sessionId`，旧文件不追加。已有对话开启日志后只记录后续操作，不把 SQLite 中的既有消息、工具或 reasoning 回填到 trace。
- Run 边界：active Run 中开启时，当前 Run 完全不记录；active Run 中关闭时，当前 Run 记录到终态。一次 Run 中多次切换以最后一次成功保存的配置为准。
- 理由：半截 Run 或事后合成历史会让 trace 看似完整但缺少真实 Provider/stream/tool 时序，降低离线诊断可信度。分段 capture 能明确记录采集生命周期，并允许现有 Session 无需重载即可启停。
- 失败语义：capture 创建或写入失败只把状态降级为 `degraded` 并切换 Null logger，不影响模型和工具；下一 Run 开始时重试新片段。UI 持续展示 warning，直到成功创建新片段或关闭日志。

## 2026-07-26 — Carryover 启动失败直接丢弃

- 状态：已采纳。
- 决定：上一 Run 终态边界产生的 carryover 按 FIFO 自动启动；若某项 `run:start` 返回失败或 IPC 抛错，renderer 立即移除该队列项和 overlay chip，以 10 秒 warning 告知用户，不提供重试入口，并继续处理下一项。
- 理由：carryover 只覆盖 final-answer 边界的极窄输入窗口。为这个低概率路径维护持久重试队列、人工恢复 UI 和额外幂等状态，复杂度高于消息价值；失败后保持队列反而会永久阻塞该 Session 的普通发送。
- 边界：成功提交到 backend 后即视为已消费；若仅 renderer reconcile 失败，则保留 active Run、触发 Session reload，并以 error 提示，不会重复提交同一 carryover。

## 2026-07-26 — 操作反馈统一使用 NMessage

- 状态：已采纳。
- 决定：后台异步故障通过版本化 `app:notification` 进入 renderer；前端操作错误和运行错误统一显示为手动关闭的 `NMessage`，warning 可提前关闭并在 10 秒后消失。最多同时显示 5 条，其余排队；相同 code、Session 和 message 在活动期间去重。
- 边界：风险确认、隐私告知、字段校验和日志等持续状态仍保留在所属界面。通知 handle 只属于 UI，不进入 durable replica 或 ConversationTimeline；后台 Session 通知显示标题但不切换选择。
- 瞬时提示取舍：warning 继续在 10 秒后消失，不增加全局未读诊断中心或持久 warning banner；需要持续关注的状态（例如日志 capture degraded）必须由所属 Header/设置面板持续展示。error 仍要求用户手动关闭。这样可避免已被明确移出对话时间线的操作提示以另一种形式重新长期占据主界面。
- 重新评估条件：出现用户需要事后追溯但又不适合进入日志/所属状态面板的真实 warning 类别，届时优先设计独立通知历史，而不是把全局提示放回对话队列。

## 2026-07-26 — 发布验证使用单一 verify 入口

- 状态：已采纳。
- 决定：常规完整门禁只运行 `npm run verify`。`native`、`ripgrep` 和 development SQLite 由 `test:runtime` 分进程串行调度；packaged SQLite 在 Windows package 生成后只测试打包 Electron；E2E 复用该构建产物。
- 高成本边界：默认不运行独立 benchmark-cases、任何 benchmark preset、Docker worker/image、外部 benchmark 或真实 Provider 测试。确定性的 benchmark manifest/checksum/路径安全用例已经属于 `npm test`；其他工作负载只有用户明确要求时才执行。

## 2026-07-26 — 201+ 分页不增加 Electron E2E 数据灌入

- 状态：接受现有覆盖，不新增高数据量 Electron E2E。
- 决定：Session、Message 和 FileChange 的 201+ 边界继续由 repository/application 与 renderer store 的确定性测试覆盖，包括稳定 cursor、加载更早、prepend/upsert 和跨首屏选中恢复；Electron E2E 只保留代表性的分页交互，不在每次 `verify` 中创建数百条完整 Durable Session 数据。
- 理由：分页边界和排序逻辑在无时序噪声的下层测试中可穷尽断言；Electron 层的大批量数据准备显著拉长串行门禁，但新增的行为覆盖很少。当前 E2E 仍验证真实 IPC、SQLite、renderer 与控件接线。
- 重新评估条件：分页 IPC 与 repository/store 之间出现真实接线回归、引入虚拟列表或分页协议变化，或 CI 能提供低成本预置数据库 fixture。

## 2026-07-27 — 内置评估系统归档并从产品移除

- 状态：已采纳。
- 决定：在 `archive/integrated-benchmark` 分支保留完整快照，从主产品删除 case/runner/grader/metrics、Docker worker、Provider proxy、专用构建与命令、Headless benchmark protocol 和对应依赖。通用 Headless CLI/API、runtime identity、trace、usage/tool 统计与 Electron parity 保留。
- 理由：评估系统与产品 runtime、消息契约、构建、测试和文档高度耦合，导致本体复杂度与改造成本持续上升。评估工程不应再定义产品内部协议或引入专用 canonical message kind。
- 后续边界：如重启自动评估，在独立仓库中实现，只通过稳定 Headless 入口黑盒调用 Zch Coding Agent；产品仓库不再承载评估数据集、grader 或 worker 部署系统。
