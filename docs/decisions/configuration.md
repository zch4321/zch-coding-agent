# 配置与跨进程契约决策

本文按主题保存历史决策。每条日期是决定发生时间，状态和后续替代条目共同解释适用范围；当前规则见[架构总览](../architecture.md)。返回[决策索引](../decision-log.md)。

## 2026-07-26 — M-6：未发布 AppConfig v8→v9 不做保字段迁移

- 状态：P10 再次确认接受；不为 v8、v9 开发期中间形态增加保字段迁移。
- 决定：首个正式 v9 版本发布前，AppConfig 仍是可重建的开发期配置 epoch。同一 `schemaVersion` 内新增必填字段或调整结构后，旧文件若不再通过完整 schema 校验，ConfigStore 删除该文件并写入当前默认配置；v8、未知版本以及无法解析的损坏 JSON 同样沿用当前 reset-only 路径，不备份、不迁移、不清理孤儿 secret。
- 背景：目前没有产品用户，也没有已发布配置需要兼容。为分支内 v8→v9 或多个 v9 中间结构维护一次性迁移，只会形成没有用户价值的临时兼容代码。
- 已知代价：分支开发机可能丢失 providers、MCP servers、permission rules 等本地配置；重置前不创建备份，旧 secret 引用也不会在该路径自动清理。开发者应把这些文件视为可丢弃状态。
- 重新评估条件：首个包含 v9 的正式版本实际发布。此后新增不兼容字段必须升版本并重新决策保字段迁移、未知更高版本、备份与 secret orphan 策略，不能默认继承本条开发期取舍。

## 2026-08-03 — 明确不支持 downgrade，破坏性重置前自动备份配置

- 状态：已采纳。
- 背景：六档枚举会被多处持久化——Provider 配置与 Headless 配置的 `reasoning`、Session 的 `modelSelection.reasoning`、已完成 assistant message 冻结的 ModelRoute v2。旧版本应用的同版本校验器不接受 `low/medium/xhigh`，遇到含新值的配置或 Session 记录会校验失败。
- 决定：项目正式声明不支持 downgrade（只向前升级）。不 bump AppConfig/Headless/Route 版本，因为版本号不承担向后兼容语义，且 model pool 分支已占用 AppConfig v16；从本版本起，`ConfigStore` 在因无法解析/迁移而破坏性重置配置前，先把原文件备份为 `<config>.unsupported-<UTC 时间戳>.bak`（备份失败不阻断重置）。
- 已知边界：旧版本应用（不含备份逻辑）遇到新配置仍会静默重置并丢失 Provider/limits 配置，或无法解码含新档位的 Session/message；备份只保护从本版本开始的重置路径。SQLite v6 迁移后，旧应用打开数据库会以 `DATABASE_VERSION_TOO_NEW` 明确失败而不是迟发 codec 错误。
- 重新评估条件：出现真实 downgrade 需求（如发布后回滚通道），届时再评估版本门闩或双读协议。

## 2026-08-06 — Model capability 只由 Provider metadata 持有

- 状态：能力权威边界已采纳；原定的 per-route 并发字段由后续“Swarm 数量归 Job 所有”决策覆盖。
- 决定：AppConfig v18 从 `modelPool.entries[]` 删除 `capability`。模型能力的唯一配置来源是 `providers[].modelOverrides[model].capability`；freezer 从单次 PublicConfig 快照生成携带派生能力的 backend-only candidate，allocator 和 plan snapshot 只消费派生值，不把它写回 pool 配置。
- 配置不变量：enabled entry 对应模型必须有能力标注；保存缺少标注的 entry 会整体失败，Provider 编辑或 reload 发现标注被移除时只禁用受影响 entry，disabled entry 仍可保留待修复引用。Provider revision 已覆盖 `modelOverrides`，因此原有 optimistic concurrency 和 freeze 后复核同时覆盖能力变更。
- 界面边界：Agents 设置页的模型池小节使用 `Provider → model → reasoning` 树形穿梭框选择精确 route；同一模型的不同 reasoning 可以同时入池，不做自动升降档。最低 reasoning 只过滤左侧候选，已选 route 不被隐藏或改写；右侧只读展示派生能力，不配置并发，通过独立 Pinia store 显式原子保存完整数组。Provider 配置仍是模型目录与能力标注的唯一 UI 所有者；模型池不复制这部分表单状态。
- 迁移：v16/v17 使用冻结 schema 读取，规范化 ID 并保留 entry 的其他字段后剥离旧 capability；没有 Provider 能力标注的 enabled legacy entry 在 reload 修复阶段禁用。冲突时不把旧 pool 值反向写入 Provider metadata，避免迁移重新制造第二个权威来源。
- 理由：同一 Provider/model 的能力是模型属性，不是某个 pool slot 的属性。移除重复字段可以消除 Provider 标注与 pool entry 漂移、简化未来 pool UI，并让 digest、分配和 revision 检查都基于同一份配置事实。

## 2026-08-18 — Shared Config 按八个领域拆分

- 状态：已采纳并实现；这是代码所有权重构，不改变产品配置语义。
- 领域边界：配置叶模块固定为 application、assistant、integrations、models、network、providers、runtime、security。`models` 可以组合 Provider 与既有 model-pool 原语；其他领域只依赖 process-neutral 的共享原语。领域叶模块不得导入兼容出口、根组合器或 transport 组合器。
- 组合边界：`shared/config/public-config.ts` 是 AppConfig 版本、`PublicConfigSchema` 与整配置查询 helper 的唯一根组合点。Config 拆分当时由 `shared/config/config-requests.ts` 暂时保留 `ConfigSection` 和 `ConfigSetRequest`，明确属于待 IPC 领域化时迁出的 transport 组合，不作为第九个配置领域。
- 兼容边界：`shared/config.ts` 继续导出拆分前的全部公开符号，避免要求现有调用方在同一提交中机械迁移；新增领域代码直接导入 `shared/config/<domain>`。兼容出口不被领域模块反向依赖，待调用方自然收敛后再单独评估删除。
- 契约边界：AppConfig 保持 v22，不增加迁移；`PublicConfigSchema` 与 `ConfigSetRequestSchema` 的序列化指纹保持不变。测试同时锁定 wire 指纹、兼容导出对象身份和八领域到根 schema 的组合关系。

## 2026-08-19 — Shared IPC Contract 按九个领域拆分

- 状态：已采纳并实现；这是 IPC schema 所有权与依赖方向重构，不改变 transport 行为。
- 领域边界：channel contract 固定归入 application、configuration、projects、sessions、runs、agents、terminals、integrations、diagnostics 九个领域。跨领域共用的 success/error envelope 与空 payload 放在 `ipc/common.ts`，push event envelope 放在 `ipc/events.ts`；二者是 transport 原语，不增加领域数量。
- 组合边界：每个领域按需要导出一个或多个 channel 子注册表，`ipc/registry.ts` 按拆分前的声明顺序组合唯一 `IPC_CONTRACTS`，并从它派生 channel、payload 与 result 类型。领域叶模块不得反向导入 registry、events composer 或兼容出口；shared 内部生产代码也不再依赖 `shared/ipc-contract.ts`。
- Config 归属：原临时 `shared/config/config-requests.ts` 删除，`ConfigSection` 与 `ConfigSetRequest` 迁入 configuration IPC 领域。`shared/config.ts` 继续兼容转出这些旧符号，因此现有 ConfigStore 调用方无需随本次拆分机械迁移。
- 兼容与契约：`shared/ipc-contract.ts` 保留拆分前全部公开导出，现有 Electron、Preload、Renderer 与测试调用方可以渐进迁移。IPC 保持 v1、68 个 channel 及原顺序；完整 channel payload/result 和 event envelope 的序列化指纹保持不变。测试锁定指纹、无重复/遗漏组合、对象身份与 import 边界。

## 2026-08-19 — Agent API 由显式 Capability Manifest 自动装配

- 状态：已采纳并实现；本条只收敛 Renderer bridge 的重复声明，不改变 IPC wire、Main handler 或订阅语义。
- Invoke 事实源：`AGENT_API_INVOKE_ROUTES` 显式声明公开方法名到 `IpcChannel` 的映射。RPC 部分的 `AgentApi` mapped type、`AGENT_API_KEYS` 和 preload plain function object 从同一 manifest 派生；新增普通 bridge 方法不再手写 interface、key 列表和 preload wrapper。
- 安全边界：manifest 是显式 capability allowlist，不从 `IPC_CONTRACTS` 默认暴露新 channel，也不向 Renderer 提供通用 `invoke/send/on`。Main process 业务 handler 继续显式实现，并保留 sender、payload、result 与容量校验；自动装配不跨越该安全边界。
- 订阅边界：`AGENT_API_SUBSCRIPTION_ROUTES` 派生五个公开订阅方法的名称和事件类型。preload 仍显式提供对应 adapter：普通 Agent/Terminal event 去除 Electron event 参数，Backend notification 保留 64 条启动前缓存，Domain State 保留 256 条缓存、overflow 和 replay 语义。
- 回归边界：manifest、公开 key 列表和最终 `contextBridge` 对象均冻结；单测验证当前 68 个 invoke channel 一一映射、路由调用目标、五个订阅 adapter 和无重复公开 key。既有 Electron E2E 继续断言实际 `window.agentApi` 只包含派生 key、对象被冻结且不暴露 `ipcRenderer`。
