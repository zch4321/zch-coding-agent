# Renderer 交互决策

本文按主题保存历史决策。每条日期是决定发生时间，状态和后续替代条目共同解释适用范围；当前规则见[架构总览](../architecture.md)。返回[决策索引](../decision-log.md)。

## 2026-07-26 — 归档 Session 在设置中管理

- 状态：已采纳。
- 决定：侧栏删除操作继续表示归档；设置页提供分页的“已归档对话”列表，可恢复为 active。永久删除只允许 archived、idle 且没有 fork 子 Session 的记录，并通过 `session.removed` durable commit 清理 renderer replica。
- 删除边界：永久删除由 SQLite 级联清理该 Session 的 Message 与 Subagent execution，但不读取、修改或删除 workspace 文件。Trace capture 是独立诊断数据，仍由“日志”设置管理，不随 Session 删除。
- 理由：归档应是可逆的日常操作；永久删除则必须显式确认并保护分叉拓扑，避免 parent trigger 静默丢失子 Session 的来源信息。

## 2026-07-26 — 草稿状态继续采用 sendFirst

- 状态：接受当前交互，不增加空 Session 或终端专用建会话入口。
- 决定：首次用户消息发送成功前，renderer 只保存未发送草稿，不创建 Durable Session；终端面板继续提示先发送消息，并禁用新建终端。首次发送创建 Session 后，终端才可使用。
- 理由：终端、运行记录和副作用审计都需要明确的 Durable Session owner。为发送前终端单独创建空 Session 会重新引入无消息会话、草稿与 durable 状态同步、取消后的清理及侧栏展示语义；当前收益不足以承担这套生命周期。
- 已知代价：用户不能把终端探索作为一段对话的第一个动作，需要先发出一条用户消息。
- 重新评估条件：产品正式支持显式创建空 Session，或终端被提升为无需对话归属的 Project 级资源。

## 2026-07-26 — 操作反馈统一使用 NMessage

- 状态：已采纳。
- 决定：后台异步故障通过版本化 `app:notification` 进入 renderer；前端操作错误和运行错误统一显示为手动关闭的 `NMessage`，warning 可提前关闭并在 10 秒后消失。最多同时显示 5 条，其余排队；相同 code、Session 和 message 在活动期间去重。
- 边界：风险确认、隐私告知、字段校验和日志等持续状态仍保留在所属界面。通知 handle 只属于 UI，不进入 durable replica 或 ConversationTimeline；后台 Session 通知显示标题但不切换选择。
- 瞬时提示取舍：warning 继续在 10 秒后消失，不增加全局未读诊断中心或持久 warning banner；需要持续关注的状态（例如日志 capture degraded）必须由所属 Header/设置面板持续展示。error 仍要求用户手动关闭。这样可避免已被明确移出对话时间线的操作提示以另一种形式重新长期占据主界面。
- 重新评估条件：出现用户需要事后追溯但又不适合进入日志/所属状态面板的真实 warning 类别，届时优先设计独立通知历史，而不是把全局提示放回对话队列。

## 2026-08-06 — Renderer Approval 状态拆为独立 Store

- 状态：已采纳。
- 决定：Approval Pinia store 独立拥有审批表单、已保存快照、dirty/saving/status、配置 hydration 和 `config:set(approval)` 保存动作；Agent facade 组合该 store 与 Provider settings store。审批模型候选仍由 Provider 启用池派生，但 Provider settings store 不再持有审批状态或审批保存命令。
- 理由：审批 route 有独立持久化边界和生命周期。把它继续放在 Provider/limits/permission 聚合 store 中，会让 mutable Provider 草稿与 persisted approval snapshot 更容易被混用，也让 AppConfig section hydration 与错误归属不清。独立 store 使 UI 状态来源与后端 `approval` section 一一对应，同时不复制 Provider 目录。
- 集成顺序：AppConfig v16 的 model-pool 结构是 v17 approval reasoning 的前置版本，因此 reasoning/approval 分支 rebase 到 model-pool 分支，并实现明确的 v16→v17 迁移；反向 rebase 会让 v16 变更落在 v17 之后并迫使迁移版本重排。该顺序已在集成分支落实。

## 2026-08-16 — 对话头部用量区瘦身与首个 Run 后的模型起名

- 状态：已采纳并实现；本条包含对话头部布局调整与会话标题自动生成两个关联改动。
- 头部布局：删除重复的工作区名行（顶部栏与项目侧栏已展示）。上下文进度条样式不变，紧凑数字（k/M 格式，如 `128k/256k · 50%`）移到进度条同行；精确 Token 数与容量来源仅在 tooltip/aria 展示。缓存命中/未命中/输出合并为一行，并在 Provider 报告过可缓存输入时追加缓存命中率。
- 命中率口径：UI 命中率 = 缓存命中输入 ÷ (命中 + 未命中) 的整数百分比，与缓存明细同一累计范围（当前活动 Run overlay 总和）。它只是展示语义；trace、自动压缩与 open design question 3 的其余 token 口径不在本条决策范围内。
- 模型起名：第一个 Run 完成时，若 Session 标题仍是派生值，由 Main process 使用模型池第一个 enabled 且 `capability = light` 的 route，以首条用户消息与首个 assistant 回复的有界摘要生成短标题。无 light route、Provider 失败或输出清洗为空时静默保留派生标题，生成调用不进 canonical history、不计入对话 usage 投影。
- 标题来源：SQLite v9（0009_title_source）为 sessions 增加 `title_source`（`auto|user|model`）。新会话从 `auto` 开始；用户重命名与 Fork 置 `user`；模型写回置 `model`；升级前存量会话一律默认 `user`，永不参与自动起名。每个 Session 在进程内最多尝试一次；应用重启后标题仍为 `auto` 时，允许在下一个 Run 结束时补试（宽松语义，避免持久化尝试计数）。
- 理由：头部五行压缩为三行后信息密度更高，工作区名属于冗余；对话标题的可读性直接影响侧栏与后台通知可用性，而首条消息截断往往过长或不达意。标题生成限定 light route 与一次尝试，把额外 Provider 调用与费用约束在用户已显式配置的小模型上。

## 2026-08-19 — Renderer 设置导航按 Config Domain 组合

- 状态：已采纳并实现；本条取代此前把模型角色、Provider 与模型池放在同一“模型”页，以及把模型池放在 Agents 页的设置布局，不改变 AppConfig v22 或 IPC wire。
- 一级导航：application、assistant、integrations、models、network、providers、runtime、security 八个配置领域各对应一个一级菜单。Renderer 用唯一 registry 同时声明稳定 id、分组、翻译 key、组件和所属 `ConfigSection[]`，导航和页面分发不再分别手抄；测试锁定八领域与全部细粒度 section 无遗漏、无重复。
- 页面归属：Models 拥有主/辅助模型角色与模型池；Providers 只拥有连接、凭据、模型目录和模型标注，删除全局 Token 估算编辑；Runtime 组合 Agents、Limits 和命令/终端 Shell；Integrations 组合 Skills、MCP 与 Web Search；Network 首次暴露既有 HTTP proxy 配置；Application 当前展示日志与 Trace 诊断。项目和归档对话归“管理”，不伪装成 Config domain。
- 状态归属：原通用 `agent-settings` store 收缩为 Provider 状态；application、assistant、integrations、network、runtime、security 分别拥有自己的表单、dirty signature、保存状态和错误。初始化配置由 runtime coordinator 按 section fan-out，旧 UI facade 只做显式路由，不复制或合并领域状态；models 继续使用既有 roles/pool stores。
- 保存边界：一个领域菜单可以组合多个各自保存的区块，不建立整页大事务。Provider 保存为兼容既有 IPC 仍携带未修改的 Limits snapshot，但 Renderer 不再把 Token 估算纳入 Provider draft/signature；真正的编辑只在 Runtime/Limits 区块发生。跨领域读取候选与展示说明允许，修改由所属 store/action 完成。
- 隐藏边界：Prompt resource、privacy notice acceptance 和 workspace last-opened 等内部配置继续属于各自领域，但 registry 不按 schema 自动生成控件。领域对齐是所有权和导航约束，不是把每个持久化字段暴露给用户。
