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

- 状态：已由 2026-08-09 的分层验证门禁决策取代。
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

## 2026-08-03 — 思考力度六档与 per-model 标注，不做自动升降档

- 状态：已采纳。
- 决定：`ReasoningEffort` 从 `off|high|max` 扩展为 `off|low|medium|high|xhigh|max`；per-model 标注（支持的档位子集 `reasoningEfforts`、能力等级 `capability`）复用现有 `modelOverrides` map，不新建存储结构、不 bump AppConfig 版本（纯 optional 增量，v15 数据仍合法）。
- 语义：未标注的模型视为全档位支持（即原行为）；已标注模型在 Provider 默认档位与 Composer 档位选择中只呈现子集，配置保存与 route resolver 冻结时拒绝标注集外的档位。系统不做任何自动升/降档——用户永远知道实际请求的是哪一档；未标注模型在 API 层不支持时错误原样透传。approval 路由的 `off→high` 提升是系统内部安全关卡的唯一例外，不由用户选择档位。
- 理由：供应商目录只返回身份与 token 字段，无法得知各模型的思考档位，因此支持度由用户显式标注而非系统推断。`capability` 标注暂无运行时消费者，为未来 Model Pool 调度预留；pool 分支集成时 entry 的 reasoning schema 需切换到该六档枚举、capability 改由 Provider 元数据解析。
- 已知代价：携带标注的配置用旧版本应用打开会因 `additionalProperties: false` 校验失败（只影响 downgrade）；档位映射交给各 Provider API，adapter 不做就近取整。

## 2026-08-03 — 明确不支持 downgrade，破坏性重置前自动备份配置

- 状态：已采纳。
- 背景：六档枚举会被多处持久化——Provider 配置与 Headless 配置的 `reasoning`、Session 的 `modelSelection.reasoning`、已完成 assistant message 冻结的 ModelRoute v2。旧版本应用的同版本校验器不接受 `low/medium/xhigh`，遇到含新值的配置或 Session 记录会校验失败。
- 决定：项目正式声明不支持 downgrade（只向前升级）。不 bump AppConfig/Headless/Route 版本，因为版本号不承担向后兼容语义，且 model pool 分支已占用 AppConfig v16；从本版本起，`ConfigStore` 在因无法解析/迁移而破坏性重置配置前，先把原文件备份为 `<config>.unsupported-<UTC 时间戳>.bak`（备份失败不阻断重置）。
- 已知边界：旧版本应用（不含备份逻辑）遇到新配置仍会静默重置并丢失 Provider/limits 配置，或无法解码含新档位的 Session/message；备份只保护从本版本开始的重置路径。SQLite v6 迁移后，旧应用打开数据库会以 `DATABASE_VERSION_TOO_NEW` 明确失败而不是迟发 codec 错误。
- 重新评估条件：出现真实 downgrade 需求（如发布后回滚通道），届时再评估版本门闩或双读协议。

## 2026-08-05 — Auto approval 独立保存 reasoning，并共享静态路由校验

- 状态：已采纳；本条覆盖 2026-08-03 决策中 approval `off→high` 作为运行时例外的部分，其余六档与 per-model 标注语义不变。
- 决定：由于 model-pool 分支已经占用 v16，本变更使用 AppConfig v17，避免同一版本号对应两种不兼容结构。`approval` 同时持久化 `approverProviderId`、`approverModel` 和 `reasoning`。Permissions 中提供独立审批思考等级表单；运行时原样使用该值，不继承 Provider 默认等级，不做隐式升降档。v9–v15 迁移到默认空 pool 的 v17；v16→v17 组合迁移按 model-pool 分支的冻结结构保留并规范化完整 pool。两条路径都将旧版实际审批等级写成显式值：Provider 为 `off` 时写入 `high`，其余等级原样写入，因此升级不改变既有实际请求，但用户可以看到并修改它。
- 校验边界：`shared/model-route.ts` 只统一静态配置兼容性——Provider 存在、模型非空且已启用、所选 reasoning 被模型标注支持。Renderer、ConfigStore、Provider 删除 fallback 和 route resolver 共享该判断；凭据、Endpoint 安全性及实时 Provider 可用性仍由运行时检查，不引入新的路由框架或 capability abstraction。
- 理由：审批模型是独立路由，实际请求等级不应由另一个表单中的 Provider 默认值隐式决定。结构化共享结果消除多层各自实现 annotation/启用池规则造成的分歧，同时保持共享模块 process-neutral。
- 已知代价：增加一次 AppConfig 迁移与一个审批表单字段；旧版本应用无法读取 v17，沿用项目不支持 downgrade 的既有策略。

## 2026-08-06 — Renderer Approval 状态拆为独立 Store

- 状态：已采纳。
- 决定：Approval Pinia store 独立拥有审批表单、已保存快照、dirty/saving/status、配置 hydration 和 `config:set(approval)` 保存动作；Agent facade 组合该 store 与 Provider settings store。审批模型候选仍由 Provider 启用池派生，但 Provider settings store 不再持有审批状态或审批保存命令。
- 理由：审批 route 有独立持久化边界和生命周期。把它继续放在 Provider/limits/permission 聚合 store 中，会让 mutable Provider 草稿与 persisted approval snapshot 更容易被混用，也让 AppConfig section hydration 与错误归属不清。独立 store 使 UI 状态来源与后端 `approval` section 一一对应，同时不复制 Provider 目录。
- 集成顺序：AppConfig v16 的 model-pool 结构是 v17 approval reasoning 的前置版本，因此 reasoning/approval 分支 rebase 到 model-pool 分支，并实现明确的 v16→v17 迁移；反向 rebase 会让 v16 变更落在 v17 之后并迫使迁移版本重排。该顺序已在集成分支落实。

## 2026-08-06 — Model capability 只由 Provider metadata 持有

- 状态：能力权威边界已采纳；原定的 per-route 并发字段由后续“Swarm 数量归 Job 所有”决策覆盖。
- 决定：AppConfig v18 从 `modelPool.entries[]` 删除 `capability`。模型能力的唯一配置来源是 `providers[].modelOverrides[model].capability`；freezer 从单次 PublicConfig 快照生成携带派生能力的 backend-only candidate，allocator 和 plan snapshot 只消费派生值，不把它写回 pool 配置。
- 配置不变量：enabled entry 对应模型必须有能力标注；保存缺少标注的 entry 会整体失败，Provider 编辑或 reload 发现标注被移除时只禁用受影响 entry，disabled entry 仍可保留待修复引用。Provider revision 已覆盖 `modelOverrides`，因此原有 optimistic concurrency 和 freeze 后复核同时覆盖能力变更。
- 界面边界：Agents 设置页的模型池小节使用 `Provider → model → reasoning` 树形穿梭框选择精确 route；同一模型的不同 reasoning 可以同时入池，不做自动升降档。最低 reasoning 只过滤左侧候选，已选 route 不被隐藏或改写；右侧只读展示派生能力，不配置并发，通过独立 Pinia store 显式原子保存完整数组。Provider 配置仍是模型目录与能力标注的唯一 UI 所有者；模型池不复制这部分表单状态。
- 迁移：v16/v17 使用冻结 schema 读取，规范化 ID 并保留 entry 的其他字段后剥离旧 capability；没有 Provider 能力标注的 enabled legacy entry 在 reload 修复阶段禁用。冲突时不把旧 pool 值反向写入 Provider metadata，避免迁移重新制造第二个权威来源。
- 理由：同一 Provider/model 的能力是模型属性，不是某个 pool slot 的属性。移除重复字段可以消除 Provider 标注与 pool entry 漂移、简化未来 pool UI，并让 digest、分配和 revision 检查都基于同一份配置事实。

## 2026-08-06 — Swarm 数量归 Job 所有，模型池只描述可选 Route

- 状态：已采纳并在 Desktop S4 落实；Headless 明确不暴露 Swarm。
- 配置边界：AppConfig v19 删除 pool entry 中从未执行的 `maxParallel`，并在 `subagents` 增加 `maxAgentsPerSwarm`（默认 10、范围 1–32）。前者避免把执行期容量错误地绑定到模型 route，后者限制单次 Swarm 创建的 child Agent 总数；`limits.maxConcurrentRuns` 继续独立限制全应用同时 active 的 Run，主 Run 自身也占一个 slot。
- 容量边界：模型池不再采用 64 条 Route 的产品级限制，当前 schema 与 Renderer 共用 1,000 条防御性上限，只用于拒绝异常 IPC/config 负载。它不表达执行容量；真正的运行边界仍由单个 Swarm 的 Agent 总量和全局并发 Run 数控制。
- 工具契约：`swarm_run.tasks[]` 由主 Agent 显式提供自包含 `task`、`requiredCapability: light|standard|strong` 与 `agentCount`，不增加含义重叠的难度字段，也不由 Backend 猜测能力。Provider 可见 schema 在 `/swarm` Run 启动时根据冻结的 `maxAgentsPerSwarm` 生成，把该值写入 `agentCount.maximum`；设置变化从下一次 `/swarm` Run 生效。数组内 `agentCount` 求和仍由 Backend 在建 Job 前校验，因为 JSON Schema 不能表达跨元素求和；XML 提示不能替代 schema 和执行校验。
- Tool description 偏好：每个 task 默认 1 个 Agent；只有需要独立交叉验证、多视角调查或高风险复核时才增加数量，并选择足以完成任务的最低 capability，不能为了用满上限而扩张。
- 分配边界：所有 `actualCapability >= requiredCapability` 的模型都可参与；allocator 按稳定声明顺序先均匀轮询 `Provider + model`，再轮询该模型入池的精确 reasoning route。这样同一模型选择更多 reasoning 叶节点不会获得额外权重；模型数少于所需 Agent 数时自然重复使用。assignment 在 Job 创建时冻结，失败不自动换 Provider 重跑。
- 理由：任务需要多少独立 Agent 是一次 orchestration 的属性，模型池只回答“哪些精确 route 可以被选”。把数量放到 Tool/Job 并保留一个用户级硬上限，可以让主 Agent 按任务拆分，同时避免 per-route 配额、全局 Run 并发与 Job 总量三套相互重叠的配置。

## 2026-08-09 — 日常检查与合并门禁分层

- 状态：已采纳；取代 2026-07-26 “每次阶段完成只运行完整 verify” 的执行频率，完整门禁覆盖范围不缩减。
- 日常门禁：`npm run check` 并行运行 lint、format check、typecheck 和确定性 Vitest。并行任务互不取消，全部结束后按任务分组输出失败；这里追求一次收集完整的低成本诊断，而不是全局首错退出。
- 合并门禁：`npm run verify` 仅在合并、发布或显式要求完整验证时运行；它在 `check` 之上继续覆盖分进程 runtime smoke、Desktop/Headless build、Windows package、packaged SQLite 和 Electron E2E。E2E 不从产品门禁移除，只从每次普通开发修改的必跑路径移出。
- CI 编排：普通分支 push 只执行快速检查；PR、`master` push 和手动触发将 runtime、E2E、package smoke 分配到独立 Windows runner，并禁用 matrix fail-fast，使互不依赖的失败能在同一次 workflow 中全部呈现。E2E runner 自行构建应用，package runner 自行构建与打包，以少量重复构建换取隔离和更短墙钟时间。
- 稳定性边界：Playwright 继续单 worker；本地完整门禁也不让 E2E 与 electron-builder 在同一 checkout 并发，避免共享构建目录、native rebuild 和 Windows 文件锁造成非确定性失败。不使用 PR 的直接合并必须在本地先运行 `npm run verify`，远端 `master` 门禁只提供合并后保护。

## 2026-08-09 — `run_command.shell` 由用户配置且显式启动

- 状态：已采纳第一阶段；交互 Terminal profile 与可见 PTY 复用继续留在 M5。
- 选择权：模型不选择 Shell，也不能在 Tool 参数中提交 Shell ID。AppConfig v20 保存 `executionEnvironment.commandShell`；Prompt Harness 只告诉模型本轮实际解析出的 `command_shell`，要求使用对应语法。
- 发现与回退：Main process 有界发现 PowerShell 7、Windows PowerShell、CMD、Git Bash 和 Nushell；Windows `auto` 固定为 PowerShell 7 → Windows PowerShell → CMD。显式选择失效时临时回退到 `auto`、设置页显示警告，但不改写用户保存值。Git Bash/Nushell 不进入自动优先级，WSL 与自定义 profile 暂缓。
- 执行边界：`run_command.process` 与 `run_command.shell` 都使用 `spawn(..., { shell: false })`；后者由可信 adapter 传入解释器 executable、固定启动参数和原始命令。内部 Git、Subagent 与当前 PTY 不读取该配置，`run_command` 输出也不实时展示到 Terminal。
- 编码边界：内置 adapter 请求 UTF-8；捕获层流式验证 stdout/stderr，遇到无效 UTF-8 时按启动时探测的 Windows 代码页解码。第三方程序仍可能忽略控制台编码约定，因此这是确定性解码回退，不是对任意程序输出格式的绝对保证。
- 理由：让模型从候选列表选择会把宿主安装状态变成不稳定的模型决策，也会扩大命令审查和 quoting 状态空间。用户选择、Main 解析、Prompt 只报告事实，可让审批看到原始命令，同时消除 Node 在 Windows 上隐式落到 CMD 和 OEM code page 的行为。

## 2026-08-09 — Desktop Swarm 使用 Run-scoped capability 与全局 FIFO slot

- 状态：已采纳并实现 S4 基础链路；取消 UI、压力 hardening 与 Headless Swarm 延后。
- Capability 边界：只有 `/swarm <goal>` 启动的 Desktop 主 Run 能看到并执行 `swarm_run`。catalog 与 executor 双重检查冻结 capability；普通 Run、child Agent、历史重放和 Headless 都不能继承或伪造。Runtime Identity v5 用 `swarmsEnabled` 明确宿主差异，Headless tool 名称/hash 同时排除 `swarm_run`。
- 持久化边界：一次 Job 在同一 SQLite transaction 创建一个 Swarm root 和全部 queued child；root call 与 child ordinal 分别唯一。公共执行列表只返回 root，详情附带 children；hidden canonical Session 继续不进入普通 Session API。配置、assignment 或上限校验必须在任何 child Provider 请求前完成。
- 并发边界：普通 Run 与 `subagent_run` 保持 fail-fast；只有 prepared Swarm child 在全局 Run coordinator 上 FIFO 等待空闲 slot，取得 slot 后才创建 hidden Session 并启动 worker timeout。父 Run 占一个 slot。同一父 Run 的多个 Swarm Job 严格串行，不同父 Run 可以并发；取消与应用退出同时覆盖 queued/active child。
- 结果边界：replica 逐项、按声明顺序进入扁平 `results[]`，父 Agent 自行聚合。部分失败保留兄弟成功结果，不自动重试或换 Provider；全部失败返回 Tool error。2 MB 上限通过公平截断成功文本收敛，不能删除结果项，也不能暴露 reasoning、凭据、child Session 或完整工具轨迹。
- 界面边界：Agents artifact 使用手动两级 `NCollapse` 展示 Job → Agent，活跃徽标只计 leaf Agent。详情仅展示统计与可见 Assistant 消息，不自动展开、不复制主时间线，也不提供 child 会话导航。

## 2026-08-12 — Swarm 改为普通 Tool，并在所有权限模式逐次人工审批

- 状态：已采纳；本条取代 2026-08-09 决策中的 Run-scoped capability 边界，持久化、并发、结果与 Agents artifact 边界保持不变。
- Tool 可见性：满足 Desktop host、Subagent 开关、至少两个全局 Run slot 和 enabled 模型池 route 的普通主 Run 都能看到 `swarm_run`。`/swarm <goal>` 仅作为显式请求与目标编排快捷命令，不再授予特殊 capability；child、历史重放和 Headless 继续被 catalog/executor 双重拒绝。
- 使用约束：Tool description 明确要求只有用户已提出 Swarm、多 Agent、并行调查或独立交叉检查时才能调用，不能仅因任务复杂自行启动。工具保持只读 effects，但 `defaultRisk = review`；当前策略引擎因此在 readonly、auto、confirm 与 YOLO 中都请求人工审批，不经过自动审批模型，也不支持记忆批准。
- 审批界面：一次审批绑定完整 `swarm_run` 参数并覆盖整个 Job，不逐 child 弹卡。专用卡显示任务与 Agent 总数、每项名称/正文/能力/副本数，并提示额外 Provider 请求和费用；参数异常时回退到安全原始 JSON，不能因 Renderer 投影失败而隐去审批信息。
- 理由：普通 Tool 比一次性 slash capability 更符合模型原生工具编排，也允许用户用自然语言明确要求 Swarm；强提示减少误调用，逐次人工审批则在模型仍误判时保留成本与调度控制。YOLO 继续审批是刻意接受的简单语义，避免为单个工具扩展额外权限策略枚举。

## 2026-08-12 — Swarm assignment 拆分公共上下文与 Child task

- 状态：已采纳；本条更新 S4 Tool 输入与 Child prompt 注入方式。
- 输入边界：`swarm_run` 使用必填 `sharedContext + tasks[]`。公共字段承载全部 Child 共用的背景、证据、约束、验证结果和输出要求，每个 task 只声明 Child-specific 职责；两部分合起来自包含。专用审批卡必须同时展示公共上下文和全部任务。
- 验证边界：Child 工具 profile 不含命令、终端、构建或测试能力。父 Agent 可行时先运行相关验证，在下一轮把命令、退出码和精简关键输出写入 `sharedContext`；无法执行时明确说明，不能在同一 Tool batch 中假定尚未返回的测试结果。
- 副本策略：适合交叉验证时鼓励使用接近本次 Job 上限的 Agent 数，并允许同一 task 多副本。allocator 只保证优先轮换满足能力要求的不同 `Provider + model`，合格模型不足时允许复用，提示词不得承诺绝对异构。
- 历史边界：每个 hidden Child Session 分别持久化 XML-text 转义后的 `<swarm_shared_context>` prompt layer 与 `<swarm_task>` user input。基础 harness 明确 tag 语义；Renderer 解包 task，公共上下文不进入普通用户消息投影。
