# `feat/model-reasoning-levels` 代码与功能审查报告

> 审查对象：`feat/model-reasoning-levels` 相对 `origin/master` 的完整增量
>
> 基线：`origin/master` (`fa63b05`)
>
> 分支 HEAD：`4484923`
>
> 分支提交：`c7c6635 feat: add six-level reasoning efforts and per-model annotations`、`4484923 docs: record reasoning effort expansion decisions`
>
> 审查日期：2026-08-03
>
> 审查范围：25 个变更文件，`+738/-44`

## 1. 结论

**当前不建议合并。** 分支的总体设计方向合理：六档 reasoning 被集中定义，per-model 标注复用了现有 `modelOverrides`，Renderer 和 Backend 都尝试执行兼容性约束，Provider adapter 也保持了各自协议边界。但完整产品链路仍有两个合并阻断问题：

1. SQLite 的 `sessions.reasoning` 仍只允许旧三档，三个新增档位不能创建或更新 Durable Session。
2. 新增的模型标注控件调用了未暴露到 Agent facade 的 action，用户点击后会直接抛出运行时异常，标注无法保存。

此外，Composer 可以形成“下拉选项已收窄、当前值却不合法、发送按钮仍可点击”的状态，最终在 Backend 启动 Run 时才失败。CI 已全绿，但现有测试主要覆盖 schema、纯 store 和 Provider 编译层，恰好绕过了 facade 接线与真实 SQLite 约束，所以不能据此判断该功能可发布。

| 级别 | 数量 | 摘要 |
| --- | ---: | --- |
| Blocker | 2 | Durable Session 不接受新增档位；模型标注控件运行时失效 |
| High | 1 | Composer 允许发送模型/档位不兼容的 Run |
| Medium | 4 | Provider 自动保存陷阱；自动审批静默失效；默认窗口布局溢出；downgrade 契约不完整 |
| Low | 4 | 旧迁移 schema 漂移；文档/i18n 过期；控件可访问名称不足；集合顺序导致伪变更 |

## 2. 审查方法

本次由主审完成以下工作，并以三个独立只读专项审查交叉验证，不以专项审查代替主审：

- 通读 `origin/master...HEAD` 的全部 25 个变更文件。
- 沿“设置页标注 → Agent facade → Settings Store → AppConfig → Composer → Session → route resolver → Provider request”完整跟踪数据与错误边界。
- 检查 AppConfig、IPC、Headless、Durable Session、ModelRoute 与 SQLite 之间的版本和持久化契约。
- 使用仓库实际的 `0001_initial.sql` 在内存 SQLite 中执行六档插入矩阵。
- 核对 GitHub Actions 的成功 Run 与新增/缺失测试。
- 对照 DeepSeek、OpenAI Responses 与 Anthropic 的官方协议文档检查 wire 行为。

没有运行付费的 `test:real`，也没有向真实 Provider 发请求。

## 3. 变更组成与设计评价

### 3.1 数据与契约

- `shared/config.ts:20-38` 将 `ReasoningEffort` 扩展为 `off/low/medium/high/xhigh/max`，并提供唯一的升序常量 `REASONING_EFFORTS`。
- `shared/config.ts:86-107` 在既有 `ModelCapabilityOverride` 中增加 `reasoningEfforts` 和 `capability`，没有引入第二套模型元数据结构。
- `shared/model-settings.ts:43-60` 对未标注模型保持“全档位可选”的旧行为，对已标注模型返回排序后的子集。
- `shared/ipc-contract.ts` 同步扩展模型 profile 的只读 IPC 投影，并对数组非空、唯一性和枚举值进行约束。

这部分抽象方向是正确的：模型档位支持度与 token override 共用 model ID 键空间，同时 annotation-only override 不会把 token 默认值错误冻结为显式 override。

### 3.2 Backend 与 Provider

- `electron/config/store.ts:58-67,151` 在保存 Provider 时校验主模型和 Provider 默认档位是否兼容。
- `electron/providers/model-route-resolver.ts:35-65` 在读取凭据前再次校验 frozen selection，形成后端最终防线。
- DeepSeek、Responses 与 Anthropic adapter 对非 `off` 值按设计原样透传；Responses 把 `off` 映射为 `none`，Anthropic 的 `off` 不发送 thinking/effort，Generic Chat Completions 仍不发送厂商字段。

route resolver 的校验位置合理，能够在秘密读取和网络请求前拒绝错误路由。主要问题不在这一层的校验本身，而在前置 UI 没有把同一约束完整接通，以及 Durable schema 没有同步升级。

### 3.3 Renderer

- Provider 设置页给每个启用模型增加“支持档位”和“能力等级”两列。
- Provider 默认档位和 Composer 档位下拉会读取当前模型 annotation。
- `providerModelOverrides()` 只为 annotation-only 行保存 annotation，不保存计算出的 token 默认值。
- 修改 annotation 会进入 Provider autosave，并通过 route shape 触发 Provider revision 更新。

意图与数据流基本一致，但 facade action 漏接使两个新增控件在实际 UI 中完全不可用；Composer 的“保留旧档位”规则也没有配套无效态处理。

## 4. Findings

### Blocker B1：SQLite 仍只允许旧三档，新增档位无法持久化

**位置**

- `shared/config.ts:20-27`
- `electron/persistence/migrations/0001_initial.sql:11-30`，尤其是 `:22`
- `electron/persistence/migrations/index.ts:1-39`
- `electron/persistence/session-repository.ts:38-105`
- `electron/application/session-service.ts:361-390`

**证据**

TypeScript、IPC 与 Session codec 现在接受六档，但 SQLite 列约束仍为：

```sql
reasoning TEXT NOT NULL CHECK (reasoning IN ('off', 'high', 'max'))
```

迁移注册表只到 `0005_subagent_executions`，没有扩展这个 CHECK 的 v6 迁移。使用仓库真实初始 schema 的插入结果为：

```text
off: accepted
low: rejected (ERR_SQLITE_ERROR)
medium: rejected (ERR_SQLITE_ERROR)
high: accepted
xhigh: rejected (ERR_SQLITE_ERROR)
max: accepted
```

**功能影响**

- 以 `low`、`medium` 或 `xhigh` 创建新对话时，首轮 Durable commit 无法插入 Session，Run 启动流程失败。
- 已有 Session 切换到这三个档位时，`SessionRepository.update()` 失败，设置不会持久化。
- Headless 和 Subagent 最终也使用同一 Session 持久化约束；继承新增档位时同样受影响。
- 这是数据库层真实约束，不会被 TypeBox schema、typecheck 或 Provider 单测发现。

**建议**

新增不可变的 `0006_reasoning_levels.sql` 并注册到 migration index。SQLite 修改 CHECK 需要安全重建 `sessions` 表；迁移必须保留父子外键、`sessions_clear_parent_before_delete` 触发器、索引和已有数据。不要直接修改 `0001_initial.sql`，已应用 migration 有 checksum 保护。

至少补充：全新数据库、v5→v6 升级、六档 insert/update、父子 Session、删除触发器、packaged SQLite smoke，以及 Headless/Subagent 使用新增档位的回归测试。

### Blocker B2：新增 annotation action 没有暴露到 Agent facade

**位置**

- `src/components/settings/ProviderSettingsPanel.vue:140-159,625-648`
- `src/stores/agent-settings.ts:547-575`
- `src/stores/agent.ts:27-52,210-245,322-330`

**证据**

两个新增 `NSelect` 分别调用：

```ts
agent.updateModelAnnotation(modelId, ...)
```

`updateModelAnnotation` 确实存在于 Settings Store，且 `AgentFacade` 的交叉类型使 TypeScript 认为它存在；但是 `useAgentStore()` 是手工 Proxy facade，action 只能通过 `actions` map 暴露。该 map 在 `updateModelConfiguration` 后直接进入 `loadProviderModels`，遗漏了 `updateModelAnnotation`。

Proxy 的 fallback 只会从 `settingsProperties` 指定的 state/getter 中取值，不会自动转发 Pinia action。因此运行时读到的是 `undefined`，用户编辑“思考档位”或“能力等级”都会触发：

```text
TypeError: agent.updateModelAnnotation is not a function
```

**功能影响**

- 本分支最核心的 per-model annotation UI 无法使用。
- 变更不会进入 autosave，也不会写入 AppConfig。
- 纯 Settings Store 测试直接调用底层 store，因此全部通过；TypeScript 又被 `AgentFacade` 类型掩盖，CI 没有发出信号。

**建议**

- 在 facade action map 中显式代理 `settings.updateModelAnnotation`。
- 增加 facade contract 测试，至少断言所有对外 action 在运行时都是函数。
- 增加 `ProviderSettingsPanel` 组件或 Electron E2E：编辑两个 annotation、等待 autosave、重新进入页面并确认值恢复。

### High H1：模型切换后可保留不受支持的档位，发送按钮仍可用

**位置**

- `src/components/chat/MessageComposer.vue:84-93,604-612`
- `src/stores/agent-runtime.ts:144-158,652-675`
- `electron/providers/model-route-resolver.ts:46-55`

**复现路径**

1. 模型 A 当前档位为 `high`。
2. 模型 B 标注只支持 `low`。
3. 在 Composer 中从 A 切换到 B。
4. `reasoningOptions` 立即只剩 `low`，但 `setProviderModel()` 明确保留原来的 `high`。
5. 受控 `NSelect` 的当前值不在 options 中，通常显示为空；`canSend` 只检查模型是否启用，发送按钮仍可点击。
6. Backend 的 route resolver 最后才拒绝 `B + high`，整轮 Run 启动失败。

已有 Session 在 annotation 后变得不兼容时也会进入同一状态。现有 `agent-runtime.test.ts:234-253` 只验证“切模型保留 reasoning”，没有覆盖 per-model annotation。

**建议**

不需要违背已决定的“不自动升降档”。应新增统一的 `reasoningSelectionValid`：当前值不属于当前模型支持集时，保留该值但将控件标为无效、禁用 Send、在 `sendHint` 明确提示用户必须手动选择。Backend 拒绝仍保留为最终防线。

### Medium M1：Provider annotation 可制造 autosave 失败循环，其他修改也无法保存

**位置**

- `src/components/settings/ProviderSettingsPanel.vue:83-93,166-194,510-519`
- `src/stores/agent-settings.ts:788-849`
- `electron/config/store.ts:58-67,145-151`

修复 B2 后，若 Provider 主模型当前为 `high`，用户把该模型标注成只支持 `low`：

- 主档位下拉立刻移除 `high`，但没有解释当前 Provider draft 已无效。
- 600ms autosave 继续提交完整 Provider draft。
- ConfigStore 正确地整笔拒绝更新，UI 将后端英文错误直接放入保存状态。
- draft 一直 dirty；同一 draft 中其他合法修改也不会落盘，离开页面时还会再次保存失败。

这是“后端原子拒绝正确、前端状态机不完整”。建议在设置页复用相同兼容性计算，冲突时暂停 autosave并显示字段级提示，直到用户显式选择受支持档位；不要自动改档。

### Medium M2：自动审批可保存不兼容模型，运行时静默退回人工审批

**位置**

- `src/stores/agent-settings.ts:259-265`
- `electron/config/store.ts:545-550`
- `electron/providers/model-route-resolver.ts:95-132`

`approvalModelOptions` 只按 `enabledModelIds` 生成，保存 approval 时也不校验审批模型的 `reasoningEfforts`。运行时审批档位继承 Provider 默认值；Provider 为 `off` 时还会按安全规则提升到 `high`。如果审批模型不支持最终档位，resolver 捕获异常并移除 approval route，只写 diagnostic。

安全上是保守降级，不会误批；功能上却表现为“设置显示保存成功，自动审批一直不工作，用户突然看到人工审批卡”。

建议按“审批实际档位”过滤或禁用不兼容模型，并在保存 approval、修改 Provider 默认档位、修改相关模型 annotation 时做交叉校验。运行时 catch 继续保留为最后防线，同时把可操作的配置错误展示给用户。

### Medium M3：六列模型设置在默认/最小窗口宽度下溢出，响应式规则不会触发

**位置**

- `src/styles/settings-content.css:121-166,256-299`
- `electron/main.ts:308-317`
- `src/App.vue:42-44,427-454`
- `src/styles/settings-layout.css:61-70`

六列 grid 的最小内容宽度约为：

```text
180 + 3×130 + 170 + 110 + 5×10 = 900px
```

而默认窗口宽度为 1120px，左设置导航固定 320px，再扣除内容左右 padding 56px，实际可用宽度约 744px；最小窗口 960px 时只剩约 584px。单列布局只在 viewport `max-width: 720px` 时触发，但 BrowserWindow 的 `minWidth` 是 960px，因此在正常桌面窗口中永远不会触发。

列表被 `NScrollbar` 包裹，但表头在 scrollbar 外，且没有成对的横向滚动设计；结果会是列被裁切、控件溢出或表头和内容错位。

建议使用容器查询或针对设置内容宽度的布局断点，在约 1000px 以下切成两列/单列详情布局；也可以把每个模型改成 Naive UI 描述/折叠结构。应补默认 1120px 与最小 960px 的视觉/E2E 断言，包括 `scrollWidth <= clientWidth`。

### Medium M4：不 bump 契约版本低估了 downgrade 破坏面

**位置**

- `shared/config.ts:20-27,177-180`
- `electron/config/schema.ts:59-63`
- `electron/headless/contracts.ts:14-29,87-90`
- `shared/model-route.ts:5,14-35`
- `electron/persistence/session-codec.ts:95-129`
- `docs/decision-log.md:124-130`

决定日志把不 bump AppConfig v15 描述为“纯 optional 增量”，并只记录 annotation 的 downgrade 风险。但本分支还扩展了一个会被多处持久化的 enum：

- Provider config 的 `reasoning` 可以保存新增值。
- Headless v4 config 可以保存新增值。
- Session 的 `modelSelection.reasoning` 可以保存新增值。
- Assistant message 中冻结的 ModelRoute v2 也可以携带新增值。

旧版同版本 validator 不接受 `low/medium/xhigh`。尤其是旧 ConfigStore 遇到无法迁移的 v15 文件时会将配置移除并写默认值，因此 downgrade 可能丢失整个 Provider/limits 配置，而不只是忽略 annotation；旧版还可能无法解码含新增值的 Session/message。

如果项目明确不支持 downgrade，可以保留现有版本，但决定日志和 release note 必须完整披露范围，并考虑在破坏性回退前备份配置。如果版本号承担兼容性语义，则应 bump AppConfig/Headless/route 版本并定义迁移/拒绝策略。数据库增加 v6 后，旧应用至少会以“数据库版本过新”明确拒绝，而不是迟发 codec 错误。

### Low L1：冻结的旧配置 migration schema 随当前 schema 漂移

**位置**

- `electron/config/migrations.ts:42-72`

注释声明 `LegacyAppProviderConfigV9Schema` 是冻结边界，不应从当前 schema 派生；但它的 `reasoning` 直接复用当前 `ReasoningEffortSchema`，`modelOverrides` 也直接复用当前 PublicConfig shape。本分支因此让所谓 v9 schema 接受 v9 从未存在的新增档位和 annotations。

建议为 v9 定义旧三档 enum 与旧 override shape，并加入负向 fixture，确保未来 schema 扩展不会悄然改变历史 migration 的输入语言。v10-v14 中复用当前 Provider 子 schema 的位置也应一并检查。

### Low L2：Anthropic 提示与需求文档仍停留在旧三档语义

**位置**

- `src/locales/zh-cn.ts:387-393`
- `src/locales/en-us.ts:399-406`
- `docs/requirements.md:164-170`

实现对所有非 `off` 档位都发送 `thinking: { type: 'adaptive' }` 与 `output_config.effort`，但中英文提示和 requirements 仍写“high/max 使用 adaptive thinking”。选择 `low/medium/xhigh` 时，文案与实际 wire 行为不一致。

`docs/frontend-spec.md` 也尚未记录模型行新增的 reasoning/capability annotation 控件。建议同步更新协议说明、设置页规范和中英文提示。

### Low L3：新增模型行下拉缺少稳定的可访问名称

**位置**

- `src/components/settings/ProviderSettingsPanel.vue:543-554,625-648`
- `src/styles/settings-content.css:159-166`

桌面六列表头被标记为 `aria-hidden="true"`，每行 `label` 中的文字又通过 `display: none` 隐藏；两个新增 `NSelect` 没有 `aria-label`/`aria-labelledby`。依赖屏幕阅读器时，很难区分“思考档位”和“能力等级”，更难知道它们属于哪个模型。

建议给每个控件生成包含模型名和字段名的 `aria-label`，不要依赖视觉表头作为唯一字段语义。

### Low L4：`reasoningEfforts` 是集合，但签名与 revision 对数组顺序敏感

**位置**

- `src/stores/provider-form.ts:33-58,60-98`
- `electron/config/store.ts:153-162`

schema 只要求值唯一，语义上它是“支持的档位集合”；但保存、dirty signature 和 Provider route shape 都直接序列化数组顺序。相同集合若以不同顺序进入配置，会被视为修改并 bump Provider revision，造成不必要的 route invalidation/autosave。

建议在 schema 边界或 `providerModelOverrides()` 中按 `REASONING_EFFORTS` 规范化顺序，并让签名和 route shape 使用规范化结果。

## 5. Provider 协议与产品语义核对

### DeepSeek Chat Completions

当前 adapter 在非 `off` 时原样发送 `reasoning_effort`。DeepSeek 官方文档列出的原生控制档位和实际映射并不等同于本地六档：不同模型会把请求值映射到 `low/high/max`，例如 `xhigh` 可能实际映射为 `high` 或 `max`；`medium` 也不是文档列出的原生控制值。

这与决定日志“未标注模型若 API 不支持就原样报错”的选择一致，因此不是单独的实现 bug，但“用户永远知道实际请求的是哪一档”只能解释为“知道客户端发了哪个字符串”，不能解释为“知道 Provider 最终执行了哪个档位”。UI 文案应避免后者暗示。

参考：[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

### OpenAI-compatible Responses

当前 adapter 将 `off` 映射为 `none`，其他五档原样发送。OpenAI 官方文档明确说明可用值和默认值都是 model-dependent，可包含 `none/minimal/low/medium/high/xhigh/max`，且部分模型只支持子集。本地六档不提供 `minimal`，未标注模型则仍可能选择该模型不支持的值。

per-model annotation 正是正确的收窄机制；需要确保 B2/H1 修复后它真的可配置且在发送前生效。

参考：[OpenAI Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)

### Anthropic Messages

官方文档同样说明 effort 支持度是模型级的，并特别指出有些支持 `max` 的模型不支持 `xhigh`。当前 annotation 设计适合表达这种子集；所有非 `off` 使用 adaptive thinking 的实现与当前架构一致，但本地提示需要按 L2 更新。

参考：[Claude Effort](https://platform.claude.com/docs/en/build-with-claude/effort)

### Generic Chat Completions

这一 adapter 继续不发送 reasoning 厂商字段，行为与现有提示一致。用户选择档位只影响本地 route 元数据而不会改变 wire request；这是既有明确边界。

## 6. 测试与 CI 评价

GitHub Actions Run [30809729482](https://github.com/zch4321/zch-coding-agent/actions/runs/30809729482) 在分支 HEAD `4484923` 上成功，Windows `Verify` 完整通过。新增测试对以下内容覆盖较好：

- 六档 schema 与 annotation IPC 校验。
- annotation-only override 不冻结 token 默认值。
- ConfigStore 主模型不兼容时整笔拒绝。
- annotation 修改触发 Provider revision。
- route resolver 在凭据读取前拒绝不支持档位。
- DeepSeek/Anthropic 的部分新增值 passthrough。

但绿色 CI 漏掉了本报告的核心问题：

| 缺口 | 为什么现有测试没有发现 |
| --- | --- |
| B1 SQLite CHECK | 新测试停在 ConfigStore/route/provider；没有用真实 SessionRepository 对六档 insert/update，也没有数据库迁移 |
| B2 facade action | `agent-settings.test.ts` 直接调用底层 Settings Store；没有通过 `useAgentStore()` Proxy 或真实控件触发 action |
| H1 Composer 无效态 | 只测试“切模型保留档位”，没有测试 annotation 收窄后的 `canSend`/hint/Run 行为 |
| M1 autosave | 没有 ProviderSettingsPanel annotation 组件/E2E，也没有失败后的 dirty/status/恢复断言 |
| M2 approval | approval model option/save 没有与 annotation 交叉测试 |
| M3 layout | 现有 E2E 检查旧三列输入存在，不检查新增六列在默认/最小窗口是否溢出 |
| M4 downgrade | 没有旧版本 schema fixture、配置备份/拒绝策略或 durable codec downgrade 测试 |

其他值得补充的测试：

- `generic-responses-provider.test.ts` 对 `low/medium/xhigh/max` 的实际 request body 断言。
- ConfigStore annotation “round-trip”应关闭第一个实例，再从磁盘初始化第二个实例；当前用例只读取同一实例内存。
- Headless 新档位从 config 到 frozen route/provider request 的端到端测试。
- Subagent 继承父 Run 新档位并完成 hidden Session 持久化的测试。
- `reasoningEfforts` 乱序输入的规范化与 revision 稳定性测试。

## 7. 建议修复顺序

1. **先修 B1**：新增 SQLite v6 migration 和真实持久化测试。
2. **再修 B2**：补 facade action，并用组件/E2E 证明 annotation 可编辑、自动保存、重载恢复。
3. **修 H1/M1**：抽取一套前端兼容性派生状态，Composer 禁止无效发送，Provider 页面暂停无效 autosave；都要求用户手动选档，不做自动升降。
4. **修 M2**：对审批实际档位做配置时交叉校验，并向用户显示不兼容原因。
5. **修 M3**：按设置内容容器宽度重排模型行，并加默认/最小窗口 E2E。
6. **明确 M4**：选择“正式版本迁移”或“明确不支持 downgrade + 备份/文档”之一。
7. 更新协议文案、a11y、历史 migration schema 与集合规范化。

## 8. 最终判断

该分支的核心抽象可以保留，不需要推翻 per-model annotation 或“不自动升降档”的产品决定。当前问题主要来自跨层同步不完整：共享 enum 已扩展，但 SQLite 没扩展；底层 store 已新增 action，但 facade 没接；下拉 options 已收窄，但发送/保存状态机没同步收窄。

在 B1、B2、H1 修复并补上对应端到端覆盖前，不应合并或发布。M1/M2/M3 建议同批修复，因为它们直接决定用户能否理解并稳定使用新配置；M4 至少需要在合并前形成明确的兼容性决定与文档。
