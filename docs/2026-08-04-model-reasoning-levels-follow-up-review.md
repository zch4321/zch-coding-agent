# `feat/model-reasoning-levels` 复审报告

> 审查对象：当前工作树相对 `master` 的完整最终状态（包含已提交分支增量与未提交整改）
>
> 基线：`master` (`fa63b05`)
>
> 当前 HEAD：`0dd5803`
>
> 分支提交：`c7c6635`、`4484923`、`0dd5803`
>
> 审查日期：2026-08-04
>
> 规模：排除上一版 366 行审查报告后，共 45 个变更文件，约 `+1900/-83`
>
> 上一版报告：[`2026-08-03-model-reasoning-levels-review.md`](./2026-08-03-model-reasoning-levels-review.md)

## 1. 结论

**当前仍不建议合并。** 上一版报告中的两个 Blocker 已被实质修复：SQLite v6 migration 允许六档 reasoning 持久化，Provider annotation action 也已接入 Agent facade。新增测试覆盖了 v5→v6 升级、Headless、Subagent、设置页 autosave/reload 和默认/最小窗口布局；整体整改质量明显提高。

但本次复审确认仍有 4 个问题：

| 级别 | 数量 | 摘要 |
| --- | ---: | --- |
| High | 1 | Composer 新增的 reasoning 有效性 getter 未暴露到手工 facade，所有正常选择都显示错误态 |
| Medium | 2 | Provider draft 与审批配置冲突时仍落入通用 autosave 失败；审批 route 不变量仍允许被禁用模型/删除回退路径破坏 |
| Low | 1 | reasoning 集合虽在保存时规范化，但 dirty signature 仍对数组顺序敏感 |

其中 High finding 是稳定、全局可见的 Composer 回归，并且现有绿色门禁完全没有经过该 facade getter 路径，因此应在合并前修复。

## 2. 审查范围与方法

本次审查覆盖：

- `master` 到当前工作树的全部代码、测试、SQL、样式和文档变更。
- “模型 annotation → Provider draft → ConfigStore → Composer → Durable Session → route resolver → Provider request”的完整数据链路。
- 自动审批的 `off → high` 安全提升、模型启用池、annotation 子集与 Provider 删除回退之间的一致性。
- SQLite v6 表重建、外键暂停/恢复、触发器与索引恢复、六档 insert/update。
- 历史 AppConfig v9–v14 schema 冻结、v15 downgrade 决策和重置前备份。
- 上一版报告 11 个 findings 的逐项复核。

执行了：

- `git diff --check master`：通过。
- `npm run verify`：通过。
  - ESLint、public API comment 检查、Prettier：通过。
  - Vitest：133 个文件通过、1 个跳过；901 项测试通过、2 项跳过。
  - Vue/Node/runtime typecheck：通过。
  - PTY、ripgrep、开发 SQLite smoke：通过。
  - Renderer、Electron、Headless 构建：通过。
  - Windows x64 打包：通过。
  - Packaged SQLite probe：因 macOS 主机无法运行 Windows 目标，按设计跳过。
  - Playwright：34 项通过、1 项 Windows 专属用例跳过。

没有运行付费的 `test:real`，也没有向真实 Provider 发请求。

## 3. 变更评价

### 3.1 共享契约与模型标注

- `ReasoningEffort` 已集中扩展为 `off/low/medium/high/xhigh/max`，`REASONING_EFFORTS` 提供统一强度顺序。
- `reasoningEfforts` 与 `capability` 复用现有 `modelOverrides`，没有引入第二套模型 ID 或持久化结构。
- annotation-only override 不会把派生 token 默认值冻结成显式 override。
- Renderer IPC profile、Config schema、route resolver 和 Provider adapter 均使用同一枚举边界。

这一设计方向正确。未标注模型继续视为全档位支持，已标注模型使用显式子集；后端在读取凭据之前拒绝不兼容 route，也保留了必要的最终防线。

### 3.2 SQLite v6

`0006_reasoning_levels.sql` 通过新表拷贝和换名扩展 `sessions.reasoning` CHECK，并恢复：

- `sessions_clear_parent_before_delete`
- `sessions_delete_subagent_children`
- 三个 sessions 索引

Migration runner 只对声明 `disableForeignKeys` 的表重建迁移暂停外键，并在写入 migration ledger、提交事务之前执行全库 `PRAGMA foreign_key_check`。对应测试覆盖了：

- 六档 SessionRepository insert/read。
- `low → xhigh` update。
- 非法档位被 SQLite CHECK 拒绝。
- v5→v6 数据保留。
- parent/fork 关系和删除触发器。
- Headless `medium` 请求与 Subagent hidden Session 持久化。

上一版 B1 已闭环。

### 3.3 设置页与响应式布局

- annotation action 已接入 facade，新增 facade action contract test。
- 主模型 annotation 与 Provider 默认档位冲突时暂停 autosave，要求用户手动改档。
- 六列布局使用 settings content 容器查询，在默认 1120px 和最小 960px 窗口下切换为堆叠布局。
- E2E 已验证 annotation 编辑、autosave、reload 恢复及水平溢出。
- 中英文 Anthropic 提示、requirements 和 frontend spec 已同步。

设置页本身的核心路径已可用；当前主要残留问题集中在 Composer facade 和跨页面审批一致性。

## 4. Findings

### High H1：`composerReasoningValid` 未暴露到 Agent facade，正常选择也永久显示错误态

**位置**

- `src/stores/agent-runtime.ts:199-215`
- `src/stores/agent.ts:135-162,285-325`
- `src/components/chat/MessageComposer.vue:114-130,607-617`
- `src/stores/agent.test.ts:8-42`

**机制**

`composerReasoningValid` 已正确实现为 Runtime Store getter，`canSend` 在 Runtime Store 内部也会读取它。但是 UI 不直接使用 Runtime Store，而是通过 `useAgentStore()` 返回的手工 Proxy facade。

该 Proxy 只有在 property 被列入 `runtimeProperties` 时才会转发到 Runtime Store。当前白名单包含：

```ts
'composerModelSelection',
'composerProviderId',
'composerModel',
'composerReasoning',
'composerModelOptions',
```

却遗漏了 `composerReasoningValid`。因此组件中的：

```ts
agent.composerReasoningValid
```

在运行时恒为 `undefined`。`AgentFacade` 的交叉类型仍声明该 getter 存在，所以 typecheck 不会报警。

**用户影响**

- reasoning 下拉对所有模型、所有合法档位都显示红色 error status。
- Provider notice 已确认后，输入框 placeholder 始终显示“当前模型不支持所选思考档位”。
- 合法选择的 Send 按钮仍可能可用，因为 `canSend` 是 Runtime Store 内部计算，形成“控件提示不合法但发送又可用”的自相矛盾状态。
- 真正不合法的选择仍会被 `canSend` 阻断，但用户无法通过视觉状态判断何时已恢复合法。

**为什么完整门禁没发现**

- `agent-runtime.test.ts` 直接读取底层 `runtime.composerReasoningValid`，绕过 facade。
- 新增 `agent.test.ts` 只枚举 Settings Store action，不检查 Runtime Store getter/property。
- 新增 E2E 停留在设置页，没有返回 Composer 检查正常态、错误态和 Send 状态。

**建议**

1. 把 `composerReasoningValid` 加入 `runtimeProperties`。
2. 扩展 facade contract test，覆盖所有被组件消费的 Runtime/Settings getter 和 state，而不只覆盖 Settings action。
3. 增加 Composer 组件或 Electron E2E：
   - 合法模型/档位不显示 error，Send 可用。
   - 切换到只支持其他档位的模型后显示 error，Send 禁用。
   - 手动选择受支持档位后 error 消失，Send 恢复。

### Medium M1：审批档位冲突只在后端拒绝，Provider autosave 仍会进入失败草稿

**位置**

- `src/components/settings/ProviderSettingsPanel.vue:100-112,179-211`
- `src/stores/agent-settings.ts:260-276,800-896`
- `electron/config/store.ts:70-93,180-194`
- `src/components/settings/PermissionsSettingsPanel.vue:28-37,88-107`

**复现路径 A：修改非主审批模型 annotation**

1. Provider 默认档位为 `high`，主模型 A 支持 `high`，自动审批模型 B 也支持 `high`。
2. 在 Provider 设置页把 B 标注为只支持 `low`。
3. `mainReasoningConflict` 只检查主模型 A，因此返回 false，600ms autosave 正常触发。
4. ConfigStore 发现已保存审批模型 B 不支持实际审批档位 `high`，整笔拒绝。
5. 页面只显示后端通用英文错误；draft 保持 dirty，同一 draft 中其他 Provider 修改也不能落盘。

**复现路径 B：修改 Provider 默认档位**

1. 主模型 A 同时支持 `low/high`，审批模型 B 只支持 `high`。
2. 将 Provider 默认档位从 `high` 改为 `low`。
3. 对主模型而言新值合法，所以前端不会暂停 autosave；对审批模型而言新值不合法，后端仍整笔拒绝。

Permissions 页面新增的 conflict 状态读取的是已持久化 `providers`，不是 Provider 页尚未保存的 draft。因此用户切换页面后也不会自动看到本次 draft 所制造的冲突；需要根据通用错误自行推断并先改审批设置。

**建议**

- 抽取一套可同时接受 persisted provider 和 Provider draft 的 `effectiveApprovalReasoning`/compatibility 派生逻辑。
- Provider 页同时计算主模型冲突和当前 approver 冲突；冲突时暂停 autosave，并显示字段级、本地化提示，明确要求先修改 Provider 档位、模型 annotation 或审批模型。
- 增加 E2E 覆盖“非主审批模型 annotation 冲突”和“Provider 默认档位使审批模型失效”两条路径。

### Medium M2：审批 route 不变量只检查档位，仍允许保存被禁用或无效的审批模型

**位置**

- `electron/config/store.ts:76-93,180-194,521-556,588-598`
- `electron/providers/model-route-resolver.ts:26-34,91-133`
- `src/stores/agent-settings.ts:260-276,911-930`
- `src/components/settings/PermissionsSettingsPanel.vue:28-37`

**证据**

`assertApprovalModelReasoningSupported()` 当前只执行：

```ts
const supported = provider.modelOverrides[model]?.reasoningEfforts
if (supported?.length && !supported.includes(effectiveEffort)) throw ...
```

它没有验证：

- Provider 是否存在；不存在时直接 return。
- model 是否非空。
- model 是否仍在 `enabledModelIds`。

Provider 更新会调用该函数，但用户可在模型穿梭框中禁用当前 approver model；只要 annotation 本身兼容或缺省，更新就会成功。之后 route resolver 在 Run 启动时因“Model is not enabled”抛错，并被上层 catch 为“自动审批不可用”，静默退回人工审批。

Provider 删除路径还有独立缺口：删除当前 approver provider 后，代码直接把审批设置改成 fallback provider 的主模型，没有重新验证 `off → high` 后的实际审批档位是否受支持。`setApprovalProvider()` 也总是选择 `enabledModelIds[0]`，而不是第一个兼容的 `approvalModelOptions`。

**影响**

- 设置可能显示保存成功，但自动审批在每个后续 Run 中静默失效。
- 安全上仍是保守降级，不会误批准；功能上用户无法相信“已保存的自动审批设置”代表 route 可用。
- Permissions 页面会把“模型已禁用/缺失”也统一显示成 reasoning conflict，原因提示不准确。

**建议**

建立单一 `assertApprovalRouteConfigValid()`，至少验证 Provider 存在、model 非空、model 已启用、实际 reasoning 受支持，并在以下入口统一调用：

- 保存 approval。
- 更新 approver provider。
- 删除 approver provider 并选择 fallback。
- 其他会改变模型启用池或默认档位的配置入口。

UI 应区分“模型未启用”和“reasoning 不兼容”，切换 Provider 时优先选择第一个兼容模型。运行时 catch 继续作为最终安全防线。

### Low L1：`reasoningEfforts` dirty signature 仍对集合顺序敏感

**位置**

- `src/stores/provider-form.ts:67-103`
- `src/stores/provider-form.test.ts:94-121`
- `electron/config/store.ts:137-150,204-212`

保存序列化和后端 route shape 已使用 `normalizeReasoningEfforts()`，因此同一集合的不同顺序不会再 bump Provider revision。可是 `providerFormSignature()` 仍直接复制原数组：

```ts
reasoningEfforts: model.reasoningEfforts?.length
  ? [...model.reasoningEfforts]
  : null
```

因此 `['low', 'high', 'max']` 与 `['max', 'low', 'high']` 仍产生不同 dirty signature。多选控件若按点击顺序返回相同集合，会触发一次不必要的 autosave；后端虽然避免 revision bump，但磁盘写入和保存状态变化仍发生。

现有“stable for equivalent annotations”测试只比较两次相同顺序，没有覆盖乱序集合。

**建议**

- 在 `providerFormSignature()` 中同样调用 `normalizeReasoningEfforts()`，或在 `updateModelAnnotation()` 入口规范化。
- 将测试改成比较两个顺序不同但元素相同的 annotation。

## 5. 上一版 Findings 整改矩阵

| 上一版 | 状态 | 本次复核 |
| --- | --- | --- |
| B1 SQLite 只接受旧三档 | 已解决 | SQLite v6 migration、六档 repository 测试、Headless/Subagent 持久化均已补齐 |
| B2 annotation action 未接 facade | 已解决 | `updateModelAnnotation` 已代理，facade action test 已覆盖；但出现本报告 H1 的 Runtime getter 同类漏接 |
| H1 Composer 可发送不兼容档位 | 核心逻辑已解决 | Runtime `canSend` 会校验，Backend 防线保留；UI 有本报告 H1 的错误态接线回归 |
| M1 Provider autosave 失败循环 | 部分解决 | 主模型自身冲突会暂停；approver 跨模型/跨页面冲突仍见本报告 M1 |
| M2 自动审批静默失效 | 部分解决 | annotation 子集过滤与后端校验已加；enabled model、空值、删除回退仍见本报告 M2 |
| M3 默认/最小窗口溢出 | 已解决 | content container query 与 1120/960px E2E 已覆盖 |
| M4 downgrade 契约不完整 | 已形成明确决定 | 文档声明不支持 downgrade；当前版本在破坏性 reset 前 best-effort 备份配置；SQLite v6 对旧应用提供明确版本门闩 |
| L1 历史 migration schema 漂移 | 已解决本次相关字段 | v9–v14 reasoning、model catalog、model override 使用冻结 schema，并增加负向 fixture |
| L2 文档/i18n 旧语义 | 已解决 | Anthropic 非 off 语义、requirements、frontend spec 已同步 |
| L3 annotation 控件可访问名称 | 基本解决 | 已添加含模型 ID 和字段名的 label；尚无基于 combobox accessible name 的自动化断言 |
| L4 集合顺序导致伪变更 | 部分解决 | 保存和后端 revision 已规范化；前端 dirty signature 仍见本报告 L1 |

## 6. 测试与门禁评价

### 覆盖较好的部分

- AppConfig 历史 schema 对新 enum/annotation 的负向拒绝。
- Config reset 前备份及从磁盘重新初始化后的 annotation round-trip。
- 六档 reasoning 的 SQLite insert/update 和非法值拒绝。
- v5→v6 升级、索引/触发器恢复、parent/fork 数据保留。
- Responses、Anthropic、DeepSeek 新档位 request body。
- Headless 与 Subagent 对新增档位的端到端持久化。
- Provider annotation autosave、reload 和窄窗口布局。
- 主模型不兼容、审批模型 reasoning 不兼容的 ConfigStore 原子拒绝。

### 仍缺失的关键覆盖

| 缺口 | 现有门禁为什么未发现 |
| --- | --- |
| Composer facade getter | Runtime 单测绕过 Proxy；facade test 只扫 Settings action；E2E 不回 Composer |
| Provider draft/approver 冲突 | E2E 只制造主模型自身冲突，没有配置独立审批模型 |
| 禁用当前 approver model | ConfigStore 测试只验证 reasoning annotation，不验证 enabled membership |
| 删除 approver provider 后的 fallback | provider-delete 测试没有构造 `off → high` 不兼容 fallback |
| dirty signature 集合乱序 | 测试只比较相同数组顺序 |
| annotation accessible name | E2E 用 CSS `aria-label` 定位外层 label，没有用 role/name 验证实际 combobox |

完整 `npm run verify` 全绿说明编译、打包、持久化主路径和已有 E2E 稳定，但不能覆盖手工 Proxy 的“类型存在、运行时属性不存在”这一类错误。该 facade 应被视为显式跨-store contract，测试策略需要与 IPC contract 类似地做运行时枚举/消费面校验。

## 7. 安全与架构复核

本分支没有发现新的凭据泄露、Renderer 越权、IPC sender/path guard 绕过或 Provider 请求提前读取秘密的问题：

- route compatibility 仍在 `getProviderApiKeyForRevision()` 之前检查。
- annotation 只进入 renderer-safe PublicConfig，不包含 secret reference 或明文 API key。
- Config backup 保存的是原配置文件；凭据仍由 SecretStore 持有，配置只含 reference。
- SQLite migration 在事务提交前执行外键完整性检查，失败会回滚。
- 自动审批不兼容时仍保守退回人工审批，不会扩大授权。

本报告的审批 findings 属于可用性和配置一致性问题，而不是“错误自动批准”的安全漏洞。

## 8. 建议修复顺序

1. **先修 H1**：补 `runtimeProperties` 和 facade runtime getter contract test，再增加 Composer 正常/错误态 E2E。
2. **统一审批不变量**：建立单一 validator，覆盖 approval 保存、Provider 更新、禁用模型和删除回退。
3. **补 Provider draft 冲突 UI**：在 autosave 前同时检查 main route 与 approval route，提供本地化字段提示。
4. **完成集合规范化**：让 dirty signature 对顺序不敏感。
5. 补 accessibility role/name 断言，防止外层 label 存在但真实 combobox 名称丢失。

## 9. 最终判断

本次整改已经把上一版两个真正的 Blocker 和大部分跨层缺口补齐，SQLite migration、Provider 保存原子性、响应式布局及端到端测试都达到了可接受水平。当前不需要推翻六档 reasoning 或 per-model annotation 的设计。

合并前仍应修复 H1，并建议同时完成 M1/M2：前者是所有用户都会看到的 Composer 错误态；后两者决定“已保存的自动审批配置”是否可信。L1 不阻断功能，但修复成本低，适合与本轮一起收口。
