# `feat/model-reasoning-levels` 第二次整改复审报告

> 审查对象：当前工作树相对 `master` 的完整最终状态（包含已提交分支增量与本轮未提交整改）
>
> 基线：`master` (`fa63b05`)
>
> 当前 HEAD：`49ad226`
>
> 分支提交：`c7c6635`、`4484923`、`0dd5803`、`e3cb80a`、`49ad226`
>
> 审查日期：2026-08-04
>
> 报告创建前规模：48 个变更文件，约 `+3082/-87`；其中本轮未提交整改为 15 个文件，约 `+547/-54`
>
> 上一版报告：[`2026-08-04-model-reasoning-levels-follow-up-review.md`](./2026-08-04-model-reasoning-levels-follow-up-review.md)

## 0. 2026-08-05 修复复核（覆盖下方原始结论）

本报告记录的两个 Medium 已在当前未提交工作树中修复；第 1、4、5、6、8、9 节保留修复前的审查原文，便于追溯问题机制。

- **M1 已解决**：Settings Store 现在同时保留可编辑的 `approvalForm` 和结构化的 `approvalSavedForm`；Provider 预检查只读取后者，并校验 draft `enabledModelIds`、annotation compatibility。审批快照变化会触发 immediate watch，跨页返回后可恢复 autosave。新增 Store/helper/Electron E2E 覆盖未保存审批草稿与禁用已保存 approver model。
- **M2 已解决**：删除当前 approver Provider 时只选择兼容的 fallback model；若已配置审批 route 且 fallback 没有兼容模型，整笔删除原子拒绝，不再写入普通 approval 保存入口无法创建的无效 route。新增 `reasoning: off + off-only model` 负向测试，并验证 Provider 与 approval 配置保持不变。
- **最终门禁通过**：`npm run verify` 全绿；Vitest 133 个文件通过、1 个跳过，916 项通过、2 项跳过；Playwright 35 项通过、1 项 Windows-only 跳过；lint、格式、类型检查、runtime smoke、应用/headless 构建和 Windows x64 打包均通过。

修复后判断：**本报告的合并前功能问题已经闭环；剩余 Low 是共享 policy 和大文件拆分的架构债务，不阻塞本功能。** Approval 独立配置 reasoning 属于下一步产品/架构变更，未混入本次缺陷修复。

## 1. 原始结论（修复前）

**代码质量已从“存在明显阻断问题”提升到“整体良好、接近可合并”，但建议先收口 2 个 Medium 再合并。**

上一轮的 High finding 已完全修复，另外一个 Low finding 也已闭环。后端现在能够原子拒绝缺失 Provider、空模型、已禁用模型和 reasoning 不兼容模型；Composer facade、Provider draft 冲突提示、审批设置错误态和测试覆盖都有明显提升。

本轮仍确认 4 个问题：

| 级别 | 数量 | 摘要 |
| --- | ---: | --- |
| Blocker / High | 0 | 未发现新的合并阻断、权限扩大或数据损坏问题 |
| Medium | 2 | Provider 预检查没有使用完整的已保存审批 route；删除审批 Provider 时仍可能持久化无效回退 route |
| Low | 2 | `off → high` 审批规则跨四层重复；ConfigStore 测试文件已增长到 1,285 行 |

两个 Medium 都不会错误自动批准：运行时仍会保守退回人工审批，或配置保存会被后端拒绝。因此它们不是安全漏洞；但它们会让“自动审批已配置”和“Provider 自动保存”的用户承诺变得不可靠，属于合并前应修复的配置一致性问题。

## 2. 审查范围与方法

本次复审覆盖：

- `master` 到当前工作树的全部代码、测试、SQL、样式和文档变更。
- 本轮 15 个未提交整改文件的逐行复核。
- 上一版 1 High、2 Medium、1 Low 的逐项回归检查。
- Provider draft、已保存审批配置、模型启用池、模型 annotation、ConfigStore validator 和运行时 route resolver 的状态转换。
- 删除 Provider、修改 Provider 默认档位、禁用审批模型、未保存审批表单等边界。
- facade 的运行时 property/action 转发契约。
- SQLite v6、六档 reasoning、Headless、Subagent、Provider adapter 和安全降级链路的既有实现。

执行结果：

- `git diff --check`：通过。
- `git diff --check fa63b05`：通过。
- `npm run verify`：通过。
  - ESLint、public API comment 检查、Prettier：通过。
  - Vitest：133 个文件通过、1 个跳过；913 项测试通过、2 项跳过。
  - Vue、Node、Runtime typecheck：通过。
  - PTY、ripgrep、开发 Node/Electron SQLite smoke：通过。
  - Renderer、Electron、Headless 构建：通过。
  - Windows x64 打包：通过。
  - Packaged SQLite probe：因 macOS 主机无法运行 Windows 目标，按设计跳过。
  - Playwright：35 项通过、1 项 Windows 专属用例跳过。

没有运行需要真实凭据和付费 Provider 的 `test:real`。

## 3. 本轮整改评价

### 3.1 已完全修复：Composer facade

`composerReasoningValid` 已加入 `runtimeProperties`。新增 facade contract test 不再只检查 Settings action，而是枚举 Runtime/Settings Store 的可消费成员，并使用显式 internal allowlist 约束不应暴露的成员。

新的 Electron E2E 通过真实 facade 覆盖：

- 合法档位不显示错误态。
- 从未标注模型切回受限模型时，保留的非法档位显示错误态。
- 手动选择受支持档位后错误态恢复。

上一版 High H1 已闭环。

### 3.2 已显著加强：审批 route 后端不变量

ConfigStore 新增统一的 `assertApprovalRouteConfigValid()`，能够验证：

- Provider 必须存在。
- model 必须非空。
- model 必须仍在 `enabledModelIds`。
- model annotation 必须支持实际审批档位。

保存 approval 时直接调用 validator；Provider 更新前记录原 route 是否结构上可用，若更新会破坏一个原本可用的审批 route，则整笔原子拒绝。新增测试覆盖缺失 Provider、空模型、禁用模型、annotation 冲突和 Provider 更新禁用当前 approver model。

这一后端边界是可靠的，也是当前没有安全扩大风险的关键原因。

### 3.3 已完全修复：集合顺序稳定性

`providerFormSignature()` 现在同样调用 `normalizeReasoningEfforts()`。相同集合的不同数组顺序不会再制造伪 dirty，也不会触发多余 autosave。测试已使用乱序数组验证等价 signature。

上一版 Low L1 已闭环。

### 3.4 已改善但未完全闭环：Provider 页审批冲突预检查

`providerDraftConflicts()` 和对应本地化提示已覆盖“修改非主审批模型 annotation”以及“Provider 默认档位使审批模型不兼容”。E2E 也验证了冲突时暂停 autosave、修复 annotation 后恢复保存。

问题在于前端实现的输入并不等价于后端验证的已持久化 route，详见 M1。

## 4. Findings

### Medium M1：Provider autosave 预检查使用审批表单草稿，并遗漏模型启用状态

**位置**

- `src/components/settings/ProviderSettingsPanel.vue:101-120,187-219`
- `src/stores/provider-form.ts:66-99`
- `src/stores/agent-settings.ts:159-165,310-311,381-384`
- `src/components/settings/SettingsPage.vue:30-39`
- `electron/config/store.ts:93-141,143-158,242-250`

**机制一：注释声称读取“已保存 route”，实际读取可变表单**

Provider 页把以下值传给 `providerDraftConflicts()`：

```ts
approval: {
  providerId: agent.approvalForm.providerId,
  model: agent.approvalForm.model,
}
```

但是 `approvalForm` 是 Permissions 页可直接修改的表单草稿。Store 只额外保存了一个拼接后的 `approvalSavedSignature`，没有保存可供业务判断使用的 persisted approval object。

Settings 各面板由 `v-if/else-if` 切换。Permissions 面板卸载时既不保存也不重置审批草稿，因此以下路径稳定可达：

1. 已保存审批 route 为 Provider P / Model A。
2. 在 Permissions 页把表单改成 Provider Q / Model B，但不点击保存。
3. 切换到 Provider 页。
4. Provider 页把 Q/B 当作“已保存 route”。

由此产生两种错误：

- 编辑 P 并破坏真实已保存的 P/A 时，前端漏掉冲突，autosave 仍发给后端，最终收到通用失败。
- 编辑 Q 并与未保存的 Q/B 冲突时，前端错误暂停 autosave，即使后端真实配置 P/A 完全不受影响。

**机制二：前端 helper 不接受 `enabledModelIds`**

`providerDraftConflicts()` 只接收 model id 和 `reasoningEfforts`，没有接收 Provider draft 的启用模型集合。因此：

1. 已保存审批 route 使用 Provider P / Model B。
2. 在 Provider 页的模型穿梭框中禁用 B，同时保留兼容的主模型 A。
3. B 仍存在于 `modelProfiles`，其 annotation 也仍兼容。
4. `draftConflicts.approval` 返回 false，autosave 正常触发。
5. ConfigStore 正确拒绝更新，因为 B 已不在 `enabledModelIds`。

前端再次退化成通用保存错误和 dirty draft，正是本轮预检查试图消除的体验。

**附带状态问题**

watch source 只包含 Provider form 和 model profiles，不包含 persisted approval route；watch 也不是 immediate。若用户离开 Provider 页到 Permissions 页修复冲突，再返回 Provider 页，已存在的 dirty Provider draft 不保证立即恢复 autosave，除非另一个 Provider source 随后发生变化或再次离开页面。

**影响**

- 不会越权；后端 validator 会拒绝破坏有效 route 的更新。
- 用户仍可能看到通用英文后端错误，而不是字段级提示。
- 未保存的审批草稿会影响另一个设置页，造成错误暂停。
- Provider draft 可能长期保持 dirty，用户难以判断哪一个页面的状态才是真实配置。

**建议**

1. 在 Settings Store 中保留结构化的 persisted approval snapshot，不要用 mutable `approvalForm` 代表已保存 route。
2. 让 Provider 页的预检查接受完整 Provider draft：`providerId`、`reasoning`、`enabledModelIds`、`modelOverrides/profiles`，并接受 persisted approval snapshot。
3. 抽取一个 process-neutral compatibility helper，前后端共享 provider 存在、非空、启用状态和 reasoning 支持规则。
4. 对 persisted approval snapshot 的变化建立明确的 watch/immediate 行为。
5. 增加三条测试：未保存审批草稿、禁用当前 approver model、跨页修复后恢复 autosave。

### Medium M2：删除 approver Provider 时，无兼容回退模型仍会持久化无效 route

**位置**

- `electron/config/store.ts:57-90,577-614`
- `electron/config/store.test.ts:944-993`
- `electron/providers/model-route-resolver.ts:100-132`

**机制**

删除当前 approver Provider 后，代码选择：

```ts
firstApprovalCompatibleModel(fallback) ?? fallback.model
```

已有测试覆盖“第一个 enabled model 不兼容、但后面存在兼容模型”的情况；这个路径已修复。缺失的是“一个兼容模型都不存在”的情况。

该状态并非无效 Provider 配置，以下配置完全可以合法保存：

- fallback Provider 的默认 reasoning 为 `off`。
- fallback 主模型已启用，annotation 只支持 `off`。
- ConfigStore 的主模型不变量通过，因为主 route 确实使用 `off`。
- 自动审批有明确安全提升，实际档位为 `high`。
- fallback Provider 没有任何支持 `high` 的 enabled model。

此时 `firstApprovalCompatibleModel()` 返回 `undefined`，代码又退回 `fallback.model`，把只支持 `off` 的模型写成实际需要 `high` 的审批模型。这个状态如果通过普通 `kind: 'approval'` 保存，会被同一个 ConfigStore 的 validator 拒绝；Provider 删除路径却绕过了该不变量并直接落盘。

**影响**

- 设置文件包含无法通过正常审批保存入口创建的无效 route。
- 后续 Run 在 route resolver 中捕获不兼容错误，静默退回人工审批。
- Permissions 页会显示冲突；若该 Provider 确实没有兼容模型，用户只能先修改 Provider 或切换审批 Provider。
- 安全上是保守降级，不会发生错误自动批准。

**建议**

删除路径在选择 fallback 后必须显式处理“没有兼容模型”：

- 优先选择另一个存在兼容模型的 Provider；或
- 保留 Provider 删除但把 approval 明确重置为未配置状态；或
- 原子拒绝删除并提示用户先选择新的审批 route。

无论产品选择哪种语义，都应在写盘前调用统一 validator 或显式验证重置状态，并增加 `reasoning: off + off-only main model` 的负向测试。

### Low L1：审批 reasoning policy 在四层重复，已经出现规则漂移

**位置**

- `electron/config/store.ts:74-141`
- `electron/providers/model-route-resolver.ts:106-115`
- `src/stores/agent-settings.ts:260-276`
- `src/stores/provider-form.ts:74-99`
- 可复用位置：`shared/model-settings.ts`

`off → high`、未标注模型视为全档支持、annotation 子集判断目前分别在 ConfigStore、route resolver、Settings getter 和 Provider draft helper 中实现。

这些实现语义相近但输入范围不同：后端 validator 检查 Provider/空值/启用池/annotation；Provider draft helper 只检查 annotation；Settings getter 又通过 `resolveSupportedReasoningEfforts()` 实现另一份逻辑。本报告 M1 正是这种漂移的直接结果。

建议在 `shared/model-settings.ts` 提供最小、无框架依赖的函数，例如：

- `effectiveApprovalReasoning(providerReasoning)`
- `modelSupportsReasoning(override, effort)`
- `evaluateApprovalRoute(provider, model)`，返回结构化 reason code

Renderer 可以把 reason code 映射成本地化提示，Electron 可以把同一结果映射成错误。ConfigStore 仍保留最终强制边界，但不应重新定义规则。

### Low L2：ConfigStore 测试文件已明显超过仓库建议上限

**位置**

- `electron/config/store.test.ts`：当前 1,285 行；`master` 为 883 行，本分支增加约 403 行。
- `src/stores/agent-settings.ts`：当前 1,169 行；`master` 已为 1,114 行，本分支继续增加状态和逻辑。

仓库约定要求代码和测试文件在实际可行时保持在 1,000 行以内。ConfigStore 测试已由本功能直接推过该阈值，且 reasoning/approval 用例天然可以独立成领域测试文件。

这不影响当前正确性，但会增加：

- 查找 fixture 和理解测试前置状态的成本。
- 不同配置领域修改同一大文件的冲突概率。
- 审批不变量遗漏边界时的发现难度。

建议至少把 Provider/approval/reasoning 场景提取到独立的 `store.provider-routing.test.ts` 或类似文件。`agent-settings.ts` 的拆分是既有债务，可在后续按 Provider、approval、limits 等 action domain 渐进处理，不必阻塞本功能。

## 5. 上一版 Findings 整改矩阵

| 上一版 | 状态 | 本次复核 |
| --- | --- | --- |
| High H1：`composerReasoningValid` 未接 facade | 已解决 | property 已接入；Runtime/Settings facade contract test 和真实 Composer E2E 均已补齐 |
| Medium M1：approver 冲突落入通用 autosave 失败 | 部分解决 | annotation/default reasoning 冲突已有字段提示和 E2E；未保存 approval draft、disabled approver model 仍见本报告 M1 |
| Medium M2：审批 route 允许缺失/禁用/删除回退失效 | 大部分解决 | approval 保存和 Provider 更新已有完整后端 validator；删除时不存在兼容 fallback model 仍见本报告 M2 |
| Low L1：dirty signature 对 effort 顺序敏感 | 已解决 | signature 使用规范化顺序，乱序等价测试已补齐 |

再向前追溯，首版报告中的 SQLite v6、annotation facade action、Composer send guard、窗口溢出、downgrade 文档、历史 migration schema 冻结和 Headless/Subagent 持久化等问题，本轮没有发现回归。

## 6. 测试与门禁评价

### 覆盖较好的部分

- facade runtime/settings property 和 Settings action 的运行时转发契约。
- Composer 合法、非法和恢复合法的真实 facade UI 状态。
- approval 保存时的缺失 Provider、空模型、禁用模型、reasoning 冲突。
- Provider 更新禁用已保存 approver model 的原子拒绝。
- Provider 删除时从多个模型中选择第一个兼容模型。
- Provider draft 修改非主 approver annotation 时暂停并恢复 autosave。
- 六档 reasoning 的共享契约、SQLite v6、Provider 请求、Headless 和 Subagent。
- 安全基线、IPC、凭据 safeStorage、CSP 和 renderer 隔离。

### 仍缺失的关键覆盖

| 缺口 | 为什么现有门禁未发现 |
| --- | --- |
| 未保存 approval form 污染 Provider 预检查 | E2E 通过 IPC seed 后 reload，确保 form 与 persisted route 相同，没有跨 Permissions/Provider 制造 dirty form |
| Provider draft 禁用当前 approver model | ConfigStore 单测只证明后端拒绝；Provider helper 测试没有 enabled model 输入 |
| 删除后不存在任何兼容 fallback model | 当前删除测试总是提供第二个兼容模型 |
| 跨页修复后自动恢复 autosave | E2E 在同一 Provider 页内修改 annotation 恢复，没有经过面板卸载和重新挂载 |
| Composer “错误态时 Send 禁用”真实 DOM | E2E 注释声称 Send blocked，但只断言 select error class；Runtime 单测覆盖了 `canSend`，真实 DOM 断言仍可补强 |

完整门禁全绿说明已有契约、构建、打包和主路径稳定，但不等于跨页面 draft/persisted 状态转换已穷尽。当前剩余问题都位于这些状态组合中。

## 7. 安全与架构复核

本轮没有发现新的凭据泄露、Renderer 越权、IPC sender/path guard 绕过、日志泄密、SQL 数据损坏或审批权限扩大：

- route 的 enabled/reasoning 检查仍发生在读取 Provider secret 之前。
- ConfigStore 更新使用 clone、校验、原子写入；校验失败不会更新内存配置或磁盘。
- Provider API key 仍由 SecretStore 管理，PublicConfig 只暴露配置状态。
- 自动审批 route 解析失败时明确不创建 model approver，继续走人工审批。
- SQLite migration 仍在提交前执行外键完整性检查。

因此 M1/M2 的风险定性为可用性和配置一致性，而不是安全边界突破。

架构上最值得保留的部分是：

- process-neutral schema 和 reasoning enum 位于 `shared/`。
- Renderer、Electron 和持久化层边界清楚。
- ConfigStore 作为最终配置不变量边界的方向正确。
- Runtime route resolver 仍有独立安全兜底。

最需要继续收口的是：把 process-neutral 的审批 compatibility policy 也移到 `shared/`，避免不同层根据各自局部状态重新解释同一规则。

## 8. 建议修复顺序

1. **修 M2 的持久化不变量**：Provider 删除后没有兼容模型时，不允许写入无效 approval route，并补负向测试。
2. **修 M1 的状态来源**：新增结构化 persisted approval snapshot，Provider 预检查不再读取 mutable approval form。
3. **让前端预检查与后端等价**：纳入 enabled model membership，并处理跨页恢复 autosave。
4. **抽共享 policy helper**：统一 `off → high` 和 annotation compatibility，减少四份实现。
5. **拆分 ConfigStore 测试文件**：在不改变行为的前提下降低维护成本。

## 9. 最终判断：代码质量如何

综合评价为：**整体良好，测试和安全边界较强，核心设计可保留；审批配置状态模型仍有局部不一致，当前版本接近但尚未完全达到可放心合并的程度。**

具体来说：

- **正确性：良好。** 六档 reasoning、annotation、持久化和 Provider 请求主链路完整；剩余问题集中在审批配置的少数跨页/删除边界。
- **安全性：良好。** 未发现权限扩大；所有已知不兼容情况最终都保守拒绝或回退人工审批。
- **测试质量：较强。** 完整门禁覆盖广，本轮测试数量和真实 Electron E2E 均有增强；但新增测试主要验证 happy/单冲突路径，组合状态仍有缺口。
- **可维护性：中上。** 类型、注释、命名和原子更新清晰；共享 policy 不足与超长测试文件是主要债务。
- **合并建议：暂缓。** 修复 M1/M2 后，本分支可以进入可合并状态；两个 Low 可随本轮低成本收口，也可建立明确后续任务。

## 10. 2026-08-05 实现补充

本节记录 review 之后的修复，不改写上文在当时快照下的判断：

- M1/M2 已闭环：Provider 预检查读取独立的 persisted approval snapshot；模型被禁用、annotation 冲突和跨页恢复均有前端状态与测试；删除 approver Provider 时若不存在兼容 fallback model 会原子拒绝。
- Auto approval 现在显式保存独立的 `reasoning`。运行时不再从 Provider 默认等级推导，也删除了 `off → high` 隐式提升；v9–v16→v17 迁移会把旧版实际等级写成可见配置，从而保持升级行为但消除隐藏规则。v16 仍由 model-pool foundation 的冻结结构唯一占用。
- `shared/model-route.ts` 新增窄范围、process-neutral 的静态兼容性校验，统一 Provider 存在性、模型启用池和 reasoning annotation 判断。Renderer、ConfigStore、fallback 与 runtime 共用该规则；凭据、Endpoint 与实时可用性没有被错误下沉到 shared。
- 回归覆盖新增了显式审批等级、Provider 默认等级与审批等级互不影响、`off` 原样下发、v15 迁移、fallback 选择及共享 helper 的正负路径。

本轮最终 `npm run verify` 完整通过：lint、公共 API 注释、格式、三套 TypeScript 检查、runtime smoke、Renderer/Electron/Headless 构建、Windows NSIS 打包与安全基线均成功；Vitest 为 926 passed / 2 skipped，Electron E2E 为 35 passed / 1 个 Windows 专属用例 skipped。此前两次全量运行分别遇到不相关的 DNS 与进程 spawn 时序波动，对应用例隔离复跑均通过，最终完整门禁无失败。因此上文的“暂缓”条件已经解除；ConfigStore 测试拆分仍属于非阻塞维护债务。

## 11. 2026-08-06 架构收口补充

- Renderer 的 approval 表单、persisted snapshot、dirty/saving/status、hydration 与保存 IPC 已从 `agent-settings.ts` 拆到独立 `approval-settings.ts`；Agent facade 保持页面 API 不变，并负责把 Provider 启用模型投影与 Approval store 组合起来。
- 初始化、局部 AppConfig 更新、Provider 删除 fallback 和全局错误提示均显式同步 Approval store，避免拆分后出现只更新 Provider store 的陈旧审批快照。
- 新增独立 store 测试，覆盖切换 Provider 时保留 reasoning、saved/draft 隔离，以及 `off` 等级不经转换原样写入 `config:set(approval)`；facade contract 也纳入新 store。
- 当前 reasoning/approval 分支已按依赖方向 rebase 到 `feat/model-pool-foundation`：保留 v16 的三档 Provider/pool 冻结 schema，新增保留并规范化 pool 的 v16→v17 组合迁移；v17 model pool 复用统一六档 reasoning schema，并通过共享兼容性规则拒绝或禁用 annotation 冲突项。
- 拆分后的 `npm run verify` 完整通过：Vitest 928 passed / 2 skipped，Electron E2E 35 passed / 1 个 Windows 专属用例 skipped；lint、公共 API 注释、格式、三套 TypeScript 检查、runtime smoke、Renderer/Electron/Headless 构建和 Windows NSIS 打包均成功。
