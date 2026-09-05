# 模型与 Provider 决策

本文按主题保存历史决策。每条日期是决定发生时间，状态和后续替代条目共同解释适用范围；当前规则见[架构总览](../architecture.md)。返回[决策索引](../decision-log.md)。

## 2026-08-03 — 思考力度六档与 per-model 标注，不做自动升降档

- 状态：已采纳。
- 决定：`ReasoningEffort` 从 `off|high|max` 扩展为 `off|low|medium|high|xhigh|max`；per-model 标注（支持的档位子集 `reasoningEfforts`、能力等级 `capability`）复用现有 `modelOverrides` map，不新建存储结构、不 bump AppConfig 版本（纯 optional 增量，v15 数据仍合法）。
- 语义：未标注的模型视为全档位支持（即原行为）；已标注模型在 Provider 默认档位与 Composer 档位选择中只呈现子集，配置保存与 route resolver 冻结时拒绝标注集外的档位。系统不做任何自动升/降档——用户永远知道实际请求的是哪一档；未标注模型在 API 层不支持时错误原样透传。approval 路由的 `off→high` 提升是系统内部安全关卡的唯一例外，不由用户选择档位。
- 理由：供应商目录只返回身份与 token 字段，无法得知各模型的思考档位，因此支持度由用户显式标注而非系统推断。`capability` 标注暂无运行时消费者，为未来 Model Pool 调度预留；pool 分支集成时 entry 的 reasoning schema 需切换到该六档枚举、capability 改由 Provider 元数据解析。
- 已知代价：携带标注的配置用旧版本应用打开会因 `additionalProperties: false` 校验失败（只影响 downgrade）；档位映射交给各 Provider API，adapter 不做就近取整。

## 2026-08-05 — Auto approval 独立保存 reasoning，并共享静态路由校验

- 状态：已采纳；本条覆盖 2026-08-03 决策中 approval `off→high` 作为运行时例外的部分，其余六档与 per-model 标注语义不变。
- 决定：由于 model-pool 分支已经占用 v16，本变更使用 AppConfig v17，避免同一版本号对应两种不兼容结构。`approval` 同时持久化 `approverProviderId`、`approverModel` 和 `reasoning`。Permissions 中提供独立审批思考等级表单；运行时原样使用该值，不继承 Provider 默认等级，不做隐式升降档。v9–v15 迁移到默认空 pool 的 v17；v16→v17 组合迁移按 model-pool 分支的冻结结构保留并规范化完整 pool。两条路径都将旧版实际审批等级写成显式值：Provider 为 `off` 时写入 `high`，其余等级原样写入，因此升级不改变既有实际请求，但用户可以看到并修改它。
- 校验边界：`shared/model-route.ts` 只统一静态配置兼容性——Provider 存在、模型非空且已启用、所选 reasoning 被模型标注支持。Renderer、ConfigStore、Provider 删除 fallback 和 route resolver 共享该判断；凭据、Endpoint 安全性及实时 Provider 可用性仍由运行时检查，不引入新的路由框架或 capability abstraction。
- 理由：审批模型是独立路由，实际请求等级不应由另一个表单中的 Provider 默认值隐式决定。结构化共享结果消除多层各自实现 annotation/启用池规则造成的分歧，同时保持共享模块 process-neutral。
- 已知代价：增加一次 AppConfig 迁移与一个审批表单字段；旧版本应用无法读取 v17，沿用项目不支持 downgrade 的既有策略。

## 2026-08-16 — 模型角色统合：主/辅助模型与 Auto 审批回退

- 状态：已采纳并实现；本条统一模型相关配置到单个 `models` 段，并把 Auto 审批与对话起名的模型来源收敛为“辅助模型 ?? 当前模型”。
- 配置结构：AppConfig v21 新增 `models` 段（`defaultModelProvider/defaultModel`、`auxiliaryModelProvider/auxiliaryModel`、`providers`、`modelPool`）；删除顶层 `activeProviderId` 与 `approval` 段。迁移把旧 `approval.{approverProviderId, approverModel}` 映射为辅助模型并丢弃独立审批档位；加载修复会把不可用的辅助模型改写为当前默认模型。Provider id 保持不可变的机器键（新建改为 `provider-<uuid>`），不再展示于 UI。
- 审批语义：Auto 模式的审批 route = 辅助模型 ?? 该 Run 的主模型 route；辅助模型未配置或不可用时不再回退纯人工，而是由当前模型审批。审批与起名的 reasoning 沿用所选 Provider 的默认档位，不提供独立档位。
- 起名语义：`ConversationTitlingService` 的 route 来源从“模型池精确 light route”改为辅助模型 ?? 该 Run 的主模型；模型池与能力标注回归为只服务 Swarm。Desktop 提供 `ZCH_DISABLE_CONVERSATION_TITLING` 环境开关（e2e 默认禁用），Headless 恒不启用。
- 设置页：`模型服务` 页更名 `模型`，第一节“默认模型”提供主/辅助两个下拉并自动保存；原内容下移为“供应商配置”。权限页删除审批卡片，模式选择下固定一行审批来源说明，整页改为自动保存。
- 理由：两个后台能力（审批、起名）与 Swarm 的池化调度是不同语义——前者要一个可预测的单一模型，后者要能力轮换。显式的主/辅助角色比“activeProvider + 独立审批路由 + 池内 light 标注”更可解释；破坏性升级由 v21 迁移一次性收敛，不留双轨。

## 2026-08-17 — Reasoning 归精确模型角色所有

- 状态：已采纳并实现；本条覆盖 2026-08-03 决策中“Provider 默认档位”的配置边界，以及 2026-08-16 决策中“主/辅助模型继承 Provider 默认 reasoning”的部分；其他模型标注、模型角色、审批和起名回退语义不变。
- 配置边界：AppConfig v22 为主模型增加 `defaultModelReasoning`，为辅助模型增加 `auxiliaryModelReasoning`，并从 App/Public Provider 配置与 Provider 更新 IPC 删除 `reasoning`。Provider 只保存连接、凭据引用、目录、默认模型和 per-model 能力标注；不再存在会被不同消费者隐式继承的默认思考档位。
- 路由边界：主模型和辅助模型都是精确 `Provider + model + reasoning` route，可以使用同一模型的不同档位。新对话读取主角色完整 route；自动审批和对话起名读取辅助角色完整 route，未配置或解析失败时回退完成 Run 的完整主 route。Session、模型池和冻结 route 继续各自显式保存 reasoning，不做自动升降档。
- 设置边界：模型页的主/辅助模型各显示模型与思考深度。思考选项取对应模型的 `reasoningEfforts` 标注；切换模型造成暂时不兼容时只保留本地组合并提示用户选择，不写入半条 route。Provider 页删除默认思考深度字段；修改模型标注若破坏已保存辅助 route，仍暂停 Provider 自动保存。
- 迁移：v21→v22 分别读取主/辅助角色所引用 Provider 的旧 reasoning，写入两个角色后删除所有 Provider reasoning，从而保持升级前实际调用等级。v9–v20 直接迁移得到相同结果；已经在 v21 丢弃的旧 approval 独立 reasoning 不尝试恢复。Headless 外部 v4 的可选 reasoning 保持不变，只在构造内部 v22 配置时映射到主角色。
- 理由：reasoning 是一次模型 route 的属性，不是 Provider 连接属性。把它放在 Provider 上会让主对话、审批和起名共享隐含默认值，任一 Provider 编辑都会跨职责改变调用成本与行为；精确角色使 UI、持久化和冻结路由使用同一份显式事实。

## 2026-08-26 — Anthropic Tool Schema 顶层组合关键字兼容投影

- 状态：已采纳并实现；修复 Anthropic Messages 对 Tool `input_schema` 顶层 `oneOf/allOf/anyOf` 的拒绝，同时不削弱本地工具参数校验。
- 投影边界：`GenericAnthropicProvider` 只修改 Provider wire request 的深拷贝。根 schema 必须声明 `type: object`，且组合分支引用的同级字段必须已出现在根 `properties`；满足条件时删除顶层组合关键字，字段定义、required、additionalProperties 与嵌套组合约束原样保留。
- 失败边界：分支引入根目录未声明字段、使用无法安全展开的 `$ref` 或包含非 object 分支时，在网络请求前抛出包含工具名的确定性本地错误，不静默合并、不删除工具，也不发送已知会被上游拒绝的请求。
- 校验边界：ToolRegistry 继续保存并执行完整 Provider-neutral Schema，因此 wire 投影放宽的条件约束仍会在审批和执行前按原契约校验；Chat Completions 与 Responses 的 schema 编译不受影响。

## 2026-08-27 — Anthropic Messages 启用默认五分钟自动 Prompt Cache

- 状态：已采纳并实现；普通对话、后台模型调用和 native/synthetic compact 的 Anthropic Messages request 统一发送顶层 `cache_control: { type: 'ephemeral' }`。
- TTL 与成本：使用默认 5 分钟 TTL，不发送 `ttl: '1h'`。一小时缓存写入价格高于默认缓存写入，不能在没有用户成本选择的情况下自动升级；命中会刷新默认缓存有效期。
- 断点语义：采用 Anthropic 自动缓存，让断点随对话推进到最后一个可缓存 block，不在 canonical history 或 Tool Schema 中写入 Provider-only marker。Provider-neutral history、route identity 和其他 Provider request 均不改变。
- 观测语义：首次写入的 `cache_creation_input_tokens` 继续计入 miss，只有 `cache_read_input_tokens` 计入 hit；短于模型门槛、前缀变化、TTL 过期、实际模型/网关路由变化或网关不支持时允许保持零命中，不由 Application 补值。

## 2026-09-03 — 对话起名只约束标题长度，不另设生成预算

- 状态：已采纳并实现；修正 2026-08-16 对话起名方案中的独立生成边界，route 选择、标题来源和一次尝试语义不变。
- 请求边界：删除起名服务私有的 15 秒 timeout、128 output-token 上限和首条消息/回复各 2,000 字符截断。Provider 编译沿用所选模型 route 的正常输出预算，生命周期取消继续由应用退出时的 AbortSignal 负责。
- 标题边界：模型完成后仍只取首个非空文本行并清理引号、标签和句末标点，最终与手工标题共用 128 字符上限。限制落在持久化标题而不是模型生成 token 上，避免 reasoning 模型在形成最终文本前耗尽标题专用预算。
