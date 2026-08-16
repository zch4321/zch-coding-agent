# Code Review：模型角色、自动标题与对话头部

## 修复复审结论（2026-08-16）

原始审查中的功能性与测试问题已经完成修复，当前没有已知的合并阻塞项：

- Findings 1–2、4–13 已修复，并补充了对应的 backend、store、迁移或 Playwright 回归覆盖。
- Finding 3 按产品决策调整为宽松偏好语义：全局默认模型允许因目录或标注变化而失效；新对话不会隐式迁移到其他模型，而是把 Provider/模型选择置空、禁用发送且不创建 Run，等待用户显式重新选择。已有 Session 的冻结 route 不受影响。
- Finding 14 不做本次拆分。`ProviderSettingsPanel` 保持现有组件边界；该项属于维护性建议，不影响本次功能正确性。迁移文件同样保持按 schema 演进集中组织，后续仅在确有独立边界时再拆分。

本轮修复还统一迁移了 v21 E2E helper 与断言、恢复了权限默认模式持久化和串行追写、让 Composer 凭据校验跟随当前 route，并使自动标题使用完成 Run 的冻结主 route 回退且可在退出时立即取消。

## 修复状态

| Finding | 状态 | 修复或处理 |
| --- | --- | --- |
| 1 | 已修复 | 标题 metadata 写回改为不推进会话历史 revision，避免与 Run durable binding 竞争。 |
| 2 | 已修复 | E2E 全面迁移到 AppConfig v21 `models` 结构与 `kind: 'models'`，保存状态使用唯一 test id。 |
| 3 | 按决策处理 | 无效默认偏好在新对话中投影为空 route，并禁用发送；不自动修复或影响已有会话。 |
| 4–5 | 已修复 | 默认权限模式进入配置 autosave；保存中继续编辑会串行追写最新快照，不再被旧响应覆盖。 |
| 6 | 已修复 | 标题优先尝试 auxiliary，失败后回退完成 Run 的冻结主 route，并保留内部诊断。 |
| 7 | 已修复 | fake-provider backend 测试默认关闭自动标题，避免意外访问真实 Provider。 |
| 8 | 已修复 | 标题服务跟踪并取消活动请求；即使 Provider 忽略 signal，dispose 也不会等待到超时。 |
| 9 | 已修复 | Composer 提示与 `canSend` 都按当前 Composer Provider 的凭据状态判断。 |
| 10 | 已修复 | auxiliary 角色变化纳入 Provider autosave watcher，单独解除冲突即可恢复保存。 |
| 11 | 已修复 | 增加冻结的真实 v20 fixture，覆盖模型角色、凭据引用、模型池、Shell 与损坏输入。 |
| 12 | 已修复 | Token 单位提升边界改为 9,950 与 999,500，并补齐边界测试。 |
| 13 | 已修复 | 当前 schema、模型池路径和 auxiliary/Auto Approval 术语统一为 v21 语义。 |
| 14 | 接受现状 | 按产品决策不拆分 `ProviderSettingsPanel`；不作为合并阻塞项。 |

## 修复后验证

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run format` | 通过 | 任务文件均符合当前 Prettier 规则。 |
| `npm run check` | 通过 | Format、Lint、Typecheck 与全部确定性 Vitest 并行通过。 |
| `npm run build:app` | 通过 | Renderer、Main 与 Preload 构建通过；仅保留既有的大 chunk warning。 |
| `npx playwright test e2e/settings.spec.ts` | 通过 | 完整设置工作流通过，包括角色、Provider autosave 与冲突恢复。 |
| `npx playwright test e2e/security-baseline.spec.ts --grep "serves config"` | 通过 | AppConfig v21 公共投影断言通过。 |
| `npx playwright test e2e/features.plan.spec.ts --grep "starts a reviewed"` | 通过 | 公共配置 helper 与审批 Run setup 通过。 |

本轮没有运行 `npm run verify`；该命令保留给合并/发布门禁。本报告涉及的确定性检查、应用构建和针对性 Playwright 回归均已通过。

## 原始结论（修复前）

当前 `feat/model-roles-config` **不建议合并**。本次审查确认 **14 项问题：P0 0 项、P1 5 项、P2 6 项、P3 3 项**。

最需要先处理的是：

1. 自动标题写回会在 SQLite 中单独推进 Session revision，却不刷新 live durable binding；标题成功后，当前或下一次 Run 可能因 revision conflict 失败。
2. AppConfig v21 的 Playwright 迁移不完整；公共 E2E setup 仍发送已经删除的 `kind: 'approval'`，`npm run verify` 确定无法通过。
3. 权限页的“默认模式”不再持久化，权限自动保存还会在请求期间静默丢失用户的新编辑。
4. 全局默认模型角色没有被当作完整配置不变量保护；通过正常 UI 即可删除、停用或改坏它，使新对话无法发送。

`npm run check` 已通过，说明 lint、格式、TypeScript 和现有 Vitest 都没有发现这些组合问题；但最小 Playwright 验证已复现 v21 断言失败和公共 setup 的审批请求失败。因此当前门禁结果不能支持合并。

## 审查范围

- 审查日期：2026-08-16
- 当前分支：`feat/model-roles-config`
- HEAD：`a081d50da4ec51ce399805d4c2252b244f6db2b0`
- 对比基线：`master` / merge-base `2c4716df0ca6ca7fbcfddda8dbf0a4c018fce615`
- 提交范围：
  - `56a8bd2 feat: compact conversation header usage display`
  - `8684280 feat: generate conversation titles with a light pool model`
  - `a081d50 feat: unify model roles for default, auxiliary, and approval routing`
- 变更规模：94 个文件，3,365 行新增，2,140 行删除
- 重点范围：AppConfig v21 与迁移、模型角色与 Provider 不变量、Auto approval 路由、自动标题生命周期与持久化、权限/Provider 自动保存、Composer route、对话头部用量、IPC、Vitest、Playwright 与架构文档

严重级别：

- **P1**：应在合并前修复；会破坏核心会话、持久化正确性、用户配置，或使完整门禁确定失败。
- **P2**：应在合并前尽量修复；会在合法配置、后台失败或退出流程中造成明显错误、错误数据边界或不稳定行为。
- **P3**：非阻塞正确性问题，但应在本分支收尾或登记后续任务。

## Findings

### 1. [P1] 自动标题写回使 live durable revision 失同步

**位置**：

- `electron/application/session-service.ts:484-533`
- `electron/application/live-session-context-registry.ts:375-381`
- `electron/application/durable-execution-state-port.ts:252-268`
- `electron/session/session-run-controller.ts:710-723`

**原因**：`SessionService.update()` 在 metadata commit 后会调用 `runtimeGuard.applySessionRecord()`，同时刷新 SessionManager 和 `DurableExecutionStatePort`。新增的 `applyModelTitle()` 却只调用 `commitMutation()`，成功后直接返回；数据库 revision 已加一，但已加载 Session 的 durable binding 仍保留旧 revision。

标题服务又在 `run.status = completed` 事件一发布就开始异步请求。该事件先于 `run.end`、`afterRun()` 和 Active Run 最终清理，因此用户可以在标题请求仍在进行时启动第二轮。

**可复现场景**：

1. 新 Session 首轮完成，durable binding 假设停在 revision N。
2. 标题请求返回，`applyModelTitle()` 将数据库推进到 N+1，但 binding 仍是 N。
3. 若第二轮尚未启动，它的首个 `run_input` commit 使用 expected revision N，失败一次；恢复逻辑重载 N+1 后，用户重试才成功。
4. 若第二轮已经提交 `run_input`，标题可能插入第二轮后续 assistant/tool commit 之间，使正在运行的 Run 中途失败。

**影响**：自动起名这个后台增强功能会破坏主会话写入路径。输入在 Renderer 中通常会保留，但用户会看到一次无意义的 Run failure；更差的交错会直接终止已经开始的第二轮。

**建议**：

- 不要仅以公开 `run.status` 事件作为“Session 已完全 idle”的边界；标题调度应等待对应 Run fully settled。
- 标题 metadata commit 必须走 idle/lifecycle 协调，并在成功后原子地刷新 live Session 与 durable binding，或在第二轮已开始时安全跳过/延后。
- 保留 revision/title source 竞争校验，确保并发用户重命名永远优先。
- 增加“标题成功后立刻续聊”“标题返回时第二轮已运行”“标题与用户重命名并发”的 backend 集成测试，而不是只 mock `SessionService.applyModelTitle()`。

### 2. [P1] AppConfig v21 的 E2E setup 与断言仍停留在 v20

**位置**：

- `e2e/support/app-helpers.ts:64-70,114-127,205-230`
- `e2e/security-baseline.spec.ts:55-77`
- `e2e/settings.spec.ts:346-373,449-456,499-507,864-893`
- `e2e/settings.spec.ts:730-747,971-1013`

**问题一：公共 setup 已不可用。** `configureApp()` 仍发送被 v21 删除的：

```ts
{ kind: 'approval', approverProviderId, approverModel, reasoning }
```

该 helper 被 plan、chat-tools、prompt-context、agents、concurrency、compaction、terminal、MCP 等大量规格共用。IPC schema 会拒绝请求，helper 随即在 `step: 'approval'` 失败，后续业务断言完全不会运行。Swarm setup 还继续读取 `provider.value.config.providers`，而新路径是 `config.models.providers`。

**问题二：设置与安全规格仍读旧路径。** 多处读取 `config.providers`、`config.modelPool`，安全基线仍断言 `schemaVersion: 20`、`activeProviderId` 和根级模型池。

**问题三：Provider 保存状态 locator 已失去唯一性。** 模型角色区新增第二个 `.settings-save-status` 后，设置测试仍在整个 section 上使用宽泛 locator。正向断言可能因多元素失败；负向断言可能只观察空的角色状态，无法证明 Provider autosave 确实暂停。

**运行确认**：

- `npx playwright test e2e/security-baseline.spec.ts --grep "serves config"`：失败，实际返回 v21，测试仍期待 v20。
- `npx playwright test e2e/features.plan.spec.ts --grep "starts a reviewed"`：失败于 `configureApp()` 的 `step: "approval"`，IPC 明确拒绝旧 request。

**建议**：整体迁移 E2E helper 与局部类型到 `config.models.*` 和 `kind: 'models'`；角色与 Provider 状态分别增加稳定的 `data-testid` 或精确容器 locator。修复后应跑完整 Playwright，而不是只补单个新增 UI 测试。

### 3. [P1] 正常 Provider 操作可以破坏全局默认模型角色

**位置**：

- `electron/config/store.ts:136-207,317-323,801-824`
- `src/components/settings/ProviderSettingsPanel.vue:128-143,296-307,344-355`
- `src/stores/agent-settings.ts:244-256`
- `src/stores/agent-runtime.ts:173-230`

**原因**：

- `assertModelRolesConfigValid()` 对 auxiliary role 使用完整 `evaluateModelRouteCompatibility()`，但对 default role 只检查 Provider 存在和模型仍 enabled，没有检查 Provider 默认 reasoning 是否被该模型标注支持。
- Provider 更新只在“此前 auxiliary 可用且本次更新的是 auxiliary Provider”时重新校验角色；default role 从不参与 Provider draft conflict 或 backend postcondition。
- `provider-model-delete` 只阻止删除 auxiliary model；底层删除只保护 Provider 自身的 `provider.model`。UI 的删除按钮与 Transfer 也只保护 Provider 默认模型和 auxiliary model。
- 默认角色下拉直接列出所有 enabled 模型，不区分 reasoning compatibility。

**稳定复现**：Provider 默认模型为 A，启用 A/B，把全局默认角色设为 B，auxiliary 留空。随后可以：

- 从 Transfer 停用 B；
- 直接删除 B；
- 把 B 的 reasoning annotation 改为不支持 Provider 默认档位。

这些操作可以成功落盘，而 `models.defaultModel` 仍指向 B。新对话继续取 B，但 Composer options 已不包含它，或 reasoning 校验失败，发送被禁用，直到用户手工修复角色。

**建议**：把“default/auxiliary role 都必须完整 resolve”做成单一 backend 不变量，在角色写入、Provider 更新、模型启停、annotation 修改、模型删除和 Provider 删除之后统一校验。删除/停用时要么拒绝，要么在同一事务中明确迁移 default role。Renderer 预检查只能改善体验，不能替代 backend 约束。

**测试缺口**：新增 `provider.model=A/defaultModel=B/auxiliary=''` 的删除、停用、reasoning annotation 和 Provider update 回归；同时验证失败不写盘、Provider revision 不漂移、模型池修复仍保持原子性。

### 4. [P1] 权限页的“默认模式”不再写入全局配置

**位置**：

- `src/components/settings/PermissionsSettingsPanel.vue:32-48,60-95`
- `src/App.vue:130-145`
- `src/stores/agent-runtime.ts:591-613`
- `src/stores/agent-settings.ts:1116-1148`

权限页 watcher 和 dirty 状态只观察 `permissionForm` 中的敏感数据字段。模式下拉只 emit 到 `App.selectMode()`，最终调用 runtime `setMode()`：有选中 Session 时更新该 Session；没有 Session 时只改进程内 draft mode。两条路径都不会调用 `config:set(permission)` 更新 `config.permission.defaultMode`。

立即保存按钮又只在 `permissionsDirty` 为 true 时可用。因此单独选择 Auto/Confirm/Yolo 后，页面没有自动保存，也无法手工保存；重启后或新建后续对话仍使用旧默认值。有选中 Session 时，一个标为“默认模式”的控件实际上修改的是当前 Session。

**建议**：设置页应绑定独立的 `settings.defaultMode` 草稿，把它纳入 permission snapshot/dirty/autosave；当前 Session mode 若也需要改变，应作为明确的单独行为或文案说明，不能混成一个字段。补充 reload 后创建新 Session 的 UI/store 回归。

### 5. [P1] 权限 autosave 会用旧响应覆盖保存期间的新编辑

**位置**：

- `src/components/settings/PermissionsSettingsPanel.vue:24-49`
- `src/stores/agent-settings.ts:290-291,395-405,1116-1158`

`savePermissions()` 在 `permissionsSaving` 为 true 时直接返回。请求成功后又无条件 `applyConfig(result.config, ['permission'])`，把整个表单、默认模式、remembered rules 和 saved signature 回填成请求快照。

**复现时序**：

1. 编辑 A，600 ms 后请求 A 发出。
2. 请求返回前继续编辑 B，watcher 安排第二次保存。
3. 第二个 timer 若先触发，会因 `permissionsSaving` 被丢弃；若旧请求先返回，`applyConfig(A)` 会覆盖 B，watcher 又会清掉 timer。
4. 最终 UI 和磁盘都停在 A，B 静默消失。删除 remembered rule 与字段编辑交错时也存在同类覆盖。

**建议**：复用 Provider/Limits 的 snapshot-signature 串行追写模式。每个请求冻结完整 permission draft；响应只有在当前草稿仍等于发送快照时才能回填，否则立即保存最新快照。default mode、builtin policies、remembered rules 和 sensitive data 必须处于同一个签名与原子写入边界。

### 6. [P2] 自动标题未按契约从失效 auxiliary 回退到该 Run 的主 route

**位置**：

- `docs/requirements.md:444`
- `electron/application/conversation-titling-service.ts:43-58,176-208`
- `electron/providers/model-route-resolver.ts:168-191`

需求明确规定：辅助模型“未配置或解析失败时”为**该 Run 的主模型 route**。Auto approval 的 `resolveRunRoutes()` 已实现 try auxiliary / catch fallback；标题服务却先做一次：

```ts
const selection = getAuxiliaryModelSelection(config) ?? record.modelSelection
```

只要 auxiliary 字段非空，凭据缺失、模型被禁用或 endpoint/route 解析失败都会在外层 `.catch(() => undefined)` 被吞掉，标题直接放弃，不再尝试 main route。

此外，auxiliary 未配置时使用的是 Session selection + 当前可变 Config 重新解析，而不是刚完成 Run 的冻结 route。Provider 在 Run 中途被编辑、换 endpoint 或删除凭据时，标题调用的实际数据边界可能与该 Run 不一致。

**建议**：独立尝试 auxiliary，失败后明确回退；main fallback 应从 backend-private completed Run context 获取冻结 route/binding，不能事后从当前 Config 重建。不要把 fallback 失败与 auxiliary 失败合并为一个无诊断的 `undefined`。补充“辅助凭据缺失”“辅助模型被停用”“Run 中途修改 Provider”的测试。

### 7. [P2] fake-provider Vitest 会绕过测试 Provider 向真实 endpoint 发标题请求

**位置**：

- `electron/application/create-backend-runtime.ts:277-286`
- `electron/application/conversation-titling-service.ts:125-137`
- `electron/application/durable-backend-runtime.test.ts:29-40`
- `electron/application/durable-concurrency-recovery.test.ts:22-33`
- `electron/application/durable-file-change-runtime.test.ts:28-39`
- `electron/subagent/subagent-runtime.test.ts:243-255,510-516`

`CreateBackendRuntimeOptions.providerFactory` 只控制主 Run。标题服务默认始终调用 `createConfiguredProvider()`；多个 backend test helper 没有设置 `conversationTitlingDisabled`。只要测试完成一个 auto-titled 普通 Session，标题服务就会携带 `test-key` / `secret-sentinel` 和测试对话正文请求配置里的真实 DeepSeek endpoint。

这让 deterministic Vitest 依赖外网和第三方响应速度，还可能把测试 workspace 文本发送到真实服务。E2E 已显式设置禁用环境变量，但 Vitest helper 没有同样的隔离。

**建议**：所有 fake-provider backend helper 默认 `conversationTitlingDisabled: true`。另保留一个显式启用、同时注入 fake titling provider/fetch 的集成测试；测试中应断言全局网络未被调用。

### 8. [P2] 退出时不会取消进行中的标题请求

**位置**：

- `electron/application/conversation-titling-service.ts:110-113,147-156,219-286`
- `electron/application/create-backend-runtime.ts:351-371`
- `electron/disposer.ts:24,71-106`

`dispose()` 只取消事件订阅并等待 `#inFlight`，但请求用的 `AbortController` 是 `#requestTitle()` 的局部变量，service 无法 abort。卡住的 Provider stream 只能等 15 秒标题 timeout；Desktop disposer 的总 deadline 是 5 秒。

因此 app quit 时 backend dispose 可能先被顶层 deadline 截断，`runtime/coordinator/database` 等后续 cleanup 没有机会执行。即使进程最终退出，这也破坏了当前按顺序关闭 durable 资源的保证。

**建议**：跟踪活动 controller，`dispose()` 先 abort 全部请求再 settle；同时确保 provider stream 不响应 signal 时仍有 bounded race。增加 stalled provider 的 dispose 测试，断言请求被 abort 且 database cleanup 能继续。

### 9. [P2] Composer 的 API Key 提示读取全局默认 Provider，而非当前 route

**位置**：

- `src/components/chat/MessageComposer.vue:84-129`
- `src/stores/agent-settings.ts:187-215`
- `src/stores/agent-runtime.ts:173-230,629-646`

现在 Composer 切换 Provider 只更新当前 Session 或 draft route，不再改变全局默认角色。但 `sendHint` 仍读取 `agent.credentialConfigured`，该 getter 固定查询 `defaultModelProvider`。

因此：

- 默认 A 有凭据、当前 Session 切到无凭据的 B：输入框仍显示正常提示，Run 到 backend 才失败。
- 默认 A 无凭据、当前 B 有凭据：输入框错误提示用户先配置 API Key。

**建议**：增加按 `composerProviderId` 计算的 credential getter，Composer 的提示、可发送预检查和 Provider notice 语义都应基于同一当前 route。补充 A/B 凭据状态相反的 store/component 测试。

### 10. [P2] 通过切换 auxiliary 解除 Provider 冲突后，autosave 不会恢复

**位置**：

- `src/components/settings/ProviderSettingsPanel.vue:123-143,372-415`

`autosaveConflict` 依赖 auxiliary provider/model，但 autosave watcher 的 source 只包含 `providerForm` 和 `modelProfiles`。Provider draft 与当前 auxiliary 冲突时 callback 会清 timer 并暂停；用户按提示改选一个兼容 auxiliary 后，conflict 虽变为 false，watcher source 却没有变化，所以不会重新排程保存。

页面会一直保留 dirty Provider draft，直到用户再改一次 Provider 字段或离开页面触发 flush。这与 600 ms autosave 承诺不符，也容易让用户误以为角色调整已经一起保存了 Provider 草稿。

**建议**：把 auxiliary role 或 `autosaveConflict` 的 true→false 转换纳入 watcher；增加“只通过切换 auxiliary role 解除冲突”的组件/E2E 回归。

### 11. [P2] 最新生产升级边界 v20→v21 实际没有测试

**位置**：

- `electron/config/migrations.test.ts:567-597`
- `electron/config/migrations.ts:879-895,1073-1080`

名为“accepts and clones a valid v20 config”的测试直接 clone 当前 `DEFAULT_APP_CONFIG`；它已经是 schema v21。所谓“malformed v20”也从 v21 shape 删除 `models`，因此只测试当前 schema 拒绝必填字段，完全没有进入 `migrateV20()`。

v20 是当前最新升级来源，也是本分支改动最大的真实迁移边界。现有测试虽然覆盖 v9-v19 的多条路径，却没有验证 v20 的根级 `activeProviderId/providers/approval/modelPool/executionEnvironment` 被正确收拢到 `models`。

**建议**：新增冻结的真实 v20 fixture，覆盖有效迁移、独立 approval reasoning 丢弃的明确语义、Provider credential reference、model pool、command shell 和 malformed 拒绝；不要从 current default 反向猜旧 shape。

### 12. [P3] 紧凑 Token 格式在单位边界产生 `10.0k` 与 `1000k`

**位置**：

- `src/components/chat/usage-format.ts:5-18`
- `src/components/chat/usage-format.test.ts:4-19`

bucket 在舍入前选择：`9_950` 会落入一位小数分支并显示 `10.0k`，`999_500` 会落入 k 分支并显示 `1000k`；相邻区间却分别使用 `10k` 和 `1.0M`。现有测试特意停在 `9_949`，没有覆盖跨单位舍入。

**建议**：先计算 rounded value，再决定是否提升单位，或调整 bucket 边界；补充 9,949/9,950/999,499/999,500/1,000,000 的 table test。

### 13. [P3] 架构与需求文档仍混用 v20 根级结构和旧 Auto Approval 术语

**位置**：

- `docs/architecture.md:602-608,1788`
- `docs/requirements.md:313-320,628-635`

文档后部已经说明 v21 使用 `models.modelPool`，但模型池章节仍写“当前 v20”与根级 `modelPool`。术语表仍把 Auto Approval 定义为“独立小模型”，与新决策中的“auxiliary，否则当前 Run 主模型”不一致。`architecture.md:1788` 还保留“v9-v16 迁移显式化旧审批等级”的陈述，而 v21 migration 已丢弃独立审批 reasoning。

**建议**：把 schema 历史与当前结构分开写：v16 首次引入根字段是历史事实，当前落点必须明确为 `models.modelPool`；统一 Auto Approval、auxiliary 和迁移行为的术语。

### 14. [P3] 本分支把两个生产文件推过 1,000 行指导线

**位置**：

- `src/components/settings/ProviderSettingsPanel.vue`：1,054 行（基线约 967）
- `electron/config/migrations.ts`：1,111 行（基线约 930）

Provider 面板现在同时承担默认/辅助角色、Provider CRUD、凭据、目录刷新、手工模型、启用 Transfer、模型 annotation、autosave 与冲突恢复；本次多个状态错配都发生在这些相互耦合的 watcher/computed 中。迁移文件则继续累积每代 frozen schema 与转换函数。

**建议**：至少拆出 `ModelRolesSettings` 与 Provider model catalog/config 子组件，并把 frozen migration schema 按版本段分模块。测试大文件可以另行整理，但生产组件越线已经开始直接增加状态遗漏风险。

## 原始验证结果（修复前）

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run check` | 通过 | Format 5.2s、Lint 9.4s、Typecheck 12.7s、Vitest 43.2s |
| `npm run build:app` | 通过 | Renderer/Main/Preload 构建成功；仅有既有的大 chunk warning |
| `npx playwright test e2e/security-baseline.spec.ts --grep "serves config"` | 失败 | 测试仍期待 schema v20 与根级字段 |
| `npx playwright test e2e/features.plan.spec.ts --grep "starts a reviewed"` | 失败 | 公共 setup 的 `kind: 'approval'` 被 v21 IPC schema 拒绝 |

没有运行完整 `npm run verify`：上述两个最小 Playwright 已证明完整门禁必然失败，继续执行打包与剩余 E2E 不会提供额外诊断价值。

## 审查中确认正确或已排除的部分

- AppConfig v21 的共享/特权 schema、PublicConfig 投影与 IPC boundary 采用同一 `models` 结构；未发现凭据字段泄漏到 Renderer。
- Auto approval 的 resolver 已正确实现 auxiliary 解析失败后回退当前 Run 主模型；问题只在标题服务没有复用同样语义。
- SQLite 0009、Session codec/repository 与 `title_source = auto|user|model` 的升级默认值符合“旧 Session 不自动起名”的要求。
- 标题输入/输出有长度上限，输出会清洗，hidden Subagent Session 通过公开 Session repository 查询边界被排除。
- 模型角色保存失败并非完全静默：`AppMessageBridge.vue:115-120` 直接监听 `useModelRolesStore().error` 并转成 Naive UI message，因此没有把“角色错误未弹出”列为 finding；面板内联状态仍可改进，但不是独立正确性缺陷。
- 紧凑用量展示继续使用最新 main usage 计算上下文占用，并保留 Provider/fallback source 的精确 tooltip；除单位边界外未发现口径回归。

## 原始建议修复顺序（修复前）

1. 修复标题写回的 lifecycle/revision 串行化，并添加跨 Run 集成测试。
2. 修复 default model role backend 不变量，以及权限 default mode/autosave 数据丢失。
3. 整体迁移 E2E setup、v21 断言与 locator，恢复 `npm run verify`。
4. 补标题 auxiliary fallback、测试网络隔离和 dispose abort。
5. 修 Composer credential 与 Provider autosave 恢复。
6. 补真实 v20 fixture；最后处理格式边界、文档与文件拆分。

完成 1–3 后再重新评估合并；当前没有证据支持直接合并。
